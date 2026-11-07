/**
 * ===================================  THE GATE TEST  ===================================
 * Two tenants (A, B). A row is written in EVERY model for each tenant (through the scoped client, as that
 * tenant). Then, for EVERY model and in BOTH directions (A->B and B->A), we assert the other tenant's rows can
 * not be read, updated, deleted, upserted over, re-parented or referenced - by any operation the client offers,
 * including unique-key, compound-key, relation-filter and relation-traversal routes. Then the same attacks are
 * repeated WITHOUT the app layer (a plain Prisma client and raw SQL on the application role) to prove the
 * database's row-level security holds on its own. Finally we assert B's data is byte-for-byte unchanged and that
 * the explicit superadmin bypass is audited.
 *
 * The model list comes from the Prisma DMMF, NOT from a hand-written list: adding a table without classifying
 * it and without a factory below fails this suite (and therefore CI).
 */
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { roleFacts, tableFacts } from '../src/prisma/rls-check';
import { pinScope, SCOPES, TenantIsolationError } from '../src/prisma/tenant-scope';
import { createApp, deleteTenants, uniq } from './helpers';

type Row = Record<string, any>;
type Seed = Record<string, Row[]>;

const DMMF_MODELS = Prisma.dmmf.datamodel.models;
const MODELS = DMMF_MODELS.map((m) => m.name);
const lc = (m: string) => m[0].toLowerCase() + m.slice(1);
const modelDef = (m: string) => DMMF_MODELS.find((x) => x.name === m)!;
const pkField = (m: string) => modelDef(m).fields.find((f) => f.isId)!.name; // 'id' or 'tenantId'
const hasField = (m: string, f: string) => modelDef(m).fields.some((x) => x.name === f);
const SINGLE_ROW = new Set(['Tenant', 'ThemeConfig', 'Settings', 'TenantUsage']); // exactly one row per tenant
const rnd = () => randomBytes(4).toString('hex');

async function rejection(p: Promise<any>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error('Expected the operation to be rejected, but it succeeded');
}
/** The rejection must be for the RIGHT reason: our guard, or a precise Prisma code (not a random failure). */
function expectBlocked(err: any, ...codes: string[]) {
  const ok = err instanceof TenantIsolationError || err?.name === 'TenantIsolationError' || codes.includes(err?.code);
  if (!ok) throw new Error(`Rejected for the wrong reason: ${err?.name} ${err?.code} ${String(err?.message).slice(0, 200)}`);
}

// ---- per-model factories: create one row AS the active tenant (tenant_id is NOT passed: injection does it) ----
const factories: Record<string, (db: any, s: Seed, i: number, over?: Row) => Promise<Row>> = {
  Tenant: async () => { throw new Error('tenants are provisioned by superadmin, not by tenant code'); },
  ThemeConfig: (db, _s, i, o) => db.themeConfig.create({ data: { layoutVariant: `lv${i}`, bannerUrls: ['b.png'], ...o } }),
  Settings: (db, _s, i, o) => db.settings.create({ data: { orderPrefix: `P${i}`, ...o } }),
  TenantUsage: (db, _s, _i, o) => db.tenantUsage.create({ data: { ...o } }), // triggers then keep it current
  Category: (db, s, i, o) => db.category.create({ data: { name: `cat${i}`, slug: `cat-${i}-${rnd()}`, parentId: i > 0 ? s.Category[0].id : undefined, ...o } }),
  Customer: (db, _s, i, o) => db.customer.create({ data: { name: `cust${i}`, phone: `9${rnd()}${i}`, email: `c${i}-${rnd()}@x.test`, addresses: [{ line1: 'x' }], ...o } }),
  Product: (db, s, i, o) => db.product.create({ data: { name: `prod${i}`, slug: `prod-${i}-${rnd()}`, price: 10, mrp: 12, sku: `sku-${rnd()}`, stock: 3, categoryId: s.Category[0].id, images: ['i.png'], hsnCode: '6109', ...o } }),
  Variant: (db, s, i, o) => db.variant.create({ data: { productId: s.Product[i % s.Product.length].id, optionName: 'Size', optionValue: `v${i}-${rnd()}`, priceDelta: 1, stock: 2, sku: `vs-${rnd()}`, ...o } }),
  Order: (db, s, i, o) => db.order.create({ data: { orderNo: `ORD-${i}-${rnd()}`, customerId: s.Customer[i % s.Customer.length].id, items: [{ sku: 'x', qty: 1 }], subtotal: 10, shipping: 1, tax: 1, total: 12, paymentMode: 'COD', address: { city: 'Pune' }, ...o } }),
  Coupon: (db, _s, i, o) => db.coupon.create({ data: { code: `C${i}${rnd()}`, type: 'PERCENT', value: 10, minOrder: 100, usageLimit: 5, ...o } }),
  Page: (db, _s, i, o) => db.page.create({ data: { slug: `pg-${i}-${rnd()}`, title: `Page ${i}`, content: 'hello', isPolicy: i === 0, ...o } }),
  User: (db, _s, i, o) => db.user.create({ data: { email: `u${i}-${rnd()}@gate.test`, passwordHash: 'not-a-real-hash', role: 'staff', ...o } }),
  RefreshToken: (db, s, i, o) => db.refreshToken.create({ data: { userId: s.User[0].id, familyId: randomUUID(), tokenHash: `h-${rnd()}-${i}`, expiresAt: new Date(Date.now() + 86_400_000), ...o } }),
  PasswordResetToken: (db, s, i, o) => db.passwordResetToken.create({ data: { userId: s.User[0].id, tokenHash: `r-${rnd()}-${i}`, expiresAt: new Date(Date.now() + 1_800_000), ...o } }),
  AuditLog: (db, _s, i, o) => db.auditLog.create({ data: { action: `gate.seed.${i}`, meta: { i }, ...o } }),
  Media: (db, _s, i, o) => db.media.create({ data: { kind: 'product', filename: `img-${i}.jpg`, contentType: 'image/jpeg', originalKey: `tenants/x/originals/${rnd()}.jpg`, declaredBytes: 10, ...o } }),
};
/** Run a factory against a recorder instead of the DB to obtain the exact create-data it would send. */
const recorder: any = new Proxy({}, { get: () => ({ create: ({ data }: Row) => ({ __data: data }) }) });
const dataFor = async (m: string, s: Seed, i: number, over: Row = {}): Promise<Row> => ((await factories[m](recorder, s, i, over)) as any).__data;
const SEED_ORDER = ['ThemeConfig', 'Settings', 'TenantUsage', 'Category', 'Customer', 'Product', 'Variant', 'Order', 'Coupon', 'Page', 'User', 'RefreshToken', 'PasswordResetToken', 'AuditLog', 'Media'];

