/** Fair-use limits: products (rows) and media bytes per tenant, trigger-maintained counters, usage endpoint, superadmin edits. */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { MediaWorker } from '../src/media/media-worker';
import { PrismaService } from '../src/prisma/prisma.service';
import { createApp, deleteTenants, makeTenant, uniq } from './helpers';

describe('fair-use limits', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base: PrismaClient;
  let A: any, tok: string, adminTok: string, superEmail: string, adminId: string;
  const PW = 'correct-horse-battery';
  const api = () => request(app.getHttpServer());
  const host = (t: any) => `${t.subdomain}.localhost`;
  const me = () => ({
    get: (p: string) => api().get(p).set('Host', host(A)).set('Authorization', `Bearer ${tok}`),
    post: (p: string, b?: any) => api().post(p).set('Host', host(A)).set('Authorization', `Bearer ${tok}`).send(b),
    del: (p: string) => api().delete(p).set('Host', host(A)).set('Authorization', `Bearer ${tok}`),
  });
  const admin = (m: 'patch' | 'get', p: string) => api()[m](p).set('Host', 'admin.localhost').set('Authorization', `Bearer ${adminTok}`);
  const usage = async () => (await me().get('/store/usage').expect(200)).body;
  const counters = () => base.tenantUsage.findUniqueOrThrow({ where: { tenantId: A.id } });

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    base = prisma.base;
    A = await makeTenant(base, { plan: 'STANDARD' });
    const auth = app.get(AuthService);
    const hash = await auth.hashPassword(PW);
    const email = `o-${uniq()}@lim.test`;
    await prisma.runAsTenant(A.id, () => prisma.db.user.create({ data: { email, passwordHash: hash, role: 'store_owner' } }));
    tok = (await api().post('/auth/login').set('Host', host(A)).send({ email, password: PW }).expect(200)).body.accessToken;
    superEmail = `root-${uniq()}@lim.test`;
    adminId = ((await prisma.asSystem('test', () => prisma.db.user.create({ data: { email: superEmail, passwordHash: hash, role: 'superadmin' } }))) as any).id;
    adminTok = (await api().post('/auth/login').set('Host', 'admin.localhost').send({ email: superEmail, password: PW }).expect(200)).body.accessToken;
  });
  afterAll(async () => {
    await deleteTenants(base, [A.id]);
    await base.user.deleteMany({ where: { email: superEmail } });
    await app.close();
  });

  it('defaults: 2,000 products and 10 GB; usage starts at zero and counts products through triggers', async () => {
    let u = await usage();
    expect(u).toMatchObject({ plan: 'STANDARD', products: { used: 0, limit: 2000, live: 0, liveLimit: null }, media: { usedBytes: 0, limitBytes: 10240 * 1048576, limitMb: 10240 } });
    for (let i = 0; i < 3; i++) await me().post('/store/products', { name: `p${i}`, price: 1, mrp: 1, status: i === 0 ? 'ARCHIVED' : 'ACTIVE' }).expect(201);
    u = await usage();
    expect(u.products).toMatchObject({ used: 3, live: 2 });
    expect((await counters()).productCount).toBe(3);
    const one = (await me().get('/store/products?pageSize=1').expect(200)).body.items[0];
    await me().del(`/store/products/${one.id}`).expect(204);
    expect((await counters()).productCount).toBe(2);
  });

  it('superadmin lowers the product limit: create, bulk import and the usage endpoint respect it with a friendly message', async () => {
    const r = await admin('patch', `/superadmin/tenants/${A.id}/limits`).send({ maxProducts: 4, reason: 'test' }).expect(200);
    expect(r.body.maxProducts).toBe(4);
    await admin('patch', `/superadmin/tenants/${A.id}/limits`).send({}).expect(400);
    await admin('patch', `/superadmin/tenants/${A.id}/limits`).send({ maxProducts: 0 }).expect(400);
    await me().post('/store/products', { name: 'p3', price: 1, mrp: 1 }).expect(201); // 3 of 4
    await me().post('/store/products', { name: 'p4', price: 1, mrp: 1 }).expect(201); // 4 of 4
    const blocked = await me().post('/store/products', { name: 'p5', price: 1, mrp: 1 }).expect(403);
    expect(blocked.body.message).toMatch(/reached its limit of 4 products \(4 used\)/);
    expect(blocked.body.message).toMatch(/WhatsApp/);
    const csv = 'name,price,mrp\r\nx1,1,1\r\nx2,1,1\r\n';
    const imp = await api().post('/store/import/products?filename=x.csv').set('Host', host(A)).set('Authorization', `Bearer ${tok}`).set('Content-Type', 'text/csv').send(csv).expect(200);
    expect(imp.body).toMatchObject({ imported: 0, failed: 2 });
    expect(imp.body.errors[0].reason).toMatch(/fair-use limit/);
    expect((await usage()).products).toMatchObject({ used: 4, limit: 4 });
    // the store itself cannot raise its limits
    await expect(prisma.runAsTenant(A.id, () => prisma.db.tenant.update({ where: { id: A.id }, data: { maxProducts: 999 } }))).rejects.toThrow(/cannot modify/);
    const logs = await base.auditLog.findMany({ where: { actorId: adminId, tenantId: A.id, action: 'tenant.limits_set' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].meta).toMatchObject({ maxProducts: 4 });
    await admin('patch', `/superadmin/tenants/${A.id}/limits`).send({ maxProducts: 2000 }).expect(200);
    await me().post('/store/products', { name: 'p5', price: 1, mrp: 1 }).expect(201);
  });

  it('media quota: presign is refused when announced bytes would exceed the limit; bytes follow processing and deletes', async () => {
    await admin('patch', `/superadmin/tenants/${A.id}/limits`).send({ maxMediaMb: 1 }).expect(200);
    expect((await usage()).media).toMatchObject({ usedBytes: 0, limitMb: 1, limitBytes: 1048576 });
    const tooMuch = await me().post('/store/media/presign', { files: [{ filename: 'a.jpg', contentType: 'image/jpeg', size: 700_000 }, { filename: 'b.jpg', contentType: 'image/jpeg', size: 500_000 }] }).expect(403);
    expect(tooMuch.body.message).toMatch(/Image storage is full \(0 MB of 1 GB used\)|Image storage is full/);
    const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#36c' } }).jpeg({ quality: 90 }).toBuffer();
    const pre = (await me().post('/store/media/presign', { files: [{ filename: 'ok.jpg', contentType: 'image/jpeg', size: jpg.length }] }).expect(200)).body.files[0];
    expect((await fetch(pre.uploadUrl, { method: 'PUT', headers: pre.headers, body: jpg })).status).toBe(200);
    await me().post('/store/media/complete', { ids: [pre.id] }).expect(200);
    expect(Number((await counters()).mediaBytes)).toBe(jpg.length); // original counted while queued
    await app.get(MediaWorker).runOnce();
    const m = (await me().get(`/store/media/${pre.id}`).expect(200)).body;
    expect(m.status).toBe('READY');
    expect(Number((await counters()).mediaBytes)).toBe(m.bytes); // replaced by webp + thumb
    expect((await usage()).media.usedBytes).toBe(m.bytes);
    // a request that would cross the limit by one byte is refused, exactly at the limit passes
    const room = 1048576 - m.bytes;
    await me().post('/store/media/presign', { files: [{ filename: 'c.jpg', contentType: 'image/jpeg', size: room + 1 }] }).expect(403);
    const edge = (await me().post('/store/media/presign', { files: [{ filename: 'c.jpg', contentType: 'image/jpeg', size: room }] }).expect(200)).body.files[0];
    expect(edge.id).toBeTruthy();
    await me().del(`/store/media/${pre.id}`).expect(204);
    expect(Number((await counters()).mediaBytes)).toBe(0);
    await admin('patch', `/superadmin/tenants/${A.id}/limits`).send({ maxMediaMb: 10240 }).expect(200);
  }, 60_000);

  it('a store cannot read or write another store\'s usage row', async () => {
    const B = await makeTenant(base);
    try {
      expect(await prisma.runAsTenant(A.id, () => prisma.db.tenantUsage.findUnique({ where: { tenantId: B.id } }))).toBeNull();
      await expect(prisma.runAsTenant(A.id, () => prisma.db.tenantUsage.create({ data: { tenantId: B.id } as any }))).rejects.toThrow(/does not match/);
      expect((await prisma.runAsTenant(A.id, () => prisma.db.tenantUsage.updateMany({ data: { productCount: 0 } }))).count).toBeLessThanOrEqual(1);
    } finally { await deleteTenants(base, [B.id]); }
  });
});
