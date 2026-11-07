/** The demo seed and the 500-row CSV both import cleanly; the seeded store is complete and isolated like any other. */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { ProductImportService } from '../src/imports/product-import.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { seedDemo } from '../scripts/seed-demo';
import { createApp, deleteTenants, makeTenant, uniq } from './helpers';

describe('seed data', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base: PrismaClient;
  const created: string[] = [];
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    base = prisma.base;
  });
  afterAll(async () => {
    await deleteTenants(base, created);
    await app.close();
  });

  it('seed-demo: tenant, owner login, 4 categories, 25 products with READY WebP images, orders in every status, coupons, policy pages', async () => {
    const slug = uniq('demo');
    const r = await seedDemo(app, { slug, quiet: true });
    created.push(r.tenantId);
    expect(r.warnings).toEqual([]);
    expect(r).toMatchObject({ products: 25, images: 25, customers: 6, orders: 12 });
    const t = await base.tenant.findUniqueOrThrow({ where: { slug } });
    expect(await base.category.count({ where: { tenantId: t.id } })).toBe(4);
    const products = await base.product.findMany({ where: { tenantId: t.id } });
    expect(products).toHaveLength(25);
    expect(products.every((p) => p.images.length === 1 && p.images[0].includes(`/tenants/${t.id}/product/`) && p.images[0].endsWith('.webp'))).toBe(true);
    expect(products.every((p) => p.status === 'ACTIVE' && p.price > 0 && p.mrp >= p.price)).toBe(true);
    const media = await base.media.findMany({ where: { tenantId: t.id } });
    expect(media.every((m) => m.status === 'READY' && m.width! <= 1600 && m.height! <= 1600)).toBe(true);
    const statuses = new Set((await base.order.findMany({ where: { tenantId: t.id } })).map((o) => o.orderStatus));
    expect([...statuses].sort()).toEqual(['CANCELLED', 'CONFIRMED', 'DELIVERED', 'PACKED', 'PENDING', 'RETURNED', 'SHIPPED']);
    expect(await base.coupon.count({ where: { tenantId: t.id } })).toBe(2);
    expect(await base.page.count({ where: { tenantId: t.id, isPolicy: true } })).toBe(5);
    // the owner can log in and the admin API sees everything
    const tok = (await api().post('/auth/login').set('Host', `${slug}.localhost`).send({ email: `owner@${slug}.test`, password: 'demo-password-123' }).expect(200)).body.accessToken;
    const dash = (await api().get('/store/dashboard').set('Host', `${slug}.localhost`).set('Authorization', `Bearer ${tok}`).expect(200)).body;
    expect(dash.today.orders).toBe(3); // the three orders dated today (not cancelled)
    expect(dash.codToCollect).toBe(1);
    expect((await api().get('/store/products?pageSize=50').set('Host', `${slug}.localhost`).set('Authorization', `Bearer ${tok}`).expect(200)).body.total).toBe(25);
    // seeding again replaces the store cleanly (idempotent for the developer)
    const again = await seedDemo(app, { slug, quiet: true, withImages: false, withOrders: false });
    created.push(again.tenantId);
    expect(again.tenantId).not.toBe(r.tenantId);
    expect(await base.tenant.count({ where: { slug } })).toBe(1);
    expect(await base.media.count({ where: { tenantId: r.tenantId } })).toBe(0);
  }, 120_000);

  it('the 500-row test CSV imports with no failures into a fresh STANDARD store', async () => {
    const t = await makeTenant(base, { plan: 'STANDARD' });
    created.push(t.id);
    const csv = readFileSync(join(__dirname, '..', 'seed', 'test-500-products.csv'));
    const report = await prisma.runAsTenant(t.id, () => app.get(ProductImportService).run(csv, { filename: 'test-500-products.csv' }));
    expect(report).toMatchObject({ totalRows: 500, imported: 500, failed: 0, errors: [] });
    expect(report.durationMs).toBeLessThan(30_000);
    expect(await base.product.count({ where: { tenantId: t.id } })).toBe(500);
    expect(await base.category.count({ where: { tenantId: t.id } })).toBe(20);
    expect((await base.tenantUsage.findUniqueOrThrow({ where: { tenantId: t.id } })).productCount).toBe(500);
    // and the demo CSV too, through the HTTP route
    const demo = readFileSync(join(__dirname, '..', 'seed', 'demo-products.csv'));
    const email = `o-${uniq()}@seed.test`;
    await prisma.runAsTenant(t.id, async () => prisma.db.user.create({ data: { email, passwordHash: await app.get(require('../src/auth/auth.service').AuthService).hashPassword('correct-horse-battery'), role: 'store_owner' } }));
    const tok = (await api().post('/auth/login').set('Host', `${t.subdomain}.localhost`).send({ email, password: 'correct-horse-battery' }).expect(200)).body.accessToken;
    const r = await api().post('/store/import/products?filename=demo-products.csv').set('Host', `${t.subdomain}.localhost`).set('Authorization', `Bearer ${tok}`).set('Content-Type', 'text/csv').send(demo).expect(200);
    expect(r.body).toMatchObject({ totalRows: 25, imported: 25, failed: 0 });
    expect(r.body.warnings).toHaveLength(25); // images not uploaded in this store
  }, 60_000);
});
