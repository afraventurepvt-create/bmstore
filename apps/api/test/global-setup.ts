import { execSync } from 'node:child_process';
import { ensureAppRole } from '../scripts/db-app-role';
import { startFakeS3 } from './s3-fake';

export default async function globalSetup() {
  // Owner role: migrations. Application role: everything the API does under row-level security.
  process.env.DATABASE_ADMIN_URL ??= 'postgresql://bmstore:bmstore@localhost:5432/bmstore_test?schema=public';
  process.env.DATABASE_URL ??= 'postgresql://bmstore_app:bmstore_app@localhost:5432/bmstore_test?schema=public';
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: process.env, cwd: __dirname + '/..' });
  await ensureAppRole();
  // Object storage double for media tests (setup-env.ts points S3_ENDPOINT at it).
  const s3 = await startFakeS3(Number(process.env.FAKE_S3_PORT ?? 9100));
  (globalThis as any).__FAKE_S3__ = s3;
}
