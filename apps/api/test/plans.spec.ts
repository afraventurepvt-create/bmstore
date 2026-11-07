import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PLAN_LIMIT_ERROR, PLAN_LIMITS } from '../src/tenancy/plans';
import { createApp, deleteTenants, makeTenant, uniq } from './helpers';

describe('plans: STARTER caps products at 10, STANDARD does not', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base: PrismaClient;
  let db: any;
  let adminTok: string;
  let superEmail: string;
  const created: string[] = [];
  const PW = 'a-very-long-password';
  const prod = (i: number) => ({ name: `p${i}`, slug: `p-${i}-${uniq()}`, price: 1000, mrp: 1200 });
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    base = prisma.base;
    db = prisma.db;
    superEmail = `root-${uniq()}@test.local`;
    const passwordHash = await app.get(AuthService).hashPassword(PW);
    await prisma.asSystem('test', () => db.user.create({ data: { email: superEmail, passwordHash, role: 'superadmin' } }));
    adminTok = (await api().post('/auth/login').set('Host', 'admin.localhost').send({ email: superEmail, password: PW }).expect(200)).body.accessToken;
  });
  afterAll(async () => {
    await deleteTenants(base, created);
    await base.user.deleteMany({ where: { email: superEmail } });
    await app.close();
  });

  const starter = async () => { const t = await makeTenant(base); created.push(t.id); expect(t.plan).toBe('STARTER'); return t; };
  const fill = (tid: string, n: number, from = 0) => prisma.runAsTenant(tid, async () => { for (let i = from; i < from + n; i++) await db.product.create({ data: prod(i) }); });

  it('STARTER: the 11th product is refused by the database, the first 10 stay', async () => {
    const t = await starter();
    await fill(t.id, PLAN_LIMITS.STARTER.maxProducts!);
    await expect(fill(t.id, 1, 10)).rejects.toThrow(PLAN_LIMIT_ERROR);
    await expect(prisma.runAsTenant(t.id, () => db.product.createMany({ data: [prod(11)] }))).rejects.toThrow(PLAN_LIMIT_ERROR);
    expect(await base.product.count({ where: { tenantId: t.id } })).toBe(10);
  });

  it('archived products do not count: archiving frees a slot, un-archiving at the cap is refused', async () => {
    const t = await starter();
    await fill(t.id, 10);
    const first = await base.product.findFirstOrThrow({ where: { tenantId: t.id } });
    await prisma.runAsTenant(t.id, () => db.product.update({ where: { id: first.id }, data: { status: 'ARCHIVED' } }));
    await fill(t.id, 1, 10); // slot freed
    await expect(fill(t.id, 1, 11)).rejects.toThrow(PLAN_LIMIT_ERROR);
    // bringing the archived one back would make 11 live products
    await expect(prisma.runAsTenant(t.id, () => db.product.update({ where: { id: first.id }, data: { status: 'ACTIVE' } }))).rejects.toThrow(PLAN_LIMIT_ERROR);
    // status changes that do not leave ARCHIVED, or between DRAFT and ACTIVE, are untouched
    await prisma.runAsTenant(t.id, () => db.product.updateMany({ where: { status: 'DRAFT' }, data: { status: 'ACTIVE' } }));
    await prisma.runAsTenant(t.id, () => db.product.update({ where: { id: first.id }, data: { name: 'renamed' } }));
    // archived products can be created freely
    await prisma.runAsTenant(t.id, () => db.product.create({ data: { ...prod(50), status: 'ARCHIVED' } }));
    expect(await base.product.count({ where: { tenantId: t.id, status: { not: 'ARCHIVED' } } })).toBe(10);
    expect(await base.product.count({ where: { tenantId: t.id } })).toBe(12);
  });

  it('a createMany that would cross the cap is rejected as a whole', async () => {
    const t = await starter();
    await expect(prisma.runAsTenant(t.id, () => db.product.createMany({ data: Array.from({ length: 11 }, (_, i) => prod(i)) }))).rejects.toThrow(PLAN_LIMIT_ERROR);
    expect(await base.product.count({ where: { tenantId: t.id } })).toBe(0);
  });

  it('the cap binds the owner connection too (it is a trigger, not an RLS policy)', async () => {
    const t = await starter();
    await fill(t.id, 10);
    await expect(base.product.create({ data: { ...prod(99), tenantId: t.id } })).rejects.toThrow(PLAN_LIMIT_ERROR);
  });

  it('STANDARD is unlimited; superadmin plan changes take effect immediately and are audited', async () => {
    const std = await makeTenant(base, { plan: 'STANDARD' });
    created.push(std.id);
    await fill(std.id, 12);
    expect(await base.product.count({ where: { tenantId: std.id } })).toBe(12);

    const t = await starter();
    await fill(t.id, 10);
    const admin = (plan: unknown) => api().patch(`/superadmin/tenants/${t.id}/plan`).set('Host', 'admin.localhost').set('Authorization', `Bearer ${adminTok}`).send({ plan });
    await admin('pro').expect(400);
    expect((await admin('STANDARD').expect(200)).body.plan).toBe('STANDARD');
    await fill(t.id, 2, 10); // 12 products now
    // downgrade keeps existing products, blocks new ones
    expect((await admin('STARTER').expect(200)).body.plan).toBe('STARTER');
    expect(await base.product.count({ where: { tenantId: t.id } })).toBe(12);
    await expect(fill(t.id, 1, 20)).rejects.toThrow(PLAN_LIMIT_ERROR);
    const logs = await base.auditLog.findMany({ where: { tenantId: t.id, action: 'tenant.plan_set' }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => (l.meta as any).plan)).toEqual(['STANDARD', 'STARTER']);
    // tenant code can never change its own plan
    await expect(prisma.runAsTenant(t.id, () => db.tenant.update({ where: { id: t.id }, data: { plan: 'STANDARD' } }))).rejects.toThrow(/cannot modify/);
  });

  it('money columns are integers in Postgres and enum columns use the fixed vocabulary', async () => {
    const cols: Array<{ table_name: string; column_name: string; data_type: string; udt_name: string }> = await base.$queryRaw`
      SELECT table_name, column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND (
        (table_name = 'products' AND column_name IN ('price', 'mrp', 'status')) OR
        (table_name = 'orders' AND column_name IN ('subtotal', 'shipping', 'tax', 'total', 'payment_mode', 'payment_status', 'order_status')) OR
        (table_name = 'coupons' AND column_name IN ('value', 'min_order', 'type')) OR
        (table_name = 'settings' AND column_name IN ('flat_rate', 'free_above', 'cod_charge', 'shipping_mode')) OR
        (table_name = 'variants' AND column_name = 'price_delta') OR
        (table_name = 'tenants' AND column_name IN ('plan', 'status')))`;
    const types = Object.fromEntries(cols.map((c) => [`${c.table_name}.${c.column_name}`, c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type]));
    for (const k of ['products.price', 'products.mrp', 'orders.subtotal', 'orders.shipping', 'orders.tax', 'orders.total', 'coupons.value', 'coupons.min_order', 'settings.flat_rate', 'settings.free_above', 'settings.cod_charge', 'variants.price_delta']) {
      expect([k, types[k]]).toEqual([k, 'integer']);
    }
    expect(types).toMatchObject({ 'tenants.plan': 'TenantPlan', 'tenants.status': 'TenantStatus', 'products.status': 'ProductStatus', 'orders.payment_mode': 'PaymentMode', 'orders.payment_status': 'PaymentStatus', 'orders.order_status': 'OrderStatus', 'coupons.type': 'CouponType', 'settings.shipping_mode': 'ShippingMode' });
    const enums: Array<{ t: string; v: string[] }> = await base.$queryRaw`
      SELECT t.typname AS t, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS v FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname`;
    const byName = Object.fromEntries(enums.map((e) => [e.t, e.v]));
    expect(byName.OrderStatus).toEqual(['PENDING', 'CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED']);
    expect(byName.PaymentStatus).toEqual(['PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED']);
    expect(byName.PaymentMode).toEqual(['COD', 'ONLINE']);
    expect(byName.TenantPlan).toEqual(['STARTER', 'STANDARD']);
    expect(byName.TenantStatus).toEqual(['BUILDING', 'LIVE', 'SUSPENDED', 'PARKED']);
    expect(byName.CouponType).toEqual(['PERCENT', 'FLAT']);
    expect(byName.ProductStatus).toEqual(['DRAFT', 'ACTIVE', 'ARCHIVED']);
    // a PERCENT coupon above 100 and negative money are refused by CHECK constraints
    const t = await starter();
    await expect(prisma.runAsTenant(t.id, () => db.coupon.create({ data: { code: 'X', type: 'PERCENT', value: 150 } }))).rejects.toThrow();
    await expect(prisma.runAsTenant(t.id, () => db.product.create({ data: { ...prod(1), price: -1 } }))).rejects.toThrow();
  });
});