// ---- per-model attack metadata ----
interface Meta {
  touch: Row;                                  // harmless update payload
  compound?: (r: Row) => Row;                  // alternative unique selector built from the OTHER tenant's coordinates
  before?: string[];                           // dependents to clear first in the rolled-back mass-delete
  createBlocked?: boolean; updateBlocked?: boolean; deleteBlocked?: boolean;
  crossRef?: (db: any, s: Seed, other: Seed) => Promise<any>; // scalar FK pointing at the OTHER tenant's row
}
const META: Record<string, Meta> = {
  Tenant: { touch: { name: 'touched' }, compound: (r) => ({ slug: r.slug }), createBlocked: true, deleteBlocked: true },
  ThemeConfig: { touch: { layoutVariant: 'touched' } },
  Settings: { touch: { orderPrefix: 'TOUCHED' } },
  TenantUsage: { touch: { productCount: 99 } },
  Category: {
    touch: { image: 'touched.png' }, compound: (r) => ({ tenantId_slug: { tenantId: r.tenantId, slug: r.slug } }), before: ['product'],
    crossRef: (db, s, o) => factories.Category(db, s, 50, { parentId: o.Category[0].id }),
  },
  Customer: { touch: { name: 'touched' }, compound: (r) => ({ tenantId_phone: { tenantId: r.tenantId, phone: r.phone } }), before: ['order'] },
  Product: {
    touch: { stock: 99 }, compound: (r) => ({ tenantId_slug: { tenantId: r.tenantId, slug: r.slug } }),
    crossRef: (db, s, o) => factories.Product(db, s, 50, { categoryId: o.Category[0].id }),
  },
  Variant: {
    touch: { stock: 99 }, compound: (r) => ({ tenantId_productId_optionName_optionValue: { tenantId: r.tenantId, productId: r.productId, optionName: r.optionName, optionValue: r.optionValue } }),
    crossRef: (db, s, o) => factories.Variant(db, s, 50, { productId: o.Product[0].id }),
  },
  Order: {
    touch: { tax: 5 }, compound: (r) => ({ tenantId_orderNo: { tenantId: r.tenantId, orderNo: r.orderNo } }),
    crossRef: (db, s, o) => factories.Order(db, s, 50, { customerId: o.Customer[0].id }),
  },
  Coupon: { touch: { minOrder: 5 }, compound: (r) => ({ tenantId_code: { tenantId: r.tenantId, code: r.code } }) },
  Page: { touch: { title: 'touched' }, compound: (r) => ({ tenantId_slug: { tenantId: r.tenantId, slug: r.slug } }) },
  User: { touch: { phone: '000' }, compound: (r) => ({ tenantId_email: { tenantId: r.tenantId, email: r.email } }) },
  RefreshToken: {
    touch: { revokedAt: new Date() }, compound: (r) => ({ tokenHash: r.tokenHash }),
    crossRef: (db, s, o) => factories.RefreshToken(db, s, 50, { userId: o.User[0].id }),
  },
  PasswordResetToken: {
    touch: { usedAt: new Date() }, compound: (r) => ({ tokenHash: r.tokenHash }),
    crossRef: (db, s, o) => factories.PasswordResetToken(db, s, 50, { userId: o.User[0].id }),
  },
  AuditLog: { touch: { action: 'touched' }, updateBlocked: true, deleteBlocked: true },
  Media: { touch: { error: 'touched' } },
};

