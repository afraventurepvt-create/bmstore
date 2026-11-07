import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfig } from '../config/app-config';

/**
 * Thin Redis wrapper. Cache operations never throw: if Redis is down we degrade to the DB.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly log = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(cfg: AppConfig) {
    this.client = new Redis(cfg.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 500,
      lazyConnect: false,
    });
    // Never print the URL (may contain a password).
    this.client.on('error', (e) => this.log.warn(`redis error: ${(e as NodeJS.ErrnoException).code ?? e.name}`));
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  async setex(key: string, ttl: number, value: string): Promise<void> {
    try {
      await this.client.set(key, value, 'EX', ttl);
    } catch {
      /* cache is best-effort */
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!keys.length) return;
    try {
      await this.client.del(...keys);
    } catch {
      /* best-effort; TTL bounds staleness */
    }
  }

  async onModuleDestroy() {
    this.client.disconnect();
  }
}
