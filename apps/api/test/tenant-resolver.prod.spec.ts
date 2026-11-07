import { TenantResolver } from '../src/tenancy/tenant-resolver.service';

describe('TenantResolver with ROOT_DOMAIN=bmstore.in (production host shape)', () => {
  const rows: Record<string, any> = {
    acme: { id: 't1', subdomain: 'acme', customDomain: null, status: 'active', expiresAt: null, slug: 'acme' },
    shop: { id: 't2', subdomain: 'shop', customDomain: 'www.shop-example.com', status: 'active', expiresAt: null, slug: 'shop' },
  };
  const cfg: any = { rootDomain: 'bmstore.in', reservedSubdomains: new Set(['www', 'admin', 'api']), tenantCacheTtl: 300, tenantNegativeCacheTtl: 60 };
  const prisma: any = {
    base: {
      tenant: {
        findFirst: async ({ where }: any) =>
          where.subdomain ? rows[where.subdomain] ?? null : Object.values(rows).find((r: any) => r.customDomain === where.customDomain) ?? null,
      },
    },
  };
  const store = new Map<string, string>();
  const redis: any = { get: async (k: string) => store.get(k) ?? null, setex: async (k: string, _t: number, v: string) => void store.set(k, v), del: async () => {} };
  const r = new TenantResolver(cfg, prisma, redis);

  it('acme.bmstore.in -> acme', async () => {
    expect(await r.resolve('acme.bmstore.in')).toMatchObject({ kind: 'tenant', tenant: { id: 't1' } });
  });
  it('custom domain', async () => {
    expect(await r.resolve('www.shop-example.com')).toMatchObject({ kind: 'tenant', tenant: { id: 't2' } });
  });
  it('apex and admin are platform; unknown subdomain unknown; localhost is not special in prod', async () => {
    expect((await r.resolve('bmstore.in')).kind).toBe('platform');
    expect((await r.resolve('admin.bmstore.in')).kind).toBe('platform');
    expect((await r.resolve('ghost.bmstore.in')).kind).toBe('unknown');
    expect((await r.resolve('acme.localhost')).kind).toBe('unknown');
  });
  it('host header tricks do not resolve a tenant', async () => {
    expect((await r.resolve('acme.bmstore.in.evil.com')).kind).toBe('unknown');
    expect((await r.resolve('evilbmstore.in')).kind).toBe('unknown');
  });
});
