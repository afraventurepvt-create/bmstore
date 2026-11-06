import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { TenantResolver } from '../src/tenancy/tenant-resolver.service';
import { createApp, deleteTenants, makeTenant, uniq } from './helpers';

describe('tenant resolution middleware', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let redis: RedisService;
  let resolver: TenantResolver;
  const created: string[] = [];

  beforeAll(async () => {
    app = await createApp();
    db = app.get(PrismaService).base;
    redis = app.get(RedisService);
    resolver = app.get(TenantResolver);
    await redis.client.flushdb();
  });
  afterAll(async () => {
    await deleteTenants(db, created);
    await app.close();
  });

  const get = (host: string) => request(app.getHttpServer()).get('/health').set('Host', host);

  it('resolves storename.localhost (dev) and injects the tenant into the request context', async () => {
    const t = await makeTenant(db);
    created.push(t.id);
    const res = await get(`${t.subdomain}.localhost:3000`).expect(200);
    expect(res.body.tenant).toBe(t.slug);
  });

  it('resolves by custom_domain', async () => {
    const domain = `${uniq('shop')}.example.com`;
    const t = await makeTenant(db, { customDomain: domain });
    created.push(t.id);
    const res = await get(domain).expect(200);
    expect(res.body.tenant).toBe(t.slug);
  });

  it('is case-insensitive on Host', async () => {
    const t = await makeTenant(db);
    created.push(t.id);
    await get(`${t.subdomain.toUpperCase()}.LOCALHOST`).expect(200);
  });

  it('returns 404 for unknown stores and unknown custom domains', async () => {
    await get(`${uniq('nope')}.localhost`).expect(404);
    await get(`${uniq('nope')}.example.org`).expect(404);
  });

  it('rejects nested labels (a.b.localhost) as unknown', async () => {
    const t = await makeTenant(db);
    created.push(t.id);
    await get(`x.${t.subdomain}.localhost`).expect(404);
  });

  it('treats root, admin/api/www subdomains and IPs as platform hosts (no tenant)', async () => {
    for (const h of ['localhost', 'admin.localhost', 'api.localhost', 'www.localhost', '127.0.0.1:3000']) {
      const res = await get(h).expect(200);
      expect(res.body.tenant).toBeNull();
    }
  });

  it('blocks suspended and expired stores with 403', async () => {
    const s = await makeTenant(db, { status: 'suspended' });
    const e = await makeTenant(db, { expiresAt: new Date(Date.now() - 1000) });
    created.push(s.id, e.id);
    await get(`${s.subdomain}.localhost`).expect(403);
    await get(`${e.subdomain}.localhost`).expect(403);
  });

  it('caches in Redis with a 5 minute TTL and serves from cache', async () => {
    const t = await makeTenant(db);
    created.push(t.id);
    const host = `${t.subdomain}.localhost`;
    await get(host).expect(200);
    const key = resolver.cacheKey(host);
    const ttl = await redis.client.ttl(key);
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);

    // Mutate DB behind the cache's back: cached value wins until invalidated.
    await db.tenant.update({ where: { id: t.id }, data: { status: 'suspended' } });
    await get(host).expect(200);
    await resolver.invalidate({ subdomain: t.subdomain });
    await get(host).expect(403);
  });

  it('never caches secret columns', async () => {
    const t = await makeTenant(db, { razorpayKeyEnc: 'v1:SECRETCIPHER', razorpaySecretEnc: 'v1:SECRETCIPHER2' });
    created.push(t.id);
    const host = `${t.subdomain}.localhost`;
    await get(host).expect(200);
    const raw = (await redis.client.get(resolver.cacheKey(host))) ?? '';
    expect(raw).not.toMatch(/SECRETCIPHER|razorpay/i);
  });

  it('negatively caches unknown hosts briefly, and a newly created tenant is reachable after invalidate', async () => {
    const sub = uniq('late');
    await get(`${sub}.localhost`).expect(404);
    const ttl = await redis.client.ttl(resolver.cacheKey(`${sub}.localhost`));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    const t = await db.tenant.create({ data: { name: 'Late', slug: sub, subdomain: sub } });
    created.push(t.id);
    await resolver.invalidate({ subdomain: sub });
    await get(`${sub}.localhost`).expect(200);
  });

  it('falls back to the database when Redis is unavailable', async () => {
    const t = await makeTenant(db);
    created.push(t.id);
    const spy = jest.spyOn(redis.client, 'get').mockRejectedValue(new Error('down'));
    await get(`${t.subdomain}.localhost`).expect(200);
    spy.mockRestore();
  });
});
