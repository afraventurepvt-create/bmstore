import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** Unscoped client. Internal use only (tenant resolution, audit writes, the tenant extension itself). */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  /** Query logging is deliberately off: parameters would leak PII/secrets into logs. */
  readonly base = new PrismaClient({ log: ['warn', 'error'] });

  async onModuleInit() {
    await this.base.$connect();
  }
  async onModuleDestroy() {
    await this.base.$disconnect();
  }
}
