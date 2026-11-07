/**
 * Bootstrap the first superadmin:  SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... npm run seed:superadmin
 * Idempotent. The password is read from env and never printed.
 */
import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';

async function main() {
  const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD;
  if (!email || !password || password.length < 12) {
    throw new Error('Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD (min 12 chars)');
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const auth = app.get(AuthService);
    const passwordHash = await auth.hashPassword(password);
    const created = await prisma.asSystem('seed:superadmin', async () => {
      const existing = await prisma.db.user.findFirst({ where: { email, tenantId: null } });
      if (existing) return false;
      await prisma.db.user.create({ data: { email, passwordHash, role: 'superadmin', tenantId: null } });
      return true;
    });
    console.log(created ? `Superadmin ${email} created` : `Superadmin ${email} already exists`);
  } finally {
    await app.close();
  }
}
main().catch((e) => {
  console.error('seed failed:', e instanceof Error ? e.message : 'unknown error');
  process.exit(1);
});
