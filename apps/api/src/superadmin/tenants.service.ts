import { ConflictException, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, TenantPlan, TenantStatus } from '@prisma/client';
import { AppConfig } from '../config/app-config';
import { AuthService } from '../auth/auth.service';
import { AuthActor } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import { CreateTenantDto, ListTenantsQuery } from './tenants.dto';

/** Never return razorpay_* columns, not even encrypted. */
export function presentTenant(t: any) {
  const { razorpayKeyEnc, razorpaySecretEnc, ...rest } = t;
  return { ...rest, razorpayConfigured: Boolean(razorpayKeyEnc && razorpaySecretEnc) };
}

@Injectable()
export class SuperadminTenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly resolver: TenantResolver,
    private readonly cfg: AppConfig,
  ) {}

  /** Semantic audit row (in addition to the per-query rows the bypass writes). Never put secrets in `meta`. */
  private async record(actor: AuthActor, action: string, tenantId: string | null, meta: Record<string, unknown>) {
    await this.prisma.base.auditLog.create({ data: { actorId: actor.id, action, tenantId, meta: meta as Prisma.InputJsonValue } });
  }

  async create(actor: AuthActor, dto: CreateTenantDto) {
    if (this.cfg.reservedSubdomains.has(dto.subdomain)) throw new BadRequestException('Reserved subdomain');
    if (dto.customDomain && (dto.customDomain === this.cfg.rootDomain || dto.customDomain.endsWith('.' + this.cfg.rootDomain))) {
      throw new BadRequestException('customDomain must not be under the platform domain');
    }
    const passwordHash = await this.auth.hashPassword(dto.owner.password);
    try {
      const tenant = await this.prisma.asSuperadmin(actor, 'superadmin:create-tenant', () =>
        this.prisma.db.$transaction(async (tx: any) => {
          const t = await tx.tenant.create({
            data: {
              name: dto.name,
              slug: dto.slug,
              subdomain: dto.subdomain,
              customDomain: dto.customDomain ?? null,
              plan: dto.plan ?? 'STARTER',
              gstNumber: dto.gstNumber,
              address: dto.address,
              supportPhone: dto.supportPhone,
              whatsappNumber: dto.whatsappNumber,
              expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
            },
          });
          await tx.settings.create({ data: { tenantId: t.id } });
          await tx.themeConfig.create({ data: { tenantId: t.id } });
          await tx.user.create({
            data: { tenantId: t.id, email: dto.owner.email.trim().toLowerCase(), phone: dto.owner.phone, passwordHash, role: 'store_owner' },
          });
          return t;
        }),
      );
      await this.resolver.invalidate(tenant); // clears any negative cache entry for the new host
      await this.record(actor, 'tenant.created', tenant.id, { slug: tenant.slug, subdomain: tenant.subdomain });
      return presentTenant(tenant);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Already in use: ${String((e.meta as any)?.target ?? 'unique field')}`);
      }
      throw e;
    }
  }

  async list(actor: AuthActor, q: ListTenantsQuery) {
    const where: Prisma.TenantWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.expired ? { expiresAt: { lte: new Date() } } : {}),
      ...(q.q
        ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { slug: { contains: q.q, mode: 'insensitive' } }, { subdomain: { contains: q.q, mode: 'insensitive' } }] }
        : {}),
    };
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const [items, total] = await this.prisma.asSuperadmin(actor, 'superadmin:list-tenants', async () => [
      await this.prisma.db.tenant.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      await this.prisma.db.tenant.count({ where }),
    ]);
    return { items: items.map(presentTenant), total, page, pageSize };
  }

  async get(actor: AuthActor, id: string) {
    const t = await this.prisma.asSuperadmin(actor, 'superadmin:get-tenant', () => this.prisma.db.tenant.findUnique({ where: { id } }));
    if (!t) throw new NotFoundException('Tenant not found');
    return presentTenant(t);
  }

  setStatus(actor: AuthActor, id: string, status: TenantStatus, reason?: string) {
    const action = status === 'SUSPENDED' ? 'tenant.suspended' : status === 'LIVE' ? 'tenant.unsuspended' : 'tenant.status_set';
    return this.mutate(actor, id, { status }, action, reason, { status });
  }

  /** Plan changes never delete data: a STANDARD -> STARTER downgrade keeps existing products but blocks new ones past the cap. */
  setPlan(actor: AuthActor, id: string, plan: TenantPlan, reason?: string) {
    return this.mutate(actor, id, { plan }, 'tenant.plan_set', reason, { plan });
  }

  setExpiry(actor: AuthActor, id: string, expiresAt: string | null, reason?: string) {
    return this.mutate(actor, id, { expiresAt: expiresAt ? new Date(expiresAt) : null }, 'tenant.expiry_set', reason, { expiresAt });
  }

  private async mutate(actor: AuthActor, id: string, data: Prisma.TenantUpdateInput, action: string, reason?: string, extra: object = {}) {
    const updated = await this.prisma.asSuperadmin(actor, `superadmin:${action}`, async () => {
      const before = await this.prisma.db.tenant.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Tenant not found');
      const after = await this.prisma.db.tenant.update({ where: { id }, data });
      return { before, after };
    });
    // Takes effect immediately: drop cached host entries instead of waiting out the 5 min TTL.
    await this.resolver.invalidate(updated.before, updated.after);
    await this.record(actor, action, id, { reason: reason ?? null, ...extra });
    return presentTenant(updated.after);
  }
}