describe('GATE: tenant isolation across every model', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base: PrismaClient;
  let db: any;
  const T: Record<'A' | 'B', Row> = {} as any;
  const seeded: Record<'A' | 'B', Seed> = { A: {}, B: {} };
  let snapshot0: Record<'A' | 'B', Record<string, string>>;
  const as = (who: 'A' | 'B', fn: () => any): Promise<any> => prisma.runAsTenant(T[who].id, fn);
  const otherOf = (who: 'A' | 'B') => (who === 'A' ? 'B' : 'A') as 'A' | 'B';
  const count = (who: 'A' | 'B', m: string) => seeded[who][m].length;
  const idWhere = (m: string, r: Row) => (pkField(m) === 'tenantId' ? { tenantId: r.tenantId } : { id: r.id });
  const baseWhere = (m: string, tid: string): any => (m === 'Tenant' ? { id: tid } : { tenantId: tid });

  async function snap(who: 'A' | 'B') {
    const out: Record<string, string> = {};
    for (const m of MODELS) {
      out[m] = JSON.stringify(await (base as any)[lc(m)].findMany({ where: baseWhere(m, T[who].id), orderBy: { [pkField(m)]: 'asc' } }), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    }
    return out;
  }

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    base = prisma.base;
    db = prisma.db;
    // Tenants are provisioned out-of-band (superadmin path); everything inside them is written AS the tenant.
    for (const k of ['A', 'B'] as const) {
      const s = uniq('gate');
      T[k] = await base.tenant.create({ data: { name: `Gate ${k}`, slug: s, subdomain: s, address: `addr-${k}`, whatsappNumber: `wa-${k}` } });
      seeded[k].Tenant = [T[k]];
    }
    for (const k of ['A', 'B'] as const) {
      for (const m of SEED_ORDER) {
        const n = SINGLE_ROW.has(m) ? 1 : k === 'A' ? 2 : 3;
        seeded[k][m] = [];
        for (let i = 0; i < n; i++) seeded[k][m].push(await as(k, () => factories[m](db, seeded[k], i)));
      }
    }
    snapshot0 = { A: await snap('A'), B: await snap('B') };
  });

  afterAll(async () => {
    await base.user.deleteMany({ where: { tenantId: null, email: { endsWith: '@gate-platform.test' } } });
    await deleteTenants(base, [T.A?.id, T.B?.id].filter(Boolean));
    await app.close();
  });

  // ------------------------------------------------------------------------------------------------
  describe('coverage (the list of models comes from the Prisma schema, not from this file)', () => {
    it('every model is classified in SCOPES, and every model with a tenant_id column is scoped directly on it', () => {
      for (const m of MODELS) expect(SCOPES[m]).toBeDefined();
      for (const m of MODELS) {
        if (hasField(m, 'tenantId')) expect(SCOPES[m].kind).toBe('direct');
      }
      expect(Object.keys(SCOPES).sort()).toEqual([...MODELS].sort());
      // The only model allowed to lack a tenantId column is the tenants table itself.
      expect(MODELS.filter((m) => !hasField(m, 'tenantId'))).toEqual(['Tenant']);
      expect(SCOPES.Tenant.kind).toBe('self');
    });
    it('every model has a seed factory + attack metadata, and both tenants have rows in every model', () => {
      for (const m of MODELS) {
        expect(META[m]).toBeDefined();
        expect(factories[m]).toBeDefined();
        for (const k of ['A', 'B'] as const) expect(seeded[k][m].length).toBeGreaterThan(0);
      }
      expect(MODELS).toHaveLength(16);
    });
    it('money is integer paise everywhere: no Float/Decimal field in any model', () => {
      for (const m of DMMF_MODELS) for (const f of m.fields) expect(`${m.name}.${f.name}:${f.type}`).not.toMatch(/:(Float|Decimal)$/);
    });
    it('static check: only allowlisted files may touch the UNSCOPED client (prisma.base)', () => {
      // `base` is the escape hatch used by tenant resolution (pre-context), the audit writer and the extension.
      // Feature code must use `prisma.db`. Adding a file here requires a deliberate edit + review.
      const ALLOW = new Set([
        'prisma/prisma.service.ts', 'prisma/tenant-scope.ts', 'tenancy/tenant-resolver.service.ts', 'superadmin/tenants.service.ts',
        'media/media-worker.ts', // claims queued images across tenants (one SKIP LOCKED update); processing runs inside runAsTenant
      ]);
      const root = join(__dirname, '..', 'src');
      const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
      const offenders = walk(root)
        .filter((f) => f.endsWith('.ts'))
        .filter((f) => /\.base\b/.test(readFileSync(f, 'utf8')))
        .map((f) => f.slice(root.length + 1))
        .filter((f) => !ALLOW.has(f));
      expect(offenders).toEqual([]);
    });
    it('the scoped client has no tenant-bypassing surface left (raw SQL disabled)', () => {
      for (const f of ['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe']) expect(() => db[f]('select 1')).toThrow(/disabled/);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe.each(MODELS)('%s', (m) => {
    const D = lc(m);
    const meta = META[m];

    describe.each([['A', 'B'], ['B', 'A']] as const)('%s attacking %s', (me, other) => {
      const mine = () => seeded[me][m];
      const theirs = () => seeded[other][m];

      it('READ: sees only its own rows through every read operation and filter shape', async () => {
        const ids = (rows: Row[]) => rows.map((r) => r[pkField(m)]).sort();
        expect(ids(await as(me, () => db[D].findMany()))).toEqual(ids(mine()));
        expect(await as(me, () => db[D].count())).toBe(count(me, m));
        expect((await as(me, () => db[D].aggregate({ _count: { _all: true } })))._count._all).toBe(count(me, m));
        const grouped = await as(me, () => db[D].groupBy({ by: [pkField(m)], _count: { _all: true } }));
        expect(grouped.map((g: Row) => g[pkField(m)]).sort()).toEqual(ids(mine()));

        for (const r of theirs()) {
          const w = idWhere(m, r);
          expect(await as(me, () => db[D].findMany({ where: w }))).toEqual([]);
          expect(await as(me, () => db[D].findFirst({ where: w }))).toBeNull();
          expect(await as(me, () => db[D].findUnique({ where: w }))).toBeNull();
          expect(await as(me, () => db[D].count({ where: w }))).toBe(0);
          expectBlocked(await rejection(as(me, () => db[D].findUniqueOrThrow({ where: w }))), 'P2025');
          expectBlocked(await rejection(as(me, () => db[D].findFirstOrThrow({ where: w }))), 'P2025');
          // trying to widen the filter must not help: still only my own rows
          expect((await as(me, () => db[D].findMany({ where: { OR: [w, { NOT: w }] } }))).length).toBe(count(me, m));
          if (meta.compound) {
            expect(await as(me, () => db[D].findUnique({ where: meta.compound!(r) }))).toBeNull();
          }
        }
        if (hasField(m, 'tenantId')) {
          const o = T[other].id;
          expect(await as(me, () => db[D].findMany({ where: { tenantId: o } }))).toEqual([]);
          expect(await as(me, () => db[D].findMany({ where: { OR: [{ tenantId: o }, { tenantId: T[me].id }] } })).then((x: Row[]) => x.length)).toBe(count(me, m));
          expect(await as(me, () => db[D].findMany({ where: { NOT: { tenantId: T[me].id } } }))).toEqual([]);
          expect(await as(me, () => db[D].findMany({ where: { tenantId: { in: [o] } } }))).toEqual([]);
          if (hasField(m, 'tenant')) expect(await as(me, () => db[D].findMany({ where: { tenant: { id: o } } }))).toEqual([]);
          expect(await as(me, () => db[D].findFirst({ where: { tenantId: o } }))).toBeNull();
          expect(await as(me, () => db[D].count({ where: { tenantId: o } }))).toBe(0);
        }
        if (m === 'Variant') {
          expect(await as(me, () => db.variant.findMany({ where: { productId: { in: seeded[other].Product.map((p) => p.id) } } }))).toEqual([]);
          expect(await as(me, () => db.variant.findMany({ where: { product: { tenantId: T[other].id } } }))).toEqual([]);
        }
        if (m === 'Tenant') {
          expect(await as(me, () => db.tenant.findMany({ where: { slug: T[other].slug } }))).toEqual([]);
          expect(await as(me, () => db.tenant.findUnique({ where: { subdomain: T[other].subdomain } }))).toBeNull();
        }
      });

      it('READ: relation traversal (include) never returns the other tenant\'s rows', async () => {
        const myProducts = new Set(seeded[me].Product.map((p) => p.id));
        const check = (v: any) => {
          if (Array.isArray(v)) return v.forEach(check);
          if (!v || typeof v !== 'object' || v instanceof Date) return;
          if ('tenantId' in v && v.tenantId !== null) expect(v.tenantId).toBe(T[me].id);
          if ('subdomain' in v && 'slug' in v) expect(v.id).toBe(T[me].id); // a tenants row can only be my own
          if ('productId' in v && 'optionName' in v) expect(myProducts.has(v.productId)).toBe(true);
          Object.values(v).forEach(check);
        };
        const rels = modelDef(m).fields.filter((f) => f.kind === 'object').map((f) => f.name);
        for (const rel of rels) check(await as(me, () => db[D].findMany({ include: { [rel]: true } })));
        if (rels.length) check(await as(me, () => db[D].findMany({ include: Object.fromEntries(rels.map((r) => [r, true])) })));
      });

      it('UNIQUE-KEY WRITES: cannot update / delete / upsert over the other tenant\'s rows', async () => {
        for (const r of theirs()) {
          const sel = [idWhere(m, r), ...(meta.compound ? [meta.compound(r)] : [])];
          for (const where of sel) {
            expectBlocked(await rejection(as(me, () => db[D].update({ where, data: meta.touch }))), 'P2025');
            expectBlocked(await rejection(as(me, () => db[D].delete({ where }))), 'P2025');
          }
          // upsert whose create reuses the victim's primary key: if the lookup ever reached the victim row it would
          // UPDATE it; since it can't, it tries to INSERT and collides on the key (P2002) - proving it found nothing.
          const w = idWhere(m, r);
          if (m === 'Tenant') {
            expectBlocked(await rejection(as(me, () => db.tenant.upsert({ where: w, update: meta.touch, create: { name: 'x', slug: rnd(), subdomain: rnd() } }))));
          } else if (m === 'AuditLog') {
            expectBlocked(await rejection(as(me, () => db.auditLog.upsert({ where: w, update: meta.touch, create: { id: r.id, action: 'x' } }))));
          } else {
            const create = await dataFor(m, seeded[me], 77, pkField(m) === 'id' ? { id: r.id } : {});
            expectBlocked(await rejection(as(me, () => db[D].upsert({ where: w, update: meta.touch, create }))), 'P2002');
          }
        }
      });

      it('FILTERED BULK WRITES: updateMany / deleteMany aimed at the other tenant affect 0 rows', async () => {
        for (const r of theirs()) {
          const w = idWhere(m, r);
          if (!meta.updateBlocked) {
            expect((await as(me, () => db[D].updateMany({ where: w, data: meta.touch }))).count).toBe(0);
            if (hasField(m, 'tenantId')) expect((await as(me, () => db[D].updateMany({ where: { tenantId: T[other].id }, data: meta.touch }))).count).toBe(0);
          } else {
            expectBlocked(await rejection(as(me, () => db[D].updateMany({ where: w, data: meta.touch }))));
          }
          if (!meta.deleteBlocked) {
            expect((await as(me, () => db[D].deleteMany({ where: w }))).count).toBe(0);
            if (hasField(m, 'tenantId')) expect((await as(me, () => db[D].deleteMany({ where: { tenantId: T[other].id } }))).count).toBe(0);
          } else {
            expectBlocked(await rejection(as(me, () => db[D].deleteMany({ where: w }))));
          }
        }
      });

      it('UNFILTERED BULK WRITES: updateMany({}) / deleteMany({}) touch exactly its own rows (rolled back)', async () => {
        const ROLLBACK = 'ROLLBACK_SENTINEL';
        if (!meta.updateBlocked) {
          await expect(
            as(me, () => db.$transaction(async (tx: any) => {
              const r = await tx[D].updateMany({ data: meta.touch });
              expect(r.count).toBe(count(me, m)); // would be own+other if scoping failed
              throw new Error(ROLLBACK);
            })),
          ).rejects.toThrow(ROLLBACK);
        } else {
          expectBlocked(await rejection(as(me, () => db[D].updateMany({ data: meta.touch }))));
        }
        if (!meta.deleteBlocked) {
          await expect(
            as(me, () => db.$transaction(async (tx: any) => {
              for (const dep of meta.before ?? []) await tx[dep].deleteMany({});
              const r = await tx[D].deleteMany({});
              expect(r.count).toBe(count(me, m));
              throw new Error(ROLLBACK);
            })),
          ).rejects.toThrow(ROLLBACK);
        } else {
          expectBlocked(await rejection(as(me, () => db[D].deleteMany({}))));
        }
      });

      it('CREATE: cannot write into the other tenant (foreign tenantId / product / FK reference)', async () => {
        if (meta.createBlocked) {
          expectBlocked(await rejection(as(me, () => db[D].create({ data: { name: 'x', slug: rnd(), subdomain: rnd() } }))));
          expectBlocked(await rejection(as(me, () => db[D].createMany({ data: [{ name: 'x', slug: rnd(), subdomain: rnd() }] }))));
          return;
        }

        if (hasField(m, 'tenantId')) {
          const data = await dataFor(m, seeded[me], 60, { tenantId: T[other].id });
          expectBlocked(await rejection(as(me, () => db[D].create({ data }))));
          expectBlocked(await rejection(as(me, () => db[D].createMany({ data: [data] }))));
          expectBlocked(await rejection(as(me, () => db[D].createManyAndReturn({ data: [data] }))));
          expectBlocked(await rejection(as(me, () => db[D].upsert({ where: idWhere(m, theirs()[0]), update: {}, create: data }))));
        }
        if (m === 'Variant') {
          // a variant of the other tenant's product: the composite (tenant_id, product_id) FK refuses it in the database
          const data = await dataFor(m, seeded[me], 60, { productId: seeded[other].Product[0].id });
          expectBlocked(await rejection(as(me, () => db.variant.create({ data }))), 'P2003');
          expectBlocked(await rejection(as(me, () => db.variant.createMany({ data: [data] }))), 'P2003');
          // and cannot re-parent its own variant under the other tenant's product
          expectBlocked(await rejection(as(me, () => db.variant.update({ where: { id: mine()[0].id }, data: { productId: seeded[other].Product[0].id } }))), 'P2003');
          expectBlocked(await rejection(as(me, () => db.variant.updateMany({ data: { productId: seeded[other].Product[0].id } }))), 'P2003');
        }
        if (hasField(m, 'tenantId') && !SINGLE_ROW.has(m)) {
          // cannot MOVE its own row to the other tenant
          expectBlocked(await rejection(as(me, () => db[D].update({ where: idWhere(m, mine()[0]), data: { tenantId: T[other].id } }))));
          expectBlocked(await rejection(as(me, () => db[D].updateMany({ data: { tenantId: T[other].id } }))));
        }
        if (meta.crossRef) {
          // scalar FK -> other tenant's row: the composite (tenant_id, id) foreign key must refuse
          const err = await rejection(as(me, () => meta.crossRef!(db, seeded[me], seeded[other])));
          expect(err.code).toBe('P2003');
        }
      });

      it('NESTED WRITES: connect / connectOrCreate / set to the other tenant\'s rows are refused', async () => {
        for (const f of modelDef(m).fields.filter((x) => x.kind === 'object')) {
          const target = f.type;
          if (!seeded[other][target]) continue;
          const victim = seeded[other][target][0];
          const connect = { connect: idWhere(target, victim) };
          if (!f.isList) {
            if (m !== 'Tenant' && !meta.updateBlocked) {
              expectBlocked(await rejection(as(me, () => db[D].update({ where: idWhere(m, mine()[0]), data: { [f.name]: connect } }))));
            }
          } else if (m !== 'Tenant' && !meta.updateBlocked) {
            expectBlocked(await rejection(as(me, () => db[D].update({ where: idWhere(m, mine()[0]), data: { [f.name]: { connect: [idWhere(target, victim)] } } }))));
            expectBlocked(await rejection(as(me, () => db[D].update({ where: idWhere(m, mine()[0]), data: { [f.name]: { set: [idWhere(target, victim)] } } }))));
          }
        }
      });
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe.each(['A', 'B'] as const)('tenant %s cannot escalate its own tenants row', (me) => {
    it.each([
      ['plan', { plan: 'STANDARD' }], ['status', { status: 'LIVE' }], ['expiresAt', { expiresAt: null }],
      ['expiresAt (future)', { expiresAt: new Date('2099-01-01') }], ['slug', { slug: 'taken-over' }], ['subdomain', { subdomain: 'taken-over' }],
      ['customDomain', { customDomain: 'evil.example.com' }], ['id', { id: randomUUID() }],
    ])('update of %s is refused (single, upsert-free, bulk)', async (_n, data) => {
      expectBlocked(await rejection(as(me, () => db.tenant.update({ where: { id: T[me].id }, data }))));
      expectBlocked(await rejection(as(me, () => db.tenant.updateMany({ data }))));
    });
    it('may still edit its own profile fields', async () => {
      await as(me, () => db.tenant.update({ where: { id: T[me].id }, data: { address: `addr-${me}` } })); // unchanged value: keeps the final snapshot identical
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('no context / platform scope / bypass', () => {
    const OPS: Array<[string, (d: any) => any]> = [
      ['findMany', (d) => d.findMany()], ['findFirst', (d) => d.findFirst()], ['findUnique', (d) => d.findUnique({ where: {} })],
      ['count', (d) => d.count()], ['aggregate', (d) => d.aggregate({ _count: true })], ['groupBy', (d) => d.groupBy({ by: ['id'] })],
      ['create', (d) => d.create({ data: {} })], ['createMany', (d) => d.createMany({ data: [] })], ['update', (d) => d.update({ where: {}, data: {} })],
      ['updateMany', (d) => d.updateMany({ data: {} })], ['upsert', (d) => d.upsert({ where: {}, create: {}, update: {} })],
      ['delete', (d) => d.delete({ where: {} })], ['deleteMany', (d) => d.deleteMany()],
    ];
    it.each(MODELS)('%s: every operation fails closed with no tenant context', async (m) => {
      for (const [name, run] of OPS) {
        const e = await rejection(Promise.resolve().then(() => run(db[lc(m)])));
        if (!(e instanceof TenantIsolationError)) throw new Error(`${m}.${name} without context did not fail closed: ${e?.name} ${String(e?.message).slice(0, 120)}`);
      }
    });

    it('platform scope: only models with nullable tenant_id, and only NULL-tenant rows; tenant rows invisible', async () => {
      const email = `root-${rnd()}@gate-platform.test`;
      const sa: any = await prisma.asSystem<any>('gate:create-superadmin', () => db.user.create({ data: { email, passwordHash: 'x', role: 'superadmin' } }));
      await prisma.asSystem('gate:create-token', () => db.refreshToken.create({ data: { userId: sa.id, familyId: randomUUID(), tokenHash: `p-${rnd()}`, expiresAt: new Date(Date.now() + 1e6) } }));
      await prisma.asSystem('gate:create-reset-token', () => db.passwordResetToken.create({ data: { userId: sa.id, tokenHash: `pr-${rnd()}`, expiresAt: new Date(Date.now() + 1e6) } }));
      for (const m of MODELS) {
        const nullable = SCOPES[m].kind === 'direct' && (SCOPES[m] as any).nullable;
        const p = prisma.asPlatform<any>(() => db[lc(m)].findMany());
        if (nullable) {
          const rows = await p;
          expect(rows.length).toBeGreaterThan(0);
          for (const r of rows) expect(r.tenantId).toBeNull();
        } else {
          expectBlocked(await rejection(p));
        }
      }
      // creating inside platform scope can only ever produce NULL-tenant rows
      const t: any = await prisma.asPlatform<any>(() => db.auditLog.create({ data: { action: 'gate.platform' } }));
      expect(t.tenantId).toBeNull();
      expectBlocked(await rejection(prisma.asPlatform(() => db.user.create({ data: { email: `x-${rnd()}@gate-platform.test`, passwordHash: 'x', role: 'staff', tenantId: T.A.id } }))));
    });

    it('superadmin bypass: sees both tenants in every model, and EVERY operation writes an audit row', async () => {
      const actor = { id: randomUUID(), role: 'superadmin' as const, tenantId: null };
      expect(() => prisma.asSuperadmin({ ...actor, role: 'store_owner' }, 'nope', async () => 1)).toThrow();
      for (const m of MODELS) {
        const before = await base.auditLog.count({ where: { actorId: actor.id } });
        const rows: Row[] = await prisma.asSuperadmin<any>(actor, `gate:read-${m}`, () => db[lc(m)].findMany());
        const after = await base.auditLog.count({ where: { actorId: actor.id } });
        expect(after - before).toBe(1);
        const ids = new Set(rows.map((r: Row) => r[pkField(m)]));
        for (const k of ['A', 'B'] as const) for (const r of seeded[k][m]) expect(ids.has(r[pkField(m)])).toBe(true);
      }
      const last = await base.auditLog.findFirst({ where: { actorId: actor.id }, orderBy: { createdAt: 'desc' } });
      expect(last).toMatchObject({ action: 'db.AuditLog.findMany' });
      expect((last!.meta as any).reason).toBe('gate:read-AuditLog');
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('HTTP ROUTES: every /store route is tenant-bound (inventory comes from the router, not from this file)', () => {
    let ownerA: string, ownerB: string, emailA: string, emailB: string;
    const api = () => request(app.getHttpServer());
    const hostA = () => `${T.A.subdomain}.localhost`;
    const hostB = () => `${T.B.subdomain}.localhost`;
    const PW = 'correct-horse-battery';
    interface Route { method: string; path: string }
    let routes: Route[] = [];

    beforeAll(async () => {
      const auth = app.get(AuthService);
      const hash = await auth.hashPassword(PW);
      emailA = `owner-${rnd()}@gate-routes.test`; emailB = `owner-${rnd()}@gate-routes.test`;
      await as('A', () => db.user.create({ data: { email: emailA, passwordHash: hash, role: 'store_owner' } }));
      await as('B', () => db.user.create({ data: { email: emailB, passwordHash: hash, role: 'store_owner' } }));
      ownerA = (await api().post('/auth/login').set('Host', hostA()).send({ email: emailA, password: PW }).expect(200)).body.accessToken;
      ownerB = (await api().post('/auth/login').set('Host', hostB()).send({ email: emailB, password: PW }).expect(200)).body.accessToken;
      // Express 5 (Nest 11) exposes the router lazily as app.router; Express 4 as app._router.
      const ex: any = app.getHttpAdapter().getInstance();
      const stack: any[] = (ex.router ?? ex._router)?.stack ?? [];
      routes = stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).filter((m) => l.route.methods[m]).map((m) => ({ method: m.toUpperCase(), path: l.route.path as string })));
    });
    afterAll(async () => {
      // cascades their refresh tokens too, so the final snapshot stays identical
      await base.user.deleteMany({ where: { email: { in: [emailA, emailB] } } });
    });

    const fill = (path: string) => path.replace(/:(\w+)/g, () => randomUUID());
    const storeRoutes = () => routes.filter((r) => r.path.startsWith('/store/') && r.path !== '/store/public');
    const call = (r: Route, host: string, tok?: string) => {
      let req = (api() as any)[r.method.toLowerCase()](fill(r.path)).set('Host', host);
      if (tok) req = req.set('Authorization', `Bearer ${tok}`);
      return r.method === 'GET' || r.method === 'DELETE' ? req : req.set('Content-Type', 'application/json').send({});
    };

    it('the router lists the admin surface (sanity: the inventory is real)', () => {
      expect(storeRoutes().length).toBeGreaterThanOrEqual(50); // 54 at the time of writing; the matrix below runs over whatever exists
      for (const prefix of ['/store/products', '/store/categories', '/store/orders', '/store/customers', '/store/coupons', '/store/pages', '/store/settings', '/store/theme', '/store/media', '/store/import/products', '/store/usage', '/store/dashboard', '/store/profile']) {
        expect(storeRoutes().some((r) => r.path.startsWith(prefix))).toBe(true);
      }
    });

    it('anonymous -> 401, the other store\'s owner on this host -> 403, this owner on the other host -> 403, on every store route', async () => {
      const failures: string[] = [];
      for (const r of storeRoutes()) {
        const anon = await call(r, hostA());
        const foreign = await call(r, hostA(), ownerB);
        const wrongHost = await call(r, hostB(), ownerA);
        if (anon.status !== 401) failures.push(`${r.method} ${r.path} anonymous -> ${anon.status}`);
        if (foreign.status !== 403) failures.push(`${r.method} ${r.path} B's token on A -> ${foreign.status}`);
        if (wrongHost.status !== 403) failures.push(`${r.method} ${r.path} A's token on B -> ${wrongHost.status}`);
      }
      expect(failures).toEqual([]);
    });

    it('superadmin routes refuse store owners everywhere', async () => {
      const sa = routes.filter((r) => r.path.startsWith('/superadmin/'));
      expect(sa.length).toBeGreaterThanOrEqual(8);
      for (const r of sa) {
        expect((await call(r, 'admin.localhost', ownerA)).status).toBe(403);
        expect((await call(r, hostA(), ownerA)).status).toBe(403);
      }
    });

    it("A's owner, on A's host, cannot reach any of B's rows through any admin route (404s, never 200)", async () => {
      const B = seeded.B;
      const me = (m: 'get' | 'patch' | 'delete' | 'post', path: string, body?: any) => {
        let req = (api() as any)[m](path).set('Host', hostA()).set('Authorization', `Bearer ${ownerA}`);
        return body !== undefined ? req.send(body) : req;
      };
      const probes: Array<[string, Promise<request.Response>, number]> = [
        ['GET product', me('get', `/store/products/${B.Product[0].id}`), 404],
        ['PATCH product', me('patch', `/store/products/${B.Product[0].id}`, { name: 'pwn' }), 404],
        ['PATCH stock', me('patch', `/store/products/${B.Product[0].id}/stock`, { stock: 0 }), 404],
        ['DELETE product', me('delete', `/store/products/${B.Product[0].id}`), 404],
        ['POST variant on B product', me('post', `/store/products/${B.Product[0].id}/variants`, { optionName: 'x', optionValue: 'y' }), 404],
        ['PATCH B variant under A product', me('patch', `/store/products/${seeded.A.Product[0].id}/variants/${B.Variant[0].id}`, { stock: 0 }), 404],
        ['DELETE B variant under A product', me('delete', `/store/products/${seeded.A.Product[0].id}/variants/${B.Variant[0].id}`), 404],
        ['bulk B ids', me('post', '/store/products/bulk', { ids: B.Product.map((p: Row) => p.id), action: 'ARCHIVE' }), 200],
        ['GET category', me('get', `/store/categories/${B.Category[0].id}`), 404],
        ['PATCH category', me('patch', `/store/categories/${B.Category[0].id}`, { name: 'pwn' }), 404],
        ['DELETE category', me('delete', `/store/categories/${B.Category[0].id}`), 404],
        ['product into B category', me('post', '/store/products', { name: 'x', price: 1, mrp: 1, categoryId: B.Category[0].id }), 400],
        ['GET order', me('get', `/store/orders/${B.Order[0].id}`), 404],
        ['order status', me('post', `/store/orders/${B.Order[0].id}/status`, { status: 'CONFIRMED' }), 404],
        ['order mark-paid', me('post', `/store/orders/${B.Order[0].id}/mark-paid`), 404],
        ['order payment', me('post', `/store/orders/${B.Order[0].id}/payment-status`, { status: 'PAID' }), 404],
        ['GET customer', me('get', `/store/customers/${B.Customer[0].id}`), 404],
        ['PATCH customer', me('patch', `/store/customers/${B.Customer[0].id}`, { name: 'pwn' }), 404],
        ['GET coupon', me('get', `/store/coupons/${B.Coupon[0].id}`), 404],
        ['DELETE coupon', me('delete', `/store/coupons/${B.Coupon[0].id}`), 404],
        ['GET page', me('get', `/store/pages/${B.Page[0].id}`), 404],
        ['PATCH page', me('patch', `/store/pages/${B.Page[0].id}`, { title: 'pwn' }), 404],
        ['GET media', me('get', `/store/media/${B.Media[0].id}`), 404],
        ['DELETE media', me('delete', `/store/media/${B.Media[0].id}`), 404],
      ];
      const failures: string[] = [];
      for (const [name, p, expected] of probes) {
        const r = await p;
        if (r.status !== expected) failures.push(`${name} -> ${r.status} (expected ${expected})`);
      }
      expect(failures).toEqual([]);
      // the bulk action reported 0 rows touched
      expect((await me('post', '/store/products/bulk', { ids: B.Product.map((p: Row) => p.id), action: 'ARCHIVE' })).body.affected).toBe(0);
      // listing never leaks: every id returned belongs to A
      for (const [path, model] of [['/store/products?pageSize=100', 'Product'], ['/store/orders?pageSize=100', 'Order'], ['/store/customers?pageSize=100', 'Customer'], ['/store/coupons?pageSize=100', 'Coupon'], ['/store/pages?pageSize=100', 'Page'], ['/store/media?pageSize=100', 'Media']] as const) {
        const items: Row[] = (await me('get', path).expect(200)).body.items;
        const mine = new Set(seeded.A[model].map((r: Row) => r.id));
        const theirs = new Set(seeded.B[model].map((r: Row) => r.id));
        expect(items.some((i) => theirs.has(i.id))).toBe(false);
        expect(items.filter((i) => mine.has(i.id)).length).toBe(seeded.A[model].length);
      }
      const cats: Row[] = (await me('get', '/store/categories').expect(200)).body.items;
      expect(cats.some((c) => seeded.B.Category.some((b: Row) => b.id === c.id))).toBe(false);
    });

    it('MEDIA PATHS: keys are tenant-prefixed, B\'s media URLs/ids are refused on A\'s products, categories, theme, uploads and imports', async () => {
      const me = (m: 'get' | 'patch' | 'put' | 'delete' | 'post', path: string, body?: any) => {
        let req = (api() as any)[m](path).set('Host', hostA()).set('Authorization', `Bearer ${ownerA}`);
        return body !== undefined ? req.send(body) : req;
      };
      const bUrl = `https://cdn.example.test/tenants/${T.B.id}/product/2026/11/x.webp`;
      expect((await me('post', '/store/products', { name: 'x', price: 1, mrp: 1, images: [bUrl] })).status).toBe(400);
      expect((await me('patch', `/store/products/${seeded.A.Product[0].id}`, { images: [bUrl] })).status).toBe(400);
      expect((await me('post', '/store/categories', { name: 'x', image: bUrl })).status).toBe(400);
      expect((await me('put', '/store/theme', { logoUrl: bUrl })).status).toBe(400);
      expect((await me('put', '/store/theme', { bannerUrls: [bUrl] })).status).toBe(400);
      // presigned keys always sit under tenants/<A>/
      const pre = await me('post', '/store/media/presign', { files: [{ filename: 'gate.jpg', contentType: 'image/jpeg', size: 10 }] }).expect(200);
      const f = pre.body.files[0];
      expect(new URL(f.uploadUrl).pathname).toContain(`/tenants/${T.A.id}/originals/`);
      expect(new URL(f.uploadUrl).pathname).not.toContain(T.B.id);
      expect((await me('post', '/store/uploads/presign', { kind: 'product', contentType: 'image/jpeg', size: 10 }).expect(200)).body.key.startsWith(`tenants/${T.A.id}/`)).toBe(true);
      // completing B's ids: unknown, never touched
      const done = await me('post', '/store/media/complete', { ids: seeded.B.Media.map((m: Row) => m.id) }).expect(200);
      expect(done.body.results.every((r: Row) => r.status === 'NOT_FOUND')).toBe(true);
      // import cannot attach B's image filename (B's READY media are invisible from A)
      const csv = `name,price,mrp,image_filename\r\nGate,1,1,${seeded.B.Media[0].filename}\r\n`;
      const imp = await me('post', '/store/import/products?filename=g.csv&dryRun=true').set('Content-Type', 'text/csv').send(csv).expect(200);
      expect(imp.body.warnings.some((w: Row) => /has not been uploaded yet/.test(w.reason))).toBe(true);
      // clean up our own pending row so the final snapshot is unchanged
      await me('delete', `/store/media/${f.id}`).expect(204);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('HTTP layer: a store token never works on another store', () => {
    it('A\'s owner token is rejected on B\'s host for every store route; B\'s data is untouched', async () => {
      const auth = app.get(AuthService);
      const email = `owner-${rnd()}@gate-http.test`;
      const pw = 'correct-horse-battery';
      await as('A', async () => db.user.create({ data: { email, passwordHash: await auth.hashPassword(pw), role: 'store_owner' } }));
      const api = () => request(app.getHttpServer());
      const hostA = `${T.A.subdomain}.localhost`, hostB = `${T.B.subdomain}.localhost`;
      const tok = (await api().post('/auth/login').set('Host', hostA).send({ email, password: pw }).expect(200)).body.accessToken;
      await api().get('/store/me').set('Host', hostA).set('Authorization', `Bearer ${tok}`).expect(200);
      await api().get('/store/me').set('Host', hostB).set('Authorization', `Bearer ${tok}`).expect(403);
      await api().get('/store/razorpay').set('Host', hostB).set('Authorization', `Bearer ${tok}`).expect(403);
      await api().put('/store/razorpay').set('Host', hostB).set('Authorization', `Bearer ${tok}`).send({ keyId: 'rzp_live_AbCdEf123456', keySecret: 'SuperSecretValue123' }).expect(403);
      await api().get('/superadmin/tenants').set('Host', hostA).set('Authorization', `Bearer ${tok}`).expect(403);
      await api().post('/auth/login').set('Host', hostB).send({ email, password: pw }).expect(401);
      const b = await base.tenant.findUnique({ where: { id: T.B.id } });
      expect(b!.razorpayKeyEnc).toBeNull();
      await base.user.delete({ where: { tenantId_email: { tenantId: T.A.id, email } } });
    });
  });


  // ------------------------------------------------------------------------------------------------
  describe('DATABASE LAYER: row-level security holds even when the app layer is bypassed', () => {
    /** The application role with NO extension and NO scoping at all: this is "the Prisma layer is gone". */
    let raw: any;
    const table = (m: string) => modelDef(m).dbName ?? m;
    const expectRls = (err: any) => {
      if (!/row-level security/.test(String(err?.message))) throw new Error(`Expected a row-level security rejection, got: ${err?.name} ${err?.code} ${String(err?.message).slice(0, 200)}`);
    };
    /** Pin a scope on a fresh transaction exactly as the extension does, then run unscoped work inside it. */
    const pinned = (tenantId: string | null, platform: boolean, fn: (tx: any) => Promise<any>) =>
      raw.$transaction(async (tx: any) => { await pinScope(tx, tenantId, platform); return fn(tx); });
    const ids = (rows: Row[], m: string) => rows.map((r) => r[pkField(m)]).sort();

    beforeAll(async () => { raw = new PrismaClient(); await raw.$connect(); });
    afterAll(async () => { await raw.$disconnect(); });

    it('the application role cannot sidestep RLS, and every model table has RLS enabled with a policy', async () => {
      const r = await roleFacts(raw);
      expect(r).toMatchObject({ superuser: false, bypassRls: false, ownedTables: [] });
      const t = await tableFacts(base);
      expect(t.map((x) => x.table).sort()).toEqual(MODELS.map(table).sort());
      for (const x of t) expect(x).toMatchObject({ rlsEnabled: true, policies: expect.any(Number) });
      for (const x of t) expect(x.policies).toBeGreaterThan(0);
    });

    it.each(MODELS)('%s: with nothing pinned (app layer bypassed) the database shows and accepts NOTHING', async (m) => {
      const D = lc(m);
      expect(await raw[D].findMany()).toEqual([]);
      expect(await raw[D].count()).toBe(0);
      for (const k of ['A', 'B'] as const) for (const r of seeded[k][m]) expect(await raw[D].findUnique({ where: idWhere(m, r) })).toBeNull();
      expect((await raw[D].updateMany({ data: META[m].touch })).count).toBe(0);
      expect((await raw[D].deleteMany({})).count).toBe(0);
      const [{ n }] = await raw.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table(m)}"`);
      expect(n).toBe(0);
      expect(await raw.$executeRawUnsafe(`DELETE FROM "${table(m)}"`)).toBe(0);
      // inserting even a perfectly well-formed row of tenant A is refused: no pin, no rows
      const data = m === 'Tenant' ? { name: 'x', slug: rnd(), subdomain: rnd() } : await dataFor(m, seeded.A, 90, { tenantId: T.A.id });
      expectRls(await rejection(raw[D].create({ data })));
    });

    describe.each([['A', 'B'], ['B', 'A']] as const)('pinned as %s, attacking %s with unscoped Prisma and raw SQL', (me, other) => {
      it.each(MODELS)('%s', async (m) => {
        const D = lc(m);
        const meta = META[m];
        await pinned(T[me].id, false, async (tx) => {
          // an unscoped query is restricted to MY rows by the database alone
          expect(ids(await tx[D].findMany(), m)).toEqual(ids(seeded[me][m], m));
          for (const r of seeded[other][m]) {
            expect(await tx[D].findUnique({ where: idWhere(m, r) })).toBeNull();
            expect((await tx[D].updateMany({ where: idWhere(m, r), data: META[m].touch })).count).toBe(0);
            expect((await tx[D].deleteMany({ where: idWhere(m, r) })).count).toBe(0);
          }
          if (hasField(m, 'tenantId')) {
            expect(await tx[D].findMany({ where: { tenantId: T[other].id } })).toEqual([]);
            const [{ n }] = await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table(m)}" WHERE tenant_id = $1::uuid`, T[other].id);
            expect(n).toBe(0);
            expect(await tx.$executeRawUnsafe(`UPDATE "${table(m)}" SET tenant_id = tenant_id WHERE tenant_id = $1::uuid`, T[other].id)).toBe(0);
            expect(await tx.$executeRawUnsafe(`DELETE FROM "${table(m)}" WHERE tenant_id = $1::uuid`, T[other].id)).toBe(0);
          }
          if (m === 'Variant') {
            const [{ n }] = await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "variants" WHERE product_id = ANY($1::uuid[])`, seeded[other].Product.map((p) => p.id));
            expect(n).toBe(0);
          }
          if (m === 'Tenant') {
            expect(await tx.$executeRawUnsafe(`UPDATE "tenants" SET name = 'pwned' WHERE id = $1::uuid`, T[other].id)).toBe(0);
          }
        });
        // writing INTO the other tenant is refused by the policy's WITH CHECK (each in its own transaction: an error aborts it)
        if (m === 'Tenant') {
          expectRls(await rejection(pinned(T[me].id, false, (tx) => tx.tenant.create({ data: { name: 'x', slug: rnd(), subdomain: rnd() } }))));
        } else {
          const foreign = await dataFor(m, seeded[me], 91, { tenantId: T[other].id });
          expectRls(await rejection(pinned(T[me].id, false, (tx) => tx[D].create({ data: foreign }))));
          // ...and so is raw SQL (audit_logs is append-only, so its raw attack is an INSERT rather than a move)
          const rawWrite: [string, ...string[]] =
            m === 'AuditLog' ? [`INSERT INTO "audit_logs" (id, action, tenant_id) VALUES (gen_random_uuid(), 'gate.rls', $1::uuid)`, T[other].id]
            : [`UPDATE "${table(m)}" SET tenant_id = $1::uuid WHERE tenant_id = $2::uuid`, T[other].id, T[me].id];
          expectRls(await rejection(pinned(T[me].id, false, (tx) => tx.$executeRawUnsafe(...rawWrite))));
        }
        if (hasField(m, 'tenantId') && !SINGLE_ROW.has(m) && !meta.updateBlocked) {
          // moving my own row to the other tenant: the new row fails WITH CHECK (audit_logs: the append-only trigger fires first)
          expectRls(await rejection(pinned(T[me].id, false, (tx) => tx[D].updateMany({ where: idWhere(m, seeded[me][m][0]), data: { tenantId: T[other].id } }))));
        }
      });
    });

    it('platform pin: only tenant_id IS NULL rows of nullable tables; cannot write into a tenant', async () => {
      for (const m of MODELS) {
        const rows: Row[] = await pinned(null, true, (tx) => tx[lc(m)].findMany());
        const nullable = SCOPES[m].kind === 'direct' && (SCOPES[m] as any).nullable;
        if (nullable) for (const r of rows) expect(r.tenantId).toBeNull();
        else expect(rows).toEqual([]);
      }
      expectRls(await rejection(pinned(null, true, (tx) => tx.user.create({ data: { email: `x-${rnd()}@gate-platform.test`, passwordHash: 'x', role: 'staff', tenantId: T.A.id } }))));
      expectRls(await rejection(pinned(null, true, async (tx) => tx.product.create({ data: await dataFor('Product', seeded.A, 92, { tenantId: T.A.id }) }))));
    });

    it('the pin is transaction-local: nothing leaks to the next use of the pooled connection', async () => {
      for (let i = 0; i < 5; i++) {
        expect((await pinned(T.A.id, false, (tx) => tx.product.findMany())).length).toBe(count('A', 'Product'));
        expect(await raw.product.findMany()).toEqual([]);
        expect(await raw.user.findMany()).toEqual([]);
      }
    });

    it('the owner connection (prisma.base) is exempt, which is what the audited bypass relies on', async () => {
      const r = await roleFacts(base);
      expect(r.superuser || r.bypassRls || r.ownedTables.length === MODELS.length).toBe(true);
      expect((await base.product.findMany({ where: { tenantId: { in: [T.A.id, T.B.id] } } })).length).toBe(count('A', 'Product') + count('B', 'Product'));
    });
  });

  // ------------------------------------------------------------------------------------------------
  it('FINAL: after every attack above, both tenants\' data is byte-for-byte unchanged', async () => {
    const after = { A: await snap('A'), B: await snap('B') };
    for (const k of ['A', 'B'] as const) {
      for (const m of MODELS) {
        // AuditLog may legitimately gain rows via the platform/bypass checks above, but only with tenant_id NULL (not in A/B's snapshot)
        expect({ tenant: k, model: m, data: after[k][m] }).toEqual({ tenant: k, model: m, data: snapshot0[k][m] });
      }
    }
  });
});
