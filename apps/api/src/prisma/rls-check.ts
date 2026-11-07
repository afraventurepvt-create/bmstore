import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Boot-time proof that row-level security is really in force. Refuses to start otherwise, in every environment:
 *   - the application connection is not a superuser, has no BYPASSRLS and owns none of the tables
 *     (any of those would make Postgres skip the policies silently),
 *   - every table behind a Prisma model has RLS enabled and at least one policy,
 *   - the owner connection is exempt (owner, superuser or BYPASSRLS), otherwise tenant resolution and the bypass can't work.
 * Mirrors assertAllModelsClassified(): a new table cannot ship without a policy.
 */

/** Database table names of every Prisma model (`@@map` aware). */
export const MODEL_TABLES: string[] = Prisma.dmmf.datamodel.models.map((m) => m.dbName ?? m.name);

export interface RoleFacts { role: string; superuser: boolean; bypassRls: boolean; ownedTables: string[] }
export interface TableFacts { table: string; rlsEnabled: boolean; policies: number }

export async function roleFacts(client: PrismaClient): Promise<RoleFacts> {
  const [r] = await client.$queryRaw<Array<{ role: string; superuser: boolean; bypass: boolean }>>`
    SELECT rolname AS role, rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
  const owned = await client.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tableowner = current_user AND tablename = ANY(${MODEL_TABLES})`;
  return { role: r.role, superuser: r.superuser, bypassRls: r.bypass, ownedTables: owned.map((o) => o.tablename) };
}

export async function tableFacts(client: PrismaClient): Promise<TableFacts[]> {
  const rows = await client.$queryRaw<Array<{ table: string; rls: boolean; policies: bigint | number }>>`
    SELECT c.relname AS "table", c.relrowsecurity AS rls,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname = ANY(${MODEL_TABLES})`;
  const byName = new Map(rows.map((r) => [r.table, r]));
  return MODEL_TABLES.map((t) => {
    const r = byName.get(t);
    return { table: t, rlsEnabled: Boolean(r?.rls), policies: Number(r?.policies ?? 0) };
  });
}

export async function assertRlsEnforced(app: PrismaClient, admin: PrismaClient): Promise<void> {
  const problems: string[] = [];
  const a = await roleFacts(app);
  if (a.superuser) problems.push(`DATABASE_URL role "${a.role}" is a superuser (bypasses row-level security)`);
  if (a.bypassRls) problems.push(`DATABASE_URL role "${a.role}" has BYPASSRLS`);
  if (a.ownedTables.length) problems.push(`DATABASE_URL role "${a.role}" owns tables (owners are exempt from RLS): ${a.ownedTables.join(', ')}`);
  for (const t of await tableFacts(admin)) {
    if (!t.rlsEnabled) problems.push(`table "${t.table}" has no row-level security`);
    else if (t.policies === 0) problems.push(`table "${t.table}" has RLS enabled but no policy (nothing would be readable)`);
  }
  const o = await roleFacts(admin);
  if (!o.superuser && !o.bypassRls && o.ownedTables.length !== MODEL_TABLES.length) {
    problems.push(`DATABASE_ADMIN_URL role "${o.role}" is neither owner of every table nor BYPASSRLS; the audited bypass would be scoped`);
  }
  if (problems.length) {
    throw new Error(`Row-level security is not enforceable; refusing to start:\n - ${problems.join('\n - ')}\n(run: npm run db:app-role -w apps/api, see README)`);
  }
}
