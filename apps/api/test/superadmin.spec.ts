import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createApp, deleteTenants, uniq } from './helpers';

describe('superadmin API', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base: PrismaClient;
  let adminTok: string;
  let adminId: string;
  let superEmail: string;
  const PW = 'a-very-long-password';
  const created: string[] = [];
  const api = () => request(app.getHttpServer());
  const admin = (m: 'get' | 'post' | 'patch', path: string, tok = adminTok) =>
    api()[m](path).set('Host', 'admin.localhost').set('Authorization', `Bearer ${tok}`);

  const newTenant = (over: any = {}) => {
    const s = uniq('st');
    return { name: `Store ${s}`, slug: s, subdomain: s, owner: { email: `owner-${s}@test.local`, password: PW }, ...over };
  };

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    base = prisma.base;
    const auth = app.get(AuthService);
    superEmail = `root-${uniq()}@test.local`;
    const passwordHash = await auth.hashPassword(PW);
    const u = await prisma.asSystem('test', () => prisma.db.user.create({ data: { email: superEmail, passwordHash, role: 'superadmin' } }));
    adminId = (u as any).id;
    adminTok = (await api().post('/auth/login').set('Host', 'admin.localhost').send({ email: superEmail, password: PW }).expect(200)).body.accessToken;
  });
  afterAll(async () => {
    await deleteTenants(base, created);
    await base.user.deleteMany({ where: { email: superEmail } });
    await app.close();
  });

  it('is closed to anonymous, store owners and staff', async () => {
    await api().get('/superadmin/tenants').set('Host', 'admin.localhost').expect(401);
    const t = newTenant();
    const res = await admin('post', '/superadmin/tenants').send(t).expect(201);
    created.push(res.body.id);
    const owner = (await api().post('/auth/login').set('Host', `${t.subdomain}.localhost`).send(t.owner).expect(200)).body.accessToken;
    await api().get('/superadmin/tenants').set('Host', `${t.subdomain}.localhost`).set('Authorization', `Bearer ${owner}`).expect(403);
    await api().post('/superadmin/tenants').set('Host', `${t.subdomain}.localhost`).set('Authorization', `Bearer ${owner}`).send(newTenant()).expect(403);
  });

  describe('create', () => {
    it('creates tenant + settings + theme + owner; owner can log in right away; no razorpay fields leak', async () => {
      const t = newTenant({ gstNumber: '29ABCDE1234F1Z5', plan: 'STANDARD' });
      const res = await admin('post', '/superadmin/tenants').send(t).expect(201);
      created.push(res.body.id);
      expect(res.body).toMatchObject({ slug: t.slug, plan: 'STANDARD', status: 'BUILDING', razorpayConfigured: false });
      expect(JSON.stringify(res.body)).not.toMatch(/razorpayKeyEnc|razorpaySecretEnc|passwordHash/);
      expect(await base.settings.count({ where: { tenantId: res.body.id } })).toBe(1);
      expect(await base.themeConfig.count({ where: { tenantId: res.body.id } })).toBe(1);
      const owner = await base.user.findFirst({ where: { tenantId: res.body.id } });
      expect(owner).toMatchObject({ role: 'store_owner', email: t.owner.email });
      expect(owner!.passwordHash).not.toContain(PW);

      // new host works immediately (negative cache was invalidated)
      await api().get('/health').set('Host', `${t.subdomain}.localhost`).expect(200);
      await api().post('/auth/login').set('Host', `${t.subdomain}.localhost`).send(t.owner).expect(200);
    });

    it('duplicate subdomain returns 409 and persists nothing', async () => {
      const t = newTenant();
      const dupe = newTenant();
      const first = await admin('post', '/superadmin/tenants').send(dupe).expect(201);
      created.push(first.body.id);
      await admin('post', '/superadmin/tenants').send({ ...t, subdomain: dupe.subdomain }).expect(409);
      expect(await base.tenant.count({ where: { slug: t.slug } })).toBe(0);
    });

    it('validates input', async () => {
      await admin('post', '/superadmin/tenants').send(newTenant({ subdomain: 'Bad_Sub' })).expect(400);
      await admin('post', '/superadmin/tenants').send(newTenant({ subdomain: 'admin' })).expect(400);
      await admin('post', '/superadmin/tenants').send(newTenant({ customDomain: 'shop.localhost' })).expect(400);
      await admin('post', '/superadmin/tenants').send(newTenant({ owner: { email: 'a@b.co', password: 'short' } })).expect(400);
      await admin('post', '/superadmin/tenants').send(newTenant({ status: 'LIVE' })).expect(400); // not whitelisted
      await admin('post', '/superadmin/tenants').send(newTenant({ plan: 'pro' })).expect(400); // not in the enum
      await admin('post', '/superadmin/tenants').send({ name: 'x' }).expect(400);
    });
  });

  describe('list', () => {
    it('lists, filters and paginates', async () => {
      const a = newTenant({ name: 'Zebra Textiles ' + uniq() });
      const ra = await admin('post', '/superadmin/tenants').send(a).expect(201);
      created.push(ra.body.id);
      const r = await admin('get', `/superadmin/tenants?q=${encodeURIComponent(a.name)}`).expect(200);
      expect(r.body.total).toBe(1);
      expect(r.body.items[0].id).toBe(ra.body.id);
      expect(JSON.stringify(r.body)).not.toMatch(/razorpayKeyEnc|razorpaySecretEnc/);
      const page = await admin('get', '/superadmin/tenants?pageSize=1&page=1').expect(200);
      expect(page.body.items).toHaveLength(1);
      await admin('get', '/superadmin/tenants?pageSize=1000').expect(400);
      await admin('get', '/superadmin/tenants?status=bogus').expect(400);
    });
  });

  describe('suspend / unsuspend / expiry take effect immediately (cache invalidated)', () => {
    let t: any, id: string, host: string, ownerTok: string;
    beforeAll(async () => {
      t = newTenant();
      id = (await admin('post', '/superadmin/tenants').send(t).expect(201)).body.id;
      created.push(id);
      host = `${t.subdomain}.localhost`;
      ownerTok = (await api().post('/auth/login').set('Host', host).send(t.owner).expect(200)).body.accessToken; // warms the cache
    });

    it('suspend blocks the storefront and the store API at once; unsuspend restores', async () => {
      await api().get('/health').set('Host', host).expect(200);
      const s = await admin('post', `/superadmin/tenants/${id}/suspend`).send({ reason: 'non-payment' }).expect(200);
      expect(s.body.status).toBe('SUSPENDED');
      await api().get('/health').set('Host', host).expect(403);
      await api().get('/auth/me').set('Host', host).set('Authorization', `Bearer ${ownerTok}`).expect(403);
      await api().post('/auth/login').set('Host', host).send(t.owner).expect(403);
      const u = await admin('post', `/superadmin/tenants/${id}/unsuspend`).send({}).expect(200);
      expect(u.body.status).toBe('LIVE');
      await api().get('/health').set('Host', host).expect(200);
    });

    it('generic status endpoint: PARKED blocks, BUILDING serves (admins can work), bogus values rejected', async () => {
      const p = await admin('post', `/superadmin/tenants/${id}/status`).send({ status: 'PARKED', reason: 'churned' }).expect(200);
      expect(p.body.status).toBe('PARKED');
      expect((await api().get('/health').set('Host', host).expect(403)).body.message).toBe('Store parked');
      const b = await admin('post', `/superadmin/tenants/${id}/status`).send({ status: 'BUILDING' }).expect(200);
      expect(b.body.status).toBe('BUILDING');
      await api().get('/health').set('Host', host).expect(200);
      await api().get('/auth/me').set('Host', host).set('Authorization', `Bearer ${ownerTok}`).expect(200);
      await admin('post', `/superadmin/tenants/${id}/status`).send({ status: 'active' }).expect(400);
      await admin('post', `/superadmin/tenants/${id}/status`).send({}).expect(400);
      await admin('post', `/superadmin/tenants/${id}/status`).send({ status: 'LIVE' }).expect(200);
      const logs = await base.auditLog.findMany({ where: { actorId: adminId, tenantId: id, action: 'tenant.status_set' } });
      expect(logs.map((l) => (l.meta as any).status).sort()).toEqual(['BUILDING', 'PARKED']);
    });

    it('set expiry: past blocks, null clears, garbage rejected', async () => {
      await admin('patch', `/superadmin/tenants/${id}/expiry`).send({ expiresAt: new Date(Date.now() - 60_000).toISOString() }).expect(200);
      await api().get('/health').set('Host', host).expect(403);
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const r = await admin('patch', `/superadmin/tenants/${id}/expiry`).send({ expiresAt: future }).expect(200);
      expect(new Date(r.body.expiresAt).toISOString()).toBe(future);
      await api().get('/health').set('Host', host).expect(200);
      const n = await admin('patch', `/superadmin/tenants/${id}/expiry`).send({ expiresAt: null }).expect(200);
      expect(n.body.expiresAt).toBeNull();
      await admin('patch', `/superadmin/tenants/${id}/expiry`).send({ expiresAt: 'tomorrow-ish' }).expect(400);
      await admin('patch', `/superadmin/tenants/${id}/expiry`).send({}).expect(400);
    });

    it('404 for unknown ids and 400 for malformed ids', async () => {
      await admin('post', '/superadmin/tenants/00000000-0000-4000-8000-000000000000/suspend').send({}).expect(404);
      await admin('post', '/superadmin/tenants/not-a-uuid/suspend').send({}).expect(400);
    });

    it('writes semantic AND per-query audit rows attributed to the superadmin', async () => {
      const logs = await base.auditLog.findMany({ where: { actorId: adminId, tenantId: id }, orderBy: { createdAt: 'asc' } });
      const actions = logs.map((l) => l.action);
      expect(actions).toEqual(expect.arrayContaining(['tenant.suspended', 'tenant.unsuspended', 'tenant.status_set', 'tenant.expiry_set', 'db.Tenant.update']));
      const sus = logs.find((l) => l.action === 'tenant.suspended')!;
      expect((sus.meta as any).reason).toBe('non-payment');
      // per-query rows exist for the creation transaction too
      const createRows = await base.auditLog.findMany({ where: { actorId: adminId, action: { in: ['db.Tenant.create', 'db.User.create', 'db.Settings.create', 'db.ThemeConfig.create'] } } });
      expect(createRows.length).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(logs) + JSON.stringify(createRows)).not.toContain(PW);
      expect(JSON.stringify(createRows)).not.toMatch(/argon2id/);
    });
  });

  it('seed script creates an idempotent superadmin without printing the password', () => {
    const email = `seed-${uniq()}@test.local`;
    const env = { ...process.env, SUPERADMIN_EMAIL: email, SUPERADMIN_PASSWORD: 'seeded-password-123456' };
    const out1 = execSync('npx ts-node --transpile-only scripts/seed-superadmin.ts', { env, cwd: __dirname + '/..' }).toString();
    const out2 = execSync('npx ts-node --transpile-only scripts/seed-superadmin.ts', { env, cwd: __dirname + '/..' }).toString();
    expect(out1).toContain('created');
    expect(out2).toContain('already exists');
    expect(out1 + out2).not.toContain('seeded-password');
    return base.user.deleteMany({ where: { email } }).then((r) => expect(r.count).toBe(1));
  }, 90_000);
});
