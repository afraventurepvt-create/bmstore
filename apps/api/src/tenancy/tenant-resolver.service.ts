import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { TenantInfo } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export type Resolution =
  | { kind: 'platform' } // root domain / admin / api hosts: no tenant
  | { kind: 'tenant'; tenant: TenantInfo }
  | { kind: 'unknown' };

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const NONE = '__none__';

/** Columns that are safe to cache/expose. NEVER add razorpay_* here. */
export const TENANT_PUBLIC_SELECT = {
  id: true,
  name: true,
  slug: true,
  subdomain: true,
  customDomain: true,
  plan: true,
  status: true,
  gstNumber: true,
  address: true,
  supportPhone: true,
  whatsappNumber: true,
  expiresAt: true,
} as const;

@Injectable()
export class TenantResolver {
  constructor(
    private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  static normalizeHost(raw: string | undefined): string {
    if (!raw) return '';
    let h = raw.trim().toLowerCase();
    if (h.startsWith('[')) return h; // IPv6 literal: treated as platform
    h = h.replace(/:\d+$/, '').replace(/\.$/, '');
    return h;
  }

  cacheKey(host: string) {
    return `tenant:host:${host}`;
  }

  async resolve(rawHost: string | undefined): Promise<Resolution> {
    const host = TenantResolver.normalizeHost(rawHost);
    if (!host || host.startsWith('[') || IPV4.test(host) || host === this.cfg.rootDomain) {
      return { kind: 'platform' };
    }

    const root = this.cfg.rootDomain;
    let subdomain: string | null = null;
    if (host.endsWith('.' + root)) {
      const sub = host.slice(0, -(root.length + 1));
      if (this.cfg.reservedSubdomains.has(sub)) return { kind: 'platform' };
      if (!LABEL.test(sub)) return { kind: 'unknown' }; // nested labels (a.b.root) or junk
      subdomain = sub;
    }

    const key = this.cacheKey(host);
    const cached = await this.redis.get(key);
    if (cached !== null) {
      if (cached === NONE) return { kind: 'unknown' };
      try {
        return { kind: 'tenant', tenant: JSON.parse(cached) as TenantInfo };
      } catch {
        /* corrupt entry: fall through to DB */
      }
    }

    const row = await this.prisma.base.tenant.findFirst({
      where: subdomain ? { subdomain } : { customDomain: host },
      select: TENANT_PUBLIC_SELECT,
    });
    if (!row) {
      await this.redis.setex(key, this.cfg.tenantNegativeCacheTtl, NONE);
      return { kind: 'unknown' };
    }
    const tenant: TenantInfo = { ...row, expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null };
    await this.redis.setex(key, this.cfg.tenantCacheTtl, JSON.stringify(tenant));
    return { kind: 'tenant', tenant };
  }

  /** Drop cached entries for a tenant's hostnames. Pass old AND new values when they change. */
  async invalidate(...t: Array<{ subdomain?: string | null; customDomain?: string | null }>) {
    const keys = new Set<string>();
    for (const x of t) {
      if (x.subdomain) keys.add(this.cacheKey(`${x.subdomain}.${this.cfg.rootDomain}`));
      if (x.customDomain) keys.add(this.cacheKey(x.customDomain.toLowerCase()));
    }
    await this.redis.del(...keys);
  }
}
