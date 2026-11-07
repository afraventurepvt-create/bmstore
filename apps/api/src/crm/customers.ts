import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsArray, IsEmail, IsOptional, IsString, MaxLength, MinLength, ArrayMaxSize } from 'class-validator';
import { Roles } from '../auth/decorators';
import { ListQuery, listPage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

export class UpdateCustomerDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
  /** [{ label, line1, line2, city, state, pincode }] */
  @IsOptional() @IsArray() @ArrayMaxSize(10) addresses?: Record<string, string>[];
}

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}
  private get db() { return this.prisma.db; }

  list(q: ListQuery) {
    const where: Prisma.CustomerWhereInput = q.q
      ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q } }, { email: { contains: q.q, mode: 'insensitive' } }] }
      : {};
    return listPage(q, async (skip, take) => {
      const items = await this.db.customer.findMany({ where, orderBy: { name: 'asc' }, skip, take, include: { _count: { select: { orders: true } } } });
      const totals = items.length
        ? await this.db.order.groupBy({ by: ['customerId'], where: { customerId: { in: items.map((c) => c.id) }, orderStatus: { notIn: ['CANCELLED', 'RETURNED'] } }, _sum: { total: true }, _max: { createdAt: true } })
        : [];
      const byId = new Map(totals.map((t) => [t.customerId, t]));
      return [
        items.map(({ _count, ...c }) => ({ ...c, orderCount: _count.orders, spentPaise: byId.get(c.id)?._sum.total ?? 0, lastOrderAt: byId.get(c.id)?._max.createdAt ?? null })),
        await this.db.customer.count({ where }),
      ];
    });
  }

  async get(id: string) {
    const c = await this.db.customer.findUnique({ where: { id }, include: { orders: { orderBy: { createdAt: 'desc' }, take: 20 } } });
    if (!c) throw new NotFoundException('Customer not found');
    const spent = await this.db.order.aggregate({ _sum: { total: true }, _count: true, where: { customerId: id, orderStatus: { notIn: ['CANCELLED', 'RETURNED'] } } });
    return { ...c, orderCount: spent._count, spentPaise: spent._sum.total ?? 0 };
  }

  async update(id: string, dto: UpdateCustomerDto) {
    await this.get(id);
    return this.db.customer.update({ where: { id }, data: { ...dto, ...(dto.email !== undefined ? { email: dto.email ? dto.email.toLowerCase() : null } : {}), ...(dto.addresses ? { addresses: dto.addresses as Prisma.InputJsonValue } : {}) } });
  }
}

@Roles('store_owner', 'staff')
@Controller('store/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}
  @Get() list(@Query() q: ListQuery) { return this.customers.list(q); }
  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string) { return this.customers.get(id); }
  @Patch(':id') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) { return this.customers.update(id, dto); }
}

@Module({ controllers: [CustomersController], providers: [CustomersService] })
export class CustomersModule {}
