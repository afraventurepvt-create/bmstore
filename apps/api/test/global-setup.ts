import { execSync } from 'node:child_process';
import { ensureAppRole } from '../scripts/db-app-role';

export default async function globalSetup() {
  // Owner role: migrations. Application role: everything the API does under row-level security.
  process.env.DATABASE_ADMIN_URL ??= 'postgresql://bmstore:bmstore@localhost:5432/bmstore_test?schema=public';
  process.env.DATABASE_URL ??= 'postgresql://bmstore_app:bmstore_app@localhost:5432/bmstore_test?schema=public';
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: process.env, cwd: __dirname + '/..' });
  await ensureAppRole();
}
