import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentMode, PaymentStatus, Prisma } from '@prisma/client';
import { IsBoolean, IsDateString, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { RequestContext } from '../common/request-context';
import { ListQuery, listPage, ToBoolean } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { parseItems } from './order-items';

export class ListOrdersQuery extends ListQuery {
  @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
  @IsOptional() @IsEnum(PaymentStatus) paymentStatus?: PaymentStatus;
  @IsOptional() @IsEnum(PaymentMode) paymentMode?: PaymentMode;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  /** Orders that still need work: PENDING, CONFIRMED, PACKED */
  @IsOptional() @ToBoolean() @IsBoolean() open?: boolean;
}
export class SetOrderStatusDto {
  @IsEnum(OrderStatus) status!: OrderStatus;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class SetPaymentStatusDto {
  @IsEnum(PaymentStatus) status!: PaymentStatus;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

/** Allowed status moves. Terminal: DELIVERED (except to RETURNED), CANCELLED, RETURNED. */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PACKED', 'CANCELLED'],
  PACKED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'RETURNED'],
  DELIVERED: ['RETURNED'],
  CANCELLED: [],
  RETURNED: [],
};
export const OPEN_STATUSES: OrderStatus[] = ['PENDING', 'CONFIRMED', 'PACKED'];
/** Payment-status moves an admin may make by hand (ONLINE refunds themselves happen through the gateway later). */
const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING: ['PAID', 'FAILED'],
  PAID: ['REFUNDED', 'PARTIALLY_REFUNDED'],
  PARTIALLY_REFUNDED: ['REFUNDED'],
  FAILED: ['PAID'],
  REFUNDED: [],
};

const CUSTOMER = { select: { id: true, name: true, phone: true, email: true } } as const;

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}
  private get db() { return this.prisma.db; }

  list(q: ListOrdersQuery) {
    const where: Prisma.OrderWhereInput = {
      ...(q.status ? { orderStatus: q.status } : {}),
      ...(q.open ? { orderStatus: { in: OPEN_STATUSES } } : {}),
      ...(q.paymentStatus ? { paymentStatus: q.paymentStatus } : {}),
      ...(q.paymentMode ? { paymentMode: q.paymentMode } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
      ...(q.q
        ? { OR: [{ orderNo: { contains: q.q, mode: 'insensitive' } }, { customer: { phone: { contains: q.q } } }, { customer: { name: { contains: q.q, mode: 'insensitive' } } }] }
        : {}),
    };
    return listPage(q, async (skip, take) => [
      await this.db.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { customer: CUSTOMER } }),
      await this.db.order.count({ where }),
    ]);
  }

  async get(id: string) {
    const o = await this.db.order.findUnique({ where: { id }, include: { customer: true } });
    if (!o) throw new NotFoundException('Order not found');
    const history = await this.db.auditLog.findMany({ where: { action: { startsWith: 'order.' }, meta: { path: ['orderId'], equals: id } }, orderBy: { createdAt: 'asc' } });
    return { ...o, items: parseItems(o.items), history: history.map((h) => ({ at: h.createdAt, action: h.action, meta: h.meta })) };
  }

  async setStatus(id: string, dto: SetOrderStatusDto) {
    const o = await this.get(id);
    if (!ORDER_TRANSITIONS[o.orderStatus].includes(dto.status)) {
      const next = ORDER_TRANSITIONS[o.orderStatus];
      throw new BadRequestException(next.length ? `An order that is ${o.orderStatus} can only move to ${next.join(' or ')}` : `An order that is ${o.orderStatus} cannot be changed`);
    }
    const updated = await this.db.$transaction(async (tx: any) => {
      const r = await tx.order.updateMany({ where: { id, orderStatus: o.orderStatus }, data: { orderStatus: dto.status } });
      if (r.count !== 1) throw new BadRequestException('The order changed meanwhile, reload and try again');
      // Goods come back on cancel/return: restock what the storefront took out.
      if (dto.status === 'CANCELLED' || dto.status === 'RETURNED') {
        for (const it of o.items) {
          if (it.variantId) await tx.variant.updateMany({ where: { id: it.variantId }, data: { stock: { increment: it.qty } } });
          else if (it.productId) await tx.product.updateMany({ where: { id: it.productId }, data: { stock: { increment: it.qty } } });
        }
      }
      await tx.auditLog.create({ data: { actorId: RequestContext.get()?.actor?.id ?? null, action: 'order.status', meta: { orderId: id, from: o.orderStatus, to: dto.status, note: dto.note ?? null } } });
      return tx.order.findUnique({ where: { id }, include: { customer: true } });
    });
    return { ...updated, items: parseItems(updated.items) };
  }

  async setPaymentStatus(id: string, dto: SetPaymentStatusDto) {
    const o = await this.get(id);
    if (!PAYMENT_TRANSITIONS[o.paymentStatus].includes(dto.status)) {
      throw new BadRequestException(`Payment that is ${o.paymentStatus} cannot be marked ${dto.status}`);
    }
    const updated = await this.db.$transaction(async (tx: any) => {
      const r = await tx.order.updateMany({ where: { id, paymentStatus: o.paymentStatus }, data: { paymentStatus: dto.status } });
      if (r.count !== 1) throw new BadRequestException('The order changed meanwhile, reload and try again');
      await tx.auditLog.create({ data: { actorId: RequestContext.get()?.actor?.id ?? null, action: 'order.payment', meta: { orderId: id, from: o.paymentStatus, to: dto.status, note: dto.note ?? null } } });
      return tx.order.findUnique({ where: { id }, include: { customer: true } });
    });
    return { ...updated, items: parseItems(updated.items) };
  }

  /** One tap for the common case: cash collected on a COD order. */
  async markCodPaid(id: string) {
    const o = await this.get(id);
    if (o.paymentMode !== 'COD') throw new BadRequestException('Only cash-on-delivery orders can be marked paid by hand');
    return this.setPaymentStatus(id, { status: 'PAID', note: 'Cash collected' });
  }

  /** Dashboard numbers for "today" in the store's timezone (IST). */
  async dashboard() {
    const now = new Date();
    const ist = new Date(now.getTime() + 330 * 60_000);
    const startIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000;
    const start = new Date(startIst);
    const settings = await this.db.settings.findUnique({ where: { tenantId: RequestContext.tenantId()! } });
    const [todayOrders, todaySales, toPack, lowStock, openOrders, pendingCod] = await Promise.all([
      this.db.order.count({ where: { createdAt: { gte: start }, orderStatus: { not: 'CANCELLED' } } }),
      this.db.order.aggregate({ _sum: { total: true }, where: { createdAt: { gte: start }, orderStatus: { not: 'CANCELLED' } } }),
      this.db.order.count({ where: { orderStatus: { in: ['PENDING', 'CONFIRMED'] } } }),
      this.db.product.count({ where: { status: 'ACTIVE', stock: { lte: settings?.lowStockThreshold ?? 5 } } }),
      this.db.order.count({ where: { orderStatus: { in: OPEN_STATUSES } } }),
      this.db.order.count({ where: { paymentMode: 'COD', paymentStatus: 'PENDING', orderStatus: 'DELIVERED' } }),
    ]);
    return {
      today: { orders: todayOrders, salesPaise: todaySales._sum.total ?? 0, since: start.toISOString() },
      toPack,
      openOrders,
      lowStock,
      codToCollect: pendingCod,
    };
  }
}
