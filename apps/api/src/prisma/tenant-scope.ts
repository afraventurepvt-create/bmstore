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
 * Two layers, two database roles:
 *   1. The application layer above rewrites `where`/`data` so every statement names the tenant.
 *   2. Postgres row-level security (migration 0004) re-checks every row. The scoped client connects as a role that
 *      owns nothing and has NOBYPASSRLS; before each query/transaction it pins the tenant with a transaction-local
 *      `set_config('app.tenant_id', ..., true)`. If the app layer is ever bypassed, nothing is pinned and the database
 *      returns/accepts NO rows. The bypass uses the owner connection, which Postgres exempts from RLS.
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
  | { kind: 'self' }; // the tenants table: row id == tenant id

export const SCOPES: Record<string, Scope> = {
  Tenant: { kind: 'self' },
  ThemeConfig: { kind: 'direct' },
  Category: { kind: 'direct' },
  Product: { kind: 'direct' },
  Variant: { kind: 'direct' },
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
const RAW_METHODS = ['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe'] as const;

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// ---- DMMF helpers ----------------------------------------------------------------------------
const MODELS = Prisma.dmmf.datamodel.models;
const RELATIONS = new Map<string, Map<string, string>>(
  MODELS.map((m) => [m.name, new Map(m.fields.filter((f) => f.kind === 'object').map((f) => [f.name, f.type]))]),
);
/** Prisma client delegate for a model name (`ThemeConfig` -> `client.themeConfig`). */
const delegateOf = (model: string) => model[0].toLowerCase() + model.slice(1);

export function assertAllModelsClassified() {
  const missing = MODELS.map((m) => m.name).filter((n) => !SCOPES[n]);
  if (missing.length) throw new Error(`Models not classified in SCOPES (tenant isolation): ${missing.join(', ')}`);
}

// ---- row-level security pin ------------------------------------------------------------------
/** The settings the RLS policies read (prisma/migrations/*_row_level_security). Transaction-local: `true`. */
export const RLS_TENANT_SETTING = 'app.tenant_id';
export const RLS_PLATFORM_SETTING = 'app.platform';

/** Pins the scope on the connection for the CURRENT transaction only. Must run inside the same transaction as the query. */
export function pinScope(client: { $executeRaw: PrismaClient['$executeRaw'] }, tenantId: string | null, platform: boolean) {
  return client.$executeRaw`SELECT set_config(${RLS_TENANT_SETTING}, ${tenantId ?? ''}, true), set_config(${RLS_PLATFORM_SETTING}, ${platform ? 'on' : 'off'}, true)`;
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

interface ScopeValue { tenantId: string | null; platform: boolean }

/** Resolve what the current context may see. No context => fail closed. */
function resolveScope(model: string, operation: string): ScopeValue {
  const store = RequestContext.get();
  const scope = SCOPES[model];
  if (!scope) throw new TenantIsolationError(`Model ${model} is not classified for tenant isolation`);
  if (store?.tenantId) return { tenantId: store.tenantId, platform: false };
  if (store?.platform) {
    if (scope.kind !== 'direct' || !scope.nullable) throw new TenantIsolationError(`Platform scope cannot access ${model}`);
    return { tenantId: null, platform: true };
  }
  throw new TenantIsolationError(`No tenant context for ${model}.${operation}`);
}

// ---- the extension ---------------------------------------------------------------------------
/**
 * @param app   connection as the APPLICATION role (row-level security applies). Carries every tenant/platform query.
 * @param admin connection as the OWNER role (exempt from RLS). Carries the audited bypass and the audit writes.
 */
export function createScopedClient(app: PrismaClient, admin: PrismaClient) {
  assertAllModelsClassified();

  /** Owner connection, usable ONLY inside an explicit bypass; every operation writes an audit row before it runs. */
  const bypassClient: any = admin.$extends({
    name: 'audited-bypass',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          const store = RequestContext.get();
          if (!store?.bypass) throw new TenantIsolationError(`${model}.${operation}: owner connection used outside an audited bypass`);
          await writeAudit(admin, store.bypass, model, operation, args);
          return query(args);
        },
      },
    },
  });

  /** Application connection with where/data rewriting and the RLS pin. */
  const scoped: any = app.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations(params: any) {
          const { model, operation, args, query } = params;
          const store = RequestContext.get();
          // Set by Prisma when this operation runs inside db.$transaction() (interactive or batch), where the
          // scope was pinned on the transaction's connection by scopedTransaction() below.
          const inTransaction = Boolean(params.__internalParams?.transaction);

          // 1. Explicit, audited superadmin/system bypass -> owner connection.
          if (store?.bypass) {
            if (inTransaction) throw new TenantIsolationError(`${model}.${operation}: bypass inside a tenant-scoped transaction`);
            return bypassClient[delegateOf(model)][operation](args);
          }

          if (!KNOWN_OPS.has(operation)) throw new TenantIsolationError(`Operation ${model}.${operation} is not allowed`);
          const scope = SCOPES[model];
          const val = resolveScope(model, operation);

          if (APPEND_ONLY.has(model) && !CREATE_OPS.has(operation) && !READ_OPS.has(operation)) {
            throw new TenantIsolationError(`${model} is append-only`);
          }

          const scopedArgs = await scopeArgs(model, scope, operation, args ?? {}, val.tenantId);
          if (inTransaction) return query(scopedArgs);
          // 2. Outside a transaction: pin + query atomically, so RLS sees the tenant and the pin dies with the transaction.
          const [, result] = await app.$transaction([pinScope(app, val.tenantId, val.platform), query(scopedArgs)]);
          return result;
        },
      },
    },
  });

  /**
   * db.$transaction(): pins the scope on the transaction's connection first, then runs the caller's work on a
   * transaction client that still carries the tenant-scope hooks. Under a bypass the transaction runs on the owner
   * connection (audited per operation).
   */
  async function scopedTransaction(this: any, arg: any, opts?: any): Promise<any> {
    const store = RequestContext.get();
    if (store?.bypass) {
      if (typeof arg !== 'function') throw new TenantIsolationError('Batch $transaction([...]) is not supported inside a bypass; use an interactive transaction');
      return bypassClient.$transaction((tx: any) => arg(withoutRaw(tx)), opts);
    }
    if (!store?.tenantId && !store?.platform) throw new TenantIsolationError('No tenant context for $transaction');
    const val: ScopeValue = store.tenantId ? { tenantId: store.tenantId, platform: false } : { tenantId: null, platform: true };
    if (typeof arg === 'function') {
      return scoped.$transaction(async (tx: any) => {
        await pinScope(tx, val.tenantId, val.platform);
        return arg(withoutRaw(tx));
      }, opts);
    }
    return scoped.$transaction([pinScope(app, val.tenantId, val.platform), ...arr(arg)], opts).then((r: any[]) => r.slice(1));
  }

  const rawDisabled = () => { throw new TenantIsolationError('Raw queries are disabled on the tenant-scoped client'); };
  const ext: any = scoped.$extends({
    name: 'tenant-scope-client',
    client: {
      // Raw SQL bypasses model scoping. Disabled on the scoped client; use `base` deliberately if ever needed.
      $queryRaw: rawDisabled, $queryRawUnsafe: rawDisabled, $executeRaw: rawDisabled, $executeRawUnsafe: rawDisabled,
      $transaction: scopedTransaction,
    },
  });

  /** Transaction clients expose raw methods (we need one for the pin); hide them from feature code. */
  function withoutRaw(tx: any) {
    return new Proxy(tx, {
      get(target, prop, receiver) {
        if ((RAW_METHODS as readonly string[]).includes(prop as string)) return rawDisabled;
        if (prop === '$transaction') return () => { throw new TenantIsolationError('Nested transactions are not supported'); };
        return Reflect.get(target, prop, receiver);
      },
    });
  }

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
    } else if (operation === 'upsert') {
      out.create = await guardCreate(model, scope, args.create, val);
      out.update = await guardUpdate(model, scope, args.update, val);
    } else if (operation.startsWith('update')) {
      out.data = await guardUpdate(model, scope, args.data, val);
    }
    return out;
  }

  function fragment(scope: Scope, val: string | null) {
    switch (scope.kind) {
      case 'direct': return { tenantId: val };
      case 'self': return { id: val };
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
    return data;
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

  return ext as typeof app;
}

// ---- audit -----------------------------------------------------------------------------------
async function writeAudit(
  admin: PrismaClient,
  bypass: { kind: string; actorId: string | null; reason: string },
  model: string,
  operation: string,
  args: any,
) {
  const w = args?.where;
  const d = Array.isArray(args?.data) ? args.data[0] : args?.data;
  const tenantId = [w?.tenantId, d?.tenantId, model === 'Tenant' ? w?.id : undefined].find((x) => typeof x === 'string') ?? null;
  await admin.auditLog.create({
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
