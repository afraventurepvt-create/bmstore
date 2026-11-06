import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

export async function createApp(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

export const uniq = (p = 't') => `${p}${randomBytes(4).toString('hex')}`;

export async function makeTenant(db: PrismaClient, over: Record<string, unknown> = {}) {
  const s = uniq('shop');
  return db.tenant.create({
    data: { name: `Store ${s}`, slug: s, subdomain: s, ...over } as any,
  });
}

export async function deleteTenants(db: PrismaClient, ids: string[]) {
  if (ids.length) await db.tenant.deleteMany({ where: { id: { in: ids } } });
}
