import { ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuthActor, RequestContext } from '../common/request-context';
import { AppConfig } from '../config/app-config';
import { assertRlsEnforced } from './rls-check';
import { createScopedClient } from './tenant-scope';

/**
 * Prisma promises are LAZY: the query (and so our scoping hook) only runs when awaited. If a callback returned
 * an un-awaited `db.x.findMany()`, it would execute outside the AsyncLocalStorage scope. Awaiting inside the scope
 * fixes that. (Failing closed is the fallback: without context the extension throws, it never leaks.)
 */
const inside = <T>(fn: () => Promise<T>) => async () => await fn();

/**
 * Query logging is off on purpose: parameters would leak PII/secrets into logs. Prisma's own error/warn
 * output is also replaced: Postgres errors embed the failing ROW, e.g. password_hash.
 */
function quietClient(url: string, log: Logger, label: string): PrismaClient {
  const c = new PrismaClient({ datasourceUrl: url, log: [{ emit: 'event', level: 'error' }, { emit: 'event', level: 'warn' }] });
  (c as any).$on('error', (e: { target?: string }) => log.error(`prisma error (details withheld) ${label} target=${e?.target ?? '-'}`));
  (c as any).$on('warn', (e: { target?: string }) => log.warn(`prisma warning (details withheld) ${label} target=${e?.target ?? '-'}`));
  return c;
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Prisma');

  /**
   * UNSCOPED client on the OWNER connection (DATABASE_ADMIN_URL): Postgres exempts it from row-level security.
   * Only for: tenant resolution (pre-context), the extension's own audit writes, and tests. Application code must use `db`.
   */
  readonly base: PrismaClient;

  /** APPLICATION connection (DATABASE_URL): a role that owns nothing and cannot bypass RLS. Never used unscoped. */
  private readonly app: PrismaClient;

  /** Tenant-scoped client. Every operation is forced into the active tenant (or throws), and RLS re-checks it. */
  readonly db: PrismaClient;

  constructor(cfg: AppConfig) {
    this.base = quietClient(cfg.databaseAdminUrl, this.log, 'owner');
    this.app = quietClient(cfg.databaseUrl, this.log, 'app');
    this.db = createScopedClient(this.app, this.base);
  }

  async onModuleInit() {
    await Promise.all([this.base.$connect(), this.app.$connect()]);
    await assertRlsEnforced(this.app, this.base);
  }
  async onModuleDestroy() {
    await Promise.all([this.base.$disconnect(), this.app.$disconnect()]);
  }

  /**
   * Run `fn` scoped to a tenant outside an HTTP request (jobs, scripts, tests).
   * The tenant id must come from trusted code, never from user input.
   */
  runAsTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const cur = RequestContext.get();
    return RequestContext.run({ requestId: cur?.requestId ?? randomUUID(), tenantId, actor: cur?.actor }, inside(fn));
  }

  /** Pre-auth platform scope: users/refresh_tokens/audit_logs rows with tenant_id IS NULL only. */
  asPlatform<T>(fn: () => Promise<T>): Promise<T> {
    const cur = RequestContext.get();
    return RequestContext.run({ requestId: cur?.requestId ?? randomUUID(), platform: true }, inside(fn));
  }

  /**
   * EXPLICIT superadmin bypass. Every database operation inside `fn` writes an audit_logs row
   * (actor, reason, model, operation, redacted filter, data KEYS only) before it executes.
   */
  asSuperadmin<T>(actor: AuthActor, reason: string, fn: () => Promise<T>): Promise<T> {
    if (actor?.role !== 'superadmin') throw new ForbiddenException('Superadmin required');
    const cur = RequestContext.get();
    return RequestContext.run(
      { requestId: cur?.requestId ?? randomUUID(), actor, bypass: { kind: 'superadmin', actorId: actor.id, reason } },
      inside(fn),
    );
  }

  /** Audited bypass for bootstrap/maintenance code with no human actor (seed scripts, migrations of data). */
  asSystem<T>(reason: string, fn: () => Promise<T>): Promise<T> {
    return RequestContext.run({ requestId: randomUUID(), bypass: { kind: 'system', actorId: null, reason } }, inside(fn));
  }
}
