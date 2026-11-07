import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppConfig } from '../src/config/app-config';
import { PrismaService } from '../src/prisma/prisma.service';
import { TenantIsolationError } from '../src/prisma/tenant-scope';
import { createApp, deleteTenants, makeTenant, uniq } from './helpers';

describe('Prisma tenant-scope extension', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base: PrismaClient;
  let db: any;
  let A: { id: string };
  let B: { id: string };
  const asA = (fn: () => any): Promise<any> => prisma.runAsTenant(A.id, fn);
  const asB = (fn: () => any): Promise<any> => prisma.runAsTenant(B.id, fn);
  const prod = (n = uniq('p')) => ({ name: n, slug: n, price: 10, mrp: 12 });

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    base = prisma.base;
    db = prisma.db;
    A = await makeTenant(base);
    B = await makeTenant(base);
  });
  afterAll(async () => {
    await deleteTenants(base, [A.id, B.id]);
    await app.close();
  });

  it('fails closed with no context', async () => {
    await expect(db.product.findMany()).rejects.toThrow(TenantIsolationError);
    await expect(db.product.create({ data: prod() })).rejects.toThrow(/No tenant context/);
  });

  it('auto-injects tenantId on create / createMany / upsert without the caller passing it', async () => {
    const p = await asA(() => db.product.create({ data: prod() }));
    expect(p.tenantId).toBe(A.id);
    const r = await asA(() => db.product.createMany({ data: [prod(), prod()] }));
    expect(r.count).toBe(2);
    const u = await asA(() => db.product.upsert({ where: { tenantId_slug: { tenantId: A.id, slug: 'up-' + uniq() } }, create: prod(), update: {} }));
    expect(u.tenantId).toBe(A.id);
  });

  it('rejects an explicit foreign tenantId on create / update', async () => {
    await expect(asA(() => db.product.create({ data: { ...prod(), tenantId: B.id } }))).rejects.toThrow(/does not match/);
    const p = await asA(() => db.product.create({ data: prod() }));
    await expect(asA(() => db.product.update({ where: { id: p.id }, data: { tenantId: B.id } }))).rejects.toThrow(/cannot move/);
  });

  it('cannot read another tenant even if the caller asks for it explicitly', async () => {
    const pb = await asB(() => db.product.create({ data: prod() }));
    expect(await asA(() => db.product.findUnique({ where: { id: pb.id } }))).toBeNull();
    expect(await asA(() => db.product.findMany({ where: { tenantId: B.id } }))).toEqual([]);
    expect(await asA(() => db.product.findMany({ where: { OR: [{ tenantId: B.id }, { id: pb.id }] } }))).toEqual([]);
    expect(await asA(() => db.product.findUnique({ where: { id: pb.id, tenantId: B.id } }))).toBeNull();
    expect(await asA(() => db.product.count({ where: { id: pb.id } }))).toBe(0);
  });

  it('cannot update or delete another tenant row', async () => {
    const pb = await asB(() => db.product.create({ data: prod() }));
    await expect(asA(() => db.product.update({ where: { id: pb.id }, data: { name: 'pwn' } }))).rejects.toThrow();
    await expect(asA(() => db.product.delete({ where: { id: pb.id } }))).rejects.toThrow();
    expect((await asA(() => db.product.updateMany({ where: { id: pb.id }, data: { name: 'pwn' } }))).count).toBe(0);
    expect((await asA(() => db.product.deleteMany({ where: { id: pb.id } }))).count).toBe(0);
    expect((await base.product.findUnique({ where: { id: pb.id } }))!.name).toBe(pb.name);
  });

  it('deleteMany/updateMany with empty filter only touches the active tenant', async () => {
    await asA(() => db.coupon.create({ data: { code: uniq('c'), type: 'FLAT', value: 5 } }));
    await asB(() => db.coupon.create({ data: { code: uniq('c'), type: 'FLAT', value: 5 } }));
    await asA(() => db.coupon.deleteMany({}));
    expect(await base.coupon.count({ where: { tenantId: A.id } })).toBe(0);
    expect(await base.coupon.count({ where: { tenantId: B.id } })).toBe(1);
  });

  it('rejects nested connect to a foreign row (and the DB composite FK backs it up)', async () => {
    const cb = await asB(() => db.customer.create({ data: { name: 'b', phone: uniq('9') } }));
    await expect(
      asA(() => db.order.create({ data: { orderNo: uniq('o'), customer: { connect: { id: cb.id } }, items: [], subtotal: 1, total: 1, paymentMode: 'COD', address: {} } })),
    ).rejects.toThrow(TenantIsolationError);
    // Scalar-id path: the DB's (tenant_id, customer_id) FK refuses it.
    await expect(
      asA(() => db.order.create({ data: { orderNo: uniq('o'), customerId: cb.id, items: [], subtotal: 1, total: 1, paymentMode: 'COD', address: {} } })),
    ).rejects.toThrow(/Foreign key/i);
  });

  it('Json columns containing keys like "connect" are not misread as relation ops', async () => {
    const c = await asA(() => db.customer.create({ data: { name: 'j', phone: uniq('9'), addresses: [{ connect: 'x', set: 1 }] } }));
    expect(c.tenantId).toBe(A.id);
  });

  it('variants carry tenant_id; the composite FK refuses a variant of another tenant\'s product', async () => {
    const pa = await asA(() => db.product.create({ data: prod() }));
    const pb = await asB(() => db.product.create({ data: prod() }));
    await expect(asA(() => db.variant.create({ data: { productId: pb.id, optionName: 'Size', optionValue: 'M' } }))).rejects.toThrow(/Foreign key/i);
    const va = await asA(() => db.variant.create({ data: { productId: pa.id, optionName: 'Size', optionValue: 'M' } }));
    expect(va.tenantId).toBe(A.id);
    expect(await asB(() => db.variant.findUnique({ where: { id: va.id } }))).toBeNull();
    await expect(asB(() => db.variant.update({ where: { id: va.id }, data: { stock: 99 } }))).rejects.toThrow();
    await expect(asA(() => db.variant.update({ where: { id: va.id }, data: { productId: pb.id } }))).rejects.toThrow(/Foreign key/i);
    await expect(asA(() => db.variant.create({ data: { productId: pa.id, optionName: 'Size', optionValue: 'L', tenantId: B.id } }))).rejects.toThrow(/does not match/);
    // nested create under an owned product is fine (tenant_id is injected on the nested row too)
    const withV = await asA(() => db.product.create({ data: { ...prod(), variants: { create: [{ optionName: 'Color', optionValue: 'Red' }] } }, include: { variants: true } }));
    expect(withV.variants).toHaveLength(1);
    expect(withV.variants[0].tenantId).toBe(A.id);
  });

  it('tenant code cannot create/delete tenants or change plan/status/expiry; sees only itself', async () => {
    const seen = await asA(() => db.tenant.findMany());
    expect(seen.map((t: any) => t.id)).toEqual([A.id]);
    expect(await asA(() => db.tenant.findUnique({ where: { id: B.id } }))).toBeNull();
    await expect(asA(() => db.tenant.update({ where: { id: A.id }, data: { status: 'LIVE', plan: 'STANDARD' } }))).rejects.toThrow(/cannot modify/);
    await expect(asA(() => db.tenant.update({ where: { id: A.id }, data: { expiresAt: null } }))).rejects.toThrow(/cannot modify/);
    await expect(asA(() => db.tenant.delete({ where: { id: A.id } }))).rejects.toThrow(TenantIsolationError);
    await expect(asA(() => db.tenant.create({ data: { name: 'x', slug: uniq(), subdomain: uniq() } }))).rejects.toThrow(TenantIsolationError);
    await expect(asA(() => db.tenant.update({ where: { id: B.id }, data: { name: 'pwn' } }))).rejects.toThrow();
    await asA(() => db.tenant.update({ where: { id: A.id }, data: { name: 'Renamed' } }));
  });

  it('raw queries are disabled on the scoped client', () => {
    expect(() => db.$queryRaw`select 1`).toThrow(/Raw queries are disabled/);
    expect(() => db.$executeRawUnsafe('delete from products')).toThrow(/Raw queries are disabled/);
  });

  it('works inside interactive and batch transactions', async () => {
    const out = await asA(() =>
      db.$transaction(async (tx: any) => {
        await tx.product.create({ data: prod() });
        return tx.product.findMany();
      }),
    );
    expect(out.every((p: any) => p.tenantId === A.id)).toBe(true);
    const [x, y] = await asA(() => db.$transaction([db.product.count(), db.coupon.count()]));
    expect(typeof x).toBe('number');
    expect(typeof y).toBe('number');
  });

  it('inside db.$transaction the tx client is scoped; a stray db.* call still works (own transaction) and never widens', async () => {
    const out = await asA(() =>
      db.$transaction(async (tx: any) => {
        const inTx = await tx.product.count();
        const outside = await db.product.count(); // not part of the transaction, but still pinned to tenant A on its own
        return { inTx, outside };
      }),
    );
    expect(out.inTx).toBe(out.outside);
    expect(out.inTx).toBe(await base.product.count({ where: { tenantId: A.id } }));
    await expect(asA(() => db.$transaction(async (tx: any) => tx.$executeRawUnsafe('select 1')))).rejects.toThrow(/Raw queries are disabled/);
    await expect(asA(() => db.$transaction(async (tx: any) => tx.$transaction(async () => 1)))).rejects.toThrow(/Nested transactions/);
    // a bypass may not be opened INSIDE a tenant transaction (its statements would run on another connection)
    await expect(asA(() => db.$transaction(async (tx: any) => prisma.asSystem('x', () => tx.product.findMany())))).rejects.toThrow(/bypass inside a tenant-scoped transaction/);
    await expect(db.$transaction(async () => 1)).rejects.toThrow(/No tenant context/);
  });

  it('refuses to boot when the application connection could sidestep row-level security', async () => {
    const cfg = app.get(AppConfig);
    const bad = new PrismaService({ ...cfg, databaseUrl: cfg.databaseAdminUrl } as AppConfig); // owner/superuser as the app role
    await expect(bad.onModuleInit()).rejects.toThrow(/Row-level security is not enforceable/);
    await bad.onModuleDestroy();
    const good = new PrismaService(cfg);
    await expect(good.onModuleInit()).resolves.toBeUndefined();
    await good.onModuleDestroy();
  });

  it('platform scope sees only tenant_id NULL users and nothing else', async () => {
    const email = `${uniq('sa')}@x.test`;
    await prisma.asSystem('test:create superadmin', () => db.user.create({ data: { email, passwordHash: 'x', role: 'superadmin' } }));
    const found: any = await prisma.asPlatform(() => db.user.findFirst({ where: { email } }));
    expect(found?.tenantId).toBeNull();
    await expect(prisma.asPlatform(() => db.product.findMany())).rejects.toThrow(/Platform scope/);
    await expect(prisma.asPlatform(() => db.tenant.findMany())).rejects.toThrow(/Platform scope/);
    await asA(() => db.user.create({ data: { email: `${uniq('o')}@x.test`, passwordHash: 'x', role: 'store_owner' } }));
    const all: any[] = await prisma.asPlatform(() => db.user.findMany());
    expect(all.every((u: any) => u.tenantId === null)).toBe(true);
    // a tenant context cannot see the superadmin
    expect(await asA(() => db.user.findFirst({ where: { email } }))).toBeNull();
    // tenant code cannot mint a superadmin (DB CHECK + injected tenantId)
    await expect(asA(() => db.user.create({ data: { email: `${uniq('s')}@x.test`, passwordHash: 'x', role: 'superadmin' } }))).rejects.toThrow();
    await base.user.deleteMany({ where: { email } });
  });

  describe('superadmin bypass', () => {
    const actor = { id: randomUUID(), role: 'superadmin' as const, tenantId: null };

    it('requires a superadmin actor', () => {
      expect(() => prisma.asSuperadmin({ ...actor, role: 'staff' }, 'x', async () => 1)).toThrow(/Superadmin required/);
    });

    it('sees across tenants and writes an audit row for every operation, without data values or secrets', async () => {
      const before = await base.auditLog.count({ where: { actorId: actor.id } });
      const rows: any[] = await prisma.asSuperadmin(actor, 'support ticket #42', async () => {
        await db.product.findMany({ where: { tenantId: A.id } });
        await db.tenant.update({ where: { id: B.id }, data: { razorpayKeyEnc: 'v1:TOPSECRETCIPHER', name: 'Audited' } });
        return db.tenant.findMany({ where: { id: { in: [A.id, B.id] } } });
      });
      expect(rows).toHaveLength(2);
      const logs = await base.auditLog.findMany({ where: { actorId: actor.id }, orderBy: { createdAt: 'asc' } });
      expect(logs.length - before).toBe(3);
      const upd = logs.find((l) => l.action === 'db.Tenant.update')!;
      expect(upd.tenantId).toBe(B.id);
      expect((upd.meta as any).reason).toBe('support ticket #42');
      expect((upd.meta as any).dataKeys).toEqual(expect.arrayContaining(['razorpayKeyEnc', 'name']));
      expect(JSON.stringify(logs)).not.toContain('TOPSECRETCIPHER');
    });

    it('audit_logs is append-only at the database level', async () => {
      const row = await base.auditLog.create({ data: { action: 'test.immutable' } });
      await expect(base.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } })).rejects.toThrow(/append-only/);
      await expect(base.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    });

    it('tenant code cannot touch audit_logs except to append, and sees only its own', async () => {
      await asA(() => db.auditLog.create({ data: { action: 'order.cancelled' } }));
      const mine = await asA(() => db.auditLog.findMany());
      expect(mine.every((l: any) => l.tenantId === A.id)).toBe(true);
      await expect(asA(() => db.auditLog.deleteMany({}))).rejects.toThrow(/append-only/);
      await expect(asA(() => db.auditLog.updateMany({ data: { action: 'x' } }))).rejects.toThrow(/append-only/);
    });
  });
});
