import { execSync } from 'node:child_process';

export default async function globalSetup() {
  process.env.DATABASE_URL ??= 'postgresql://bmstore:bmstore@localhost:5432/bmstore_test?schema=public';
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: process.env, cwd: __dirname + '/..' });
}
