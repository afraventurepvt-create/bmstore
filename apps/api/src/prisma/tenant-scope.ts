import { Prisma, PrismaClient } from '@prisma/client';
import { RequestContext } from '../common/request-context';

/**
 * TENANT ISOLATION ENGINE
 * -----------------------
 * A Prisma client extension that wraps EVERY operation on EVERY model:
 *   - inside a tenant context  -> reads/writes are forced to that tenant (a developer cannot forget)
 *   - inside platform scope    -> only tenant_id IS NULL rows, only on models that allow it
 *   - inside an explicit bypass-> unscoped, but ALWAYS writes an audit_logs row first
 *   - with no context at all   -> throws (fail closed)
 *
 * Every model must be classified in SCOPES; the client refuses to build otherwise, so a new table
 * can never silently ship unscoped. The gate test enforces the same from the DMMF.
 */

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

export type Scope =
  | { kind: 'direct'; nullable?: boolean } // has a tenant_id column
  | { kind: 'self' } // the tenants table: row id == tenant id
  | { kind: 'viaProduct' }; // variants: scoped through product.tenant_id

export const SCOPES: Record<string, Scope> = {
  Tenant: { kind: 'self' },
  ThemeConfig: { kind: 'direct' },
  Category: { kind: 'direct' },
  Product: { kind: 'direct' },
  Variant: { kind: 'viaProduct' },
  Customer: { kind: 'direct' },
  Order: { kind: 'direct' },
  Coupon: { kind: 'direct' },
  Page: { kind: 'direct' },
  Settings: { kind: 'direct' },
  User: { kind: 'direct', nullable: true },
  RefreshToken: { kind: 'direct', nullable: true },
  AuditLog: { kind: 'direct', nullable: true },
};

/** Tenants may only edit these columns of their own tenant row. Plan/status/expiry/domains: superadmin only. */
const TENANT_SELF_WRITABLE = new Set([
  'name', 'address', 'gstNumber', 'supportPhone', 'whatsappNumber', 'razorpayKeyEnc', 'razorpaySecretEnc',
]);

/** audit_logs is append-only for tenant code. */
const APPEND_ONLY = new Set(['AuditLog']);

const UNIQUE_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']);
const FILTER_OPS = new Set([
  'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy',
  'updateMany', 'updateManyAndReturn', 'deleteMany',
]);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);
const KNOWN_OPS = new Set([...UNIQUE_OPS, ...FILTER_OPS, ...CREATE_OPS]);
const READ_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// ---- DMMF helpers ----------------------------------------------------------------------------
const MODELS = Prisma.dmmf.datamodel.models;
const RELATIONS = new Map<string, Map<string, string>>(
  MODELS.map((m) => [m.name, new Map(m.fields.filter((f) => f.kind === 'object').map((f) => [f.name, f.type]))]),
);

export function assertAllModelsClassified() {
  const missing = MODELS.map((m) => m.name).filter((n) => !SCOPES[n]);
  if (missing.length) throw new Error(`Models not classified in SCOPES (tenant isolation): ${missing.join(', ')}`);
}

// ---- audit meta ------------------------------------------------------------------------------
const SENSITIVE_KEY = /pass|secret|token|key|enc|hash|otp|card/i;
function redact(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.length > 120 ? v.slice(0, 120) + '…' : v;
  if (typeof v !== 'object') return v;
  if (v instanceof Date) return v.toISOString();
  if (depth >= 3) return '[depth]';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : redact(x, depth + 1)]),
  );
}

