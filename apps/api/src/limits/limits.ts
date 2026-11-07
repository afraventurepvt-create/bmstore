import { Controller, ForbiddenException, Get, Injectable, Module } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import { RequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { PLAN_LIMITS } from '../tenancy/plans';

export const MB = 1024 * 1024;
const HELP = 'Contact support on WhatsApp to raise it.';

export interface Usage {
  plan: string;
  products: { used: number; limit: number; live: number; liveLimit: number | null };
  media: { usedBytes: number; limitBytes: number; usedMb: number; limitMb: number };
}

/**
 * Fair-use limits per tenant (tenants.max_products, tenants.max_media_mb; defaults 2,000 and 10 GB; superadmin
 * can change them). Counters live in tenant_usage, maintained by database triggers, so a check is one row read.
 */
@Injectable()
export class TenantLimitsService {
  constructor(private readonly prisma: PrismaService) {}
  private get db() { return this.prisma.db; }

  async usage(): Promise<Usage> {
    const tenantId = RequestContext.tenantId()!;
    const t = await this.db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { plan: true, maxProducts: true, maxMediaMb: true } });
    const u = await this.db.tenantUsage.findUnique({ where: { tenantId } });
    const live = await this.db.product.count({ where: { status: { not: 'ARCHIVED' } } });
    const usedBytes = Number(u?.mediaBytes ?? 0n);
    return {
      plan: t.plan,
      products: { used: u?.productCount ?? 0, limit: t.maxProducts, live, liveLimit: PLAN_LIMITS[t.plan].maxProducts },
      media: { usedBytes, limitBytes: t.maxMediaMb * MB, usedMb: Math.round((usedBytes / MB) * 10) / 10, limitMb: t.maxMediaMb },
    };
  }

  /** Room for `n` more product rows (any status). */
  async assertProductRoom(n: number): Promise<void> {
    if (n <= 0) return;
    const u = await this.usage();
    if (u.products.used + n > u.products.limit) {
      throw new ForbiddenException(`This store has reached its limit of ${u.products.limit.toLocaleString('en-IN')} products (${u.products.used.toLocaleString('en-IN')} used). Delete products you no longer sell. ${HELP}`);
    }
  }
  /** How many more product rows fit. */
  async productRoom(): Promise<number> {
    const u = await this.usage();
    return Math.max(0, u.products.limit - u.products.used);
  }

  /** Media quota: incoming bytes on top of what is stored. */
  async assertRoom(_tenantId: string, incomingBytes: number): Promise<void> {
    const u = await this.usage();
    if (u.media.usedBytes + incomingBytes > u.media.limitBytes) {
      const gb = (u.media.limitMb / 1024).toFixed(u.media.limitMb % 1024 ? 1 : 0);
      throw new ForbiddenException(`Image storage is full (${u.media.usedMb.toLocaleString('en-IN')} MB of ${gb} GB used). Delete images you no longer need. ${HELP}`);
    }
  }
}

@Roles('store_owner', 'staff')
@Controller('store')
export class UsageController {
  constructor(private readonly limits: TenantLimitsService) {}
  /** What the store uses against its plan and fair-use limits. */
  @Get('usage') usage() { return this.limits.usage(); }
}

@Module({ controllers: [UsageController], providers: [TenantLimitsService], exports: [TenantLimitsService] })
export class LimitsModule {}
