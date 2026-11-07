/** Bulk image upload: presign -> PUT to storage -> complete -> worker (WebP 1600 + 400 thumb, EXIF stripped) -> bytes per tenant. */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { MediaWorker } from '../src/media/media-worker';
import { PrismaService } from '../src/prisma/prisma.service';
import { ObjectStorageService } from '../src/storage/object-storage.service';
import { createApp, deleteTenants, makeTenant, uniq } from './helpers';

describe('media pipeline', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base: PrismaClient;
  let worker: MediaWorker;
  let storage: ObjectStorageService;
  let A: any, B: any, tokA: string, tokB: string;
  const PW = 'correct-horse-battery';
  const api = () => request(app.getHttpServer());
  const host = (t: any) => `${t.subdomain}.localhost`;
  const as = (tok: string, t: any = A) => ({
    get: (p: string) => api().get(p).set('Host', host(t)).set('Authorization', `Bearer ${tok}`),
    post: (p: string, b?: any) => api().post(p).set('Host', host(t)).set('Authorization', `Bearer ${tok}`).send(b),
    del: (p: string) => api().delete(p).set('Host', host(t)).set('Authorization', `Bearer ${tok}`),
  });

  /** A big JPEG with EXIF (orientation + a comment) so we can prove rotation is applied and metadata dropped. */
  async function photo(width = 3000, height = 2000, orientation = 6) {
    return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
      .jpeg({ quality: 70 })
      .withMetadata({ orientation, exif: { IFD0: { Copyright: 'SECRET-EXIF-STRING', Artist: 'camera owner' } } })
      .toBuffer();
  }
  const put = async (uploadUrl: string, headers: Record<string, string>, body: Buffer) => {
    const r = await fetch(uploadUrl, { method: 'PUT', headers, body });
    return r.status;
  };

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    base = prisma.base;
    worker = app.get(MediaWorker);
    storage = app.get(ObjectStorageService);
    expect(storage.configured).toBe(true);
    A = await makeTenant(base, { plan: 'STANDARD' });
    B = await makeTenant(base, { plan: 'STANDARD' });
    const auth = app.get(AuthService);
    const mk = async (t: any) => {
      const email = `o-${uniq()}@media.test`;
      await prisma.runAsTenant(t.id, async () => prisma.db.user.create({ data: { email, passwordHash: await auth.hashPassword(PW), role: 'store_owner' } }));
      return (await api().post('/auth/login').set('Host', host(t)).send({ email, password: PW }).expect(200)).body.accessToken;
    };
    tokA = await mk(A);
    tokB = await mk(B);
  });
  afterAll(async () => {
    await deleteTenants(base, [A.id, B.id]);
    await app.close();
  });

  it('presign -> PUT -> complete -> READY: WebP <= 1600px, 400px thumb, EXIF gone, original removed, bytes tracked', async () => {
    const jpg = await photo();
    const pre = await as(tokA).post('/store/media/presign', { files: [{ filename: 'Saree-RED.jpg', contentType: 'image/jpeg', size: jpg.length, kind: 'product' }] }).expect(200);
    const f = pre.body.files[0];
    expect(f.uploadUrl).toContain(`/tenants/${A.id}/originals/`);
    expect(f.headers).toEqual({ 'Content-Type': 'image/jpeg', 'Content-Length': String(jpg.length) });
    expect((await as(tokA).get(`/store/media/${f.id}`).expect(200)).body.status).toBe('PENDING');
    // completing before the upload arrived is a soft "not yet"
    expect((await as(tokA).post('/store/media/complete', { ids: [f.id] }).expect(200)).body.results[0]).toMatchObject({ status: 'PENDING' });
    expect(await put(f.uploadUrl, f.headers, jpg)).toBe(200);
    expect((await as(tokA).post('/store/media/complete', { ids: [f.id] }).expect(200)).body.results[0]).toMatchObject({ status: 'UPLOADED' });
    expect(await worker.runOnce()).toBeGreaterThanOrEqual(1);
    const m = (await as(tokA).get(`/store/media/${f.id}`).expect(200)).body;
    expect(m.status).toBe('READY');
    expect(m.url).toMatch(new RegExp(`/tenants/${A.id}/product/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.webp$`));
    expect(m.thumbUrl).toMatch(/_thumb\.webp$/);
    // orientation 6 (rotate 90) was applied: a 3000x2000 landscape becomes portrait 1067x1600
    expect(m).toMatchObject({ width: 1067, height: 1600, filename: 'Saree-RED.jpg' });
    const webp = await storage.get(m.key);
    const meta = await sharp(webp).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 1067, height: 1600 });
    expect(meta.exif).toBeUndefined();
    expect(webp.includes(Buffer.from('SECRET-EXIF-STRING'))).toBe(false);
    const thumb = await sharp(await storage.get(m.thumbKey)).metadata();
    expect(thumb.height).toBe(400);
    expect(thumb.width).toBe(267);
    expect(m.bytes).toBe(webp.length + (await storage.get(m.thumbKey)).length);
    expect(await storage.head(m.originalKey)).toBeNull(); // original gone
    expect(m.bytes).toBeLessThan(jpg.length);
  }, 60_000);

  it('small images are not enlarged; PNG/WebP/GIF inputs all end as WebP; batch of 5', async () => {
    const small = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.5 } } }).png().toBuffer();
    const files = Array.from({ length: 5 }, (_, i) => ({ filename: `small-${i}.png`, contentType: 'image/png', size: small.length }));
    const pre = (await as(tokA).post('/store/media/presign', { files }).expect(200)).body.files;
    for (const f of pre) expect(await put(f.uploadUrl, f.headers, small)).toBe(200);
    const done = (await as(tokA).post('/store/media/complete', { ids: pre.map((f: any) => f.id) }).expect(200)).body.results;
    expect(done.every((r: any) => r.status === 'UPLOADED')).toBe(true);
    await worker.runOnce();
    for (const f of pre) {
      const m = (await as(tokA).get(`/store/media/${f.id}`).expect(200)).body;
      expect(m).toMatchObject({ status: 'READY', width: 300, height: 200 });
      expect((await sharp(await storage.get(m.key)).metadata()).format).toBe('webp');
    }
    const list = await as(tokA).get('/store/media?status=READY&q=small').expect(200);
    expect(list.body.total).toBe(5);
  }, 60_000);

  it('garbage bytes fail with a plain reason after 3 attempts; size mismatch is rejected at complete', async () => {
    const junk = Buffer.from('definitely not an image '.repeat(100));
    const pre = (await as(tokA).post('/store/media/presign', { files: [{ filename: 'junk.jpg', contentType: 'image/jpeg', size: junk.length }, { filename: 'short.jpg', contentType: 'image/jpeg', size: junk.length + 10 }] }).expect(200)).body.files;
    expect(await put(pre[0].uploadUrl, pre[0].headers, junk)).toBe(200);
    expect(await put(pre[1].uploadUrl, { ...pre[1].headers, 'Content-Length': String(junk.length) }, junk)).toBe(200); // lies about size
    const done = (await as(tokA).post('/store/media/complete', { ids: pre.map((f: any) => f.id) }).expect(200)).body.results;
    expect(done[0].status).toBe('UPLOADED');
    expect(done[1]).toMatchObject({ status: 'FAILED' });
    expect(done[1].reason).toMatch(/does not match/);
    await worker.runOnce(); await worker.runOnce(); await worker.runOnce();
    const m = (await as(tokA).get(`/store/media/${pre[0].id}`).expect(200)).body;
    expect(m).toMatchObject({ status: 'FAILED', attempts: 3, bytes: 0 });
    expect(m.error).toMatch(/not a valid image/);
    expect(await storage.head(m.originalKey)).toBeNull();
  }, 60_000);

  it('validation: types, sizes, batch size, unknown kind', async () => {
    await as(tokA).post('/store/media/presign', { files: [] }).expect(400);
    await as(tokA).post('/store/media/presign', { files: [{ filename: 'x.exe', contentType: 'application/octet-stream', size: 10 }] }).expect(400);
    const r = await as(tokA).post('/store/media/presign', { files: [{ filename: 'huge.jpg', contentType: 'image/jpeg', size: 50 * 1024 * 1024 }] }).expect(400);
    expect(r.body.message).toMatch(/maximum is 12 MB/);
    await as(tokA).post('/store/media/presign', { files: Array.from({ length: 51 }, () => ({ filename: 'a.jpg', contentType: 'image/jpeg', size: 1 })) }).expect(400);
    await as(tokA).post('/store/media/presign', { files: [{ filename: 'a.jpg', contentType: 'image/jpeg', size: 1, kind: 'backup' }] }).expect(400);
  });

  it('isolation: keys carry the tenant id; another store cannot see, complete or delete my images; media bytes are per tenant', async () => {
    const mine = await base.media.findMany({ where: { tenantId: A.id } });
    expect(mine.length).toBeGreaterThan(0);
    for (const m of mine) for (const k of [m.originalKey, m.key, m.thumbKey]) if (k) expect(k.startsWith(`tenants/${A.id}/`)).toBe(true);
    const ready = mine.find((m) => m.status === 'READY')!;
    await as(tokB, B).get(`/store/media/${ready.id}`).expect(404);
    await as(tokB, B).del(`/store/media/${ready.id}`).expect(404);
    expect((await as(tokB, B).post('/store/media/complete', { ids: [ready.id] }).expect(200)).body.results[0].status).toBe('NOT_FOUND');
    expect((await as(tokB, B).get('/store/media').expect(200)).body.total).toBe(0);
    await as(tokB, A).get('/store/media').expect(403);
    const usedA = (await base.media.aggregate({ _sum: { bytes: true }, where: { tenantId: A.id } }))._sum.bytes ?? 0;
    expect(usedA).toBeGreaterThan(0);
    expect((await base.media.aggregate({ _sum: { bytes: true }, where: { tenantId: B.id } }))._sum.bytes ?? 0).toBe(0);
    // delete removes the objects and the bytes
    await as(tokA).del(`/store/media/${ready.id}`).expect(204);
    expect(await storage.head(ready.key!)).toBeNull();
    expect(await storage.head(ready.thumbKey!)).toBeNull();
    expect((await base.media.aggregate({ _sum: { bytes: true }, where: { tenantId: A.id } }))._sum.bytes ?? 0).toBe(usedA - ready.bytes);
  });

  it('CSV import attaches READY images by filename (case-insensitive) and warns about unknown ones', async () => {
    const jpg = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#0f0' } }).jpeg().toBuffer();
    const pre = (await as(tokA).post('/store/media/presign', { files: [{ filename: 'Kurta-Blue.jpg', contentType: 'image/jpeg', size: jpg.length }] }).expect(200)).body.files[0];
    await put(pre.uploadUrl, pre.headers, jpg);
    await as(tokA).post('/store/media/complete', { ids: [pre.id] }).expect(200);
    await worker.runOnce();
    const csv = 'name,price,mrp,sku,image_filename\r\nBlue Kurta,799,999,KB-1,kurta-blue.JPG\r\nNo image,10,12,NI-1,missing.jpg\r\n';
    const r = await api().post('/store/import/products?filename=p.csv').set('Host', host(A)).set('Authorization', `Bearer ${tokA}`).set('Content-Type', 'text/csv').send(csv).expect(200);
    expect(r.body).toMatchObject({ imported: 2, failed: 0 });
    expect(r.body.warnings.map((w: any) => w.row)).toEqual([3]);
    const p = await base.product.findFirstOrThrow({ where: { tenantId: A.id, sku: 'KB-1' } });
    expect(p.images).toHaveLength(1);
    expect(p.images[0]).toMatch(new RegExp(`/tenants/${A.id}/product/.*\\.webp$`));
    // the other store cannot use that filename: its own media table is empty
    const rb = await api().post('/store/import/products?filename=p.csv').set('Host', host(B)).set('Authorization', `Bearer ${tokB}`).set('Content-Type', 'text/csv').send(csv).expect(200);
    expect(rb.body.warnings.map((w: any) => w.row)).toEqual([2, 3]);
  }, 60_000);
});
