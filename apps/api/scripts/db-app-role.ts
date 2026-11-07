/**
 * Create / refresh the APPLICATION database role, the one row-level security applies to.
 *
 *   DATABASE_ADMIN_URL=postgresql://owner:...   DATABASE_URL=postgresql://bmstore_app:<password>@...   npm run db:app-role
 *
 * Connects with DATABASE_ADMIN_URL (table owner / superuser) and makes sure the user named in DATABASE_URL exists
 * with that password, is NOT a superuser, has NOBYPASSRLS, owns nothing, and may read/write every table in the schema
 * (existing ones and those future migrations create). Idempotent; run it after `prisma migrate deploy` on a new database.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function ensureAppRole(adminUrl = process.env.DATABASE_ADMIN_URL, appUrl = process.env.DATABASE_URL): Promise<string> {
  if (!adminUrl || !appUrl) throw new Error('Set DATABASE_ADMIN_URL (owner) and DATABASE_URL (application role)');
  const u = new URL(appUrl);
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const schema = u.searchParams.get('schema') ?? 'public';
  if (!user || !password) throw new Error('DATABASE_URL must carry a user and a password');
  const adminUser = decodeURIComponent(new URL(adminUrl).username);
  if (adminUser === user) throw new Error('DATABASE_URL and DATABASE_ADMIN_URL must use different roles (the app role must not own the tables)');

  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    const exists = await admin.$queryRaw<Array<{ n: number }>>`SELECT 1 AS n FROM pg_roles WHERE rolname = ${user}`;
    if (!exists.length) await admin.$executeRawUnsafe(`CREATE ROLE ${ident(user)} LOGIN`);
    await admin.$executeRawUnsafe(
      `ALTER ROLE ${ident(user)} WITH LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`,
    );
    for (const sql of [
      `GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(user)}`,
      `GRANT USAGE ON SCHEMA ${ident(schema)} TO ${ident(user)}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${ident(schema)} TO ${ident(user)}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${ident(schema)} TO ${ident(user)}`,
      // tables/sequences that the owner creates later (future migrations)
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${ident(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident(user)}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${ident(schema)} GRANT USAGE, SELECT ON SEQUENCES TO ${ident(user)}`,
    ]) await admin.$executeRawUnsafe(sql);
    // Prisma's bookkeeping table is the owner's business only.
    const mig = await admin.$queryRaw<Array<{ n: number }>>`SELECT 1 AS n FROM pg_tables WHERE schemaname = ${schema} AND tablename = '_prisma_migrations'`;
    if (mig.length) await admin.$executeRawUnsafe(`REVOKE ALL ON TABLE ${ident(schema)}."_prisma_migrations" FROM ${ident(user)}`);
    return user;
  } finally {
    await admin.$disconnect();
  }
}

if (require.main === module) {
  ensureAppRole()
    .then((u) => console.log(`application role "${u}" is ready (LOGIN, NOSUPERUSER, NOBYPASSRLS, owns nothing)`))
    .catch((e) => { console.error('db-app-role failed:', e instanceof Error ? e.message : 'unknown error'); process.exit(1); });
}