// ---- the extension ---------------------------------------------------------------------------
export function createScopedClient(base: PrismaClient) {
  assertAllModelsClassified();

  const ext: any = base.$extends({
    name: 'tenant-scope',
    client: {
      // Raw SQL bypasses model scoping entirely. Disabled on the scoped client; use `base` deliberately if ever needed.
      $queryRaw() { throw new TenantIsolationError('Raw queries are disabled on the tenant-scoped client'); },
      $queryRawUnsafe() { throw new TenantIsolationError('Raw queries are disabled on the tenant-scoped client'); },
      $executeRaw() { throw new TenantIsolationError('Raw queries are disabled on the tenant-scoped client'); },
      $executeRawUnsafe() { throw new TenantIsolationError('Raw queries are disabled on the tenant-scoped client'); },
    },
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          const store = RequestContext.get();

          // 1. Explicit, audited superadmin/system bypass.
          if (store?.bypass) {
            await writeAudit(base, store.bypass, model, operation, args);
            return query(args);
          }

          if (!KNOWN_OPS.has(operation)) throw new TenantIsolationError(`Operation ${model}.${operation} is not allowed`);
          const scope = SCOPES[model];
          if (!scope) throw new TenantIsolationError(`Model ${model} is not classified for tenant isolation`);

          // 2. Resolve the scope value from context. No context => fail closed.
          let val: string | null;
          if (store?.tenantId) val = store.tenantId;
          else if (store?.platform) {
            if (scope.kind !== 'direct' || !scope.nullable) {
              throw new TenantIsolationError(`Platform scope cannot access ${model}`);
            }
            val = null;
          } else {
            throw new TenantIsolationError(`No tenant context for ${model}.${operation}`);
          }

          if (APPEND_ONLY.has(model) && !CREATE_OPS.has(operation) && !READ_OPS.has(operation)) {
            throw new TenantIsolationError(`${model} is append-only`);
          }

          return query(await scopeArgs(model, scope, operation, args ?? {}, val));
        },
      },
    },
  });

  async function scopeArgs(model: string, scope: Scope, operation: string, args: any, val: string | null) {
    // Self (tenants table): no creating/deleting tenants from tenant code.
    if (scope.kind === 'self') {
      if (CREATE_OPS.has(operation) || operation === 'upsert' || operation === 'delete' || operation === 'deleteMany') {
        throw new TenantIsolationError(`Tenant code cannot ${operation} tenants`);
      }
      for (const d of arr(args.data)) {
        for (const k of Object.keys(d ?? {})) {
          if (!TENANT_SELF_WRITABLE.has(k)) throw new TenantIsolationError(`Tenant code cannot modify tenants.${k}`);
        }
      }
    }

    const frag = fragment(scope, val);
    const out = { ...args };

    // ---- where ----
    if (UNIQUE_OPS.has(operation)) {
      // Unique ops must keep their unique key at top level; our filter is ANDed next to it.
      const where = args.where ?? {};
      out.where = { ...where, AND: [...arr(where.AND), frag] };
    } else if (FILTER_OPS.has(operation)) {
      out.where = args.where ? { AND: [args.where, frag] } : frag;
    }

    // ---- data ----
    if (CREATE_OPS.has(operation)) {
      if (operation === 'create') out.data = await guardCreate(model, scope, args.data, val);
      else out.data = await Promise.all(arr(args.data).map((d: any) => guardCreate(model, scope, d, val)));
      if (operation === 'createMany' && !Array.isArray(args.data)) out.data = out.data[0];
      if (scope.kind === 'viaProduct') await assertProductsOwned(arr(out.data).map((d: any) => d.productId));
    } else if (operation === 'upsert') {
      out.create = await guardCreate(model, scope, args.create, val);
      out.update = await guardUpdate(model, scope, args.update, val);
      if (scope.kind === 'viaProduct') await assertProductsOwned([out.create.productId]);
    } else if (operation.startsWith('update')) {
      out.data = await guardUpdate(model, scope, args.data, val);
    }
    return out;
  }

  function fragment(scope: Scope, val: string | null) {
    switch (scope.kind) {
      case 'direct': return { tenantId: val };
      case 'self': return { id: val };
      case 'viaProduct': return { product: { tenantId: val } };
    }
  }

  async function guardCreate(model: string, scope: Scope, data: any, val: string | null) {
    if (!data || typeof data !== 'object') throw new TenantIsolationError(`${model}.create requires data`);
    checkNested(model, data, val);
    if (scope.kind === 'direct') {
      if ('tenant' in data) throw new TenantIsolationError(`${model}: pass scalars, not the tenant relation`);
      if (data.tenantId !== undefined && data.tenantId !== val) throw new TenantIsolationError(`${model}: tenantId does not match the active tenant`);
      return { ...data, tenantId: val };
    }
    if (scope.kind === 'viaProduct') {
      if ('product' in data) throw new TenantIsolationError('Variant: pass productId, not the product relation');
      if (typeof data.productId !== 'string') throw new TenantIsolationError('Variant: productId is required');
    }
    return data;
  }

  async function guardUpdate(model: string, scope: Scope, data: any, val: string | null) {
    if (!data || typeof data !== 'object') return data;
    checkNested(model, data, val);
    if (scope.kind === 'direct') {
      if ('tenant' in data) throw new TenantIsolationError(`${model}: cannot change tenant relation`);
      if (data.tenantId !== undefined && data.tenantId !== val) throw new TenantIsolationError(`${model}: cannot move rows between tenants`);
    }
    if (scope.kind === 'self' && 'id' in data) throw new TenantIsolationError('Cannot change tenant id');
    if (scope.kind === 'viaProduct') {
      if ('product' in data) throw new TenantIsolationError('Variant: pass productId, not the product relation');
      if (typeof data.productId === 'string') await assertProductsOwned([data.productId]);
      else if (data.productId !== undefined) throw new TenantIsolationError('Variant: invalid productId');
    }
    return data;
  }

  /** Variants carry no tenant_id: make sure every referenced product belongs to the active tenant. */
  async function assertProductsOwned(ids: string[]) {
    const unique = [...new Set(ids)];
    const found = await ext.product.findMany({ where: { id: { in: unique } }, select: { id: true } });
    if (found.length !== unique.length) throw new TenantIsolationError('Variant: product does not belong to the active tenant');
  }

  /**
   * Nested writes: connect/connectOrCreate/set could attach another tenant's row, so they are rejected on
   * relation fields (we walk relation fields only, via the DMMF, so Json content is never misread).
   * Nested create/update/delete operate beneath the parent, so they stay inside the parent's tenant.
   */
  function checkNested(model: string, data: any, val: string | null, depth = 0) {
    if (!data || typeof data !== 'object' || depth > 6) return;
    const rels = RELATIONS.get(model);
    if (!rels) return;
    for (const [field, value] of Object.entries(data)) {
      const target = rels.get(field);
      if (!target || !value || typeof value !== 'object') continue;
      const v = value as Record<string, any>;
      for (const bad of ['connect', 'connectOrCreate', 'set']) {
        if (bad in v) throw new TenantIsolationError(`${model}.${field}: nested "${bad}" is not allowed (cross-tenant risk); use scalar ids`);
      }
      for (const op of ['create', 'update', 'upsert', 'createMany', 'updateMany']) {
        for (const p of arr(v[op])) {
          for (const d of [p, ...arr(p?.data), ...arr(p?.create), ...arr(p?.update)]) {
            const t = SCOPES[target];
            if (t?.kind === 'direct' && d && typeof d === 'object' && d.tenantId !== undefined && d.tenantId !== val) {
              throw new TenantIsolationError(`${target}: nested tenantId does not match the active tenant`);
            }
            checkNested(target, d, val, depth + 1);
          }
        }
      }
    }
  }

  return ext as typeof base;
}

// ---- audit -----------------------------------------------------------------------------------
async function writeAudit(
  base: PrismaClient,
  bypass: { kind: string; actorId: string | null; reason: string },
  model: string,
  operation: string,
  args: any,
) {
  const w = args?.where;
  const d = Array.isArray(args?.data) ? args.data[0] : args?.data;
  const tenantId = [w?.tenantId, d?.tenantId, model === 'Tenant' ? w?.id : undefined].find((x) => typeof x === 'string') ?? null;
  await base.auditLog.create({
    data: {
      actorId: bypass.actorId,
      tenantId,
      action: `db.${model}.${operation}`,
      meta: {
        bypass: bypass.kind,
        reason: bypass.reason,
        model,
        operation,
        where: redact(w) ?? null,
        // keys only: never values (may be secrets / PII)
        dataKeys: d && typeof d === 'object' ? Object.keys(d) : [],
        rows: Array.isArray(args?.data) ? args.data.length : undefined,
      } as Prisma.InputJsonValue,
    },
  });
}
