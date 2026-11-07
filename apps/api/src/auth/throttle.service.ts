import { Injectable, Logger } from '@nestjs/common';
import { TooManyRequestsException } from '../common/errors';
import { AppConfig } from '../config/app-config';
import { RedisService } from '../redis/redis.service';

/**
 * Redis-backed counters for the authentication endpoints:
 *   - per client IP (login, forgot-password, reset-password),
 *   - per (scope, email) for login attempts on accounts that do not exist, mirroring the database lockout real
 *     accounts get, so the responses cannot be used to tell which emails exist,
 *   - per (scope, email) for forgot-password, so one address cannot be flooded with mails.
 * If Redis is unavailable these limits fail OPEN (logged): availability wins, and the per-account lockout of real
 * users lives in Postgres (users.failed_login_attempts / locked_until) and keeps working.
 */
@Injectable()
export class ThrottleService {
  private readonly log = new Logger(ThrottleService.name);
  constructor(private readonly cfg: AppConfig, private readonly redis: RedisService) {}

  /** Lock duration after `failures` consecutive failures: 0 below the threshold, then 1m, 2m, 4m … capped. */
  lockSeconds(failures: number): number {
    if (failures < this.cfg.loginMaxFailures) return 0;
    return Math.min(this.cfg.lockBaseSec * 2 ** (failures - this.cfg.loginMaxFailures), this.cfg.lockMaxSec);
  }

  /** Fixed-window counter. Returns the count after incrementing, or null when Redis is down. */
  private async hit(key: string, windowSec: number): Promise<number | null> {
    try {
      const n = await this.redis.client.incr(key);
      if (n === 1) await this.redis.client.expire(key, windowSec);
      return n;
    } catch (e) {
      this.log.warn(`rate limit unavailable (${(e as NodeJS.ErrnoException).code ?? 'redis error'}): allowing`);
      return null;
    }
  }

  private async ttl(key: string): Promise<number> {
    try { return Math.max(1, await this.redis.client.ttl(key)); } catch { return 1; }
  }

  private async assertUnder(key: string, limit: number, windowSec: number) {
    const n = await this.hit(key, windowSec);
    if (n !== null && n > limit) throw new TooManyRequestsException(await this.ttl(key));
  }

  assertLoginIp(ip: string) {
    return this.assertUnder(`rl:login:ip:${ip}`, this.cfg.loginIpLimit, this.cfg.loginIpWindowSec);
  }
  assertForgotIp(ip: string) {
    return this.assertUnder(`rl:forgot:ip:${ip}`, this.cfg.forgotPerIpLimit, this.cfg.forgotWindowSec);
  }
  assertResetIp(ip: string) {
    return this.assertUnder(`rl:reset:ip:${ip}`, this.cfg.forgotPerIpLimit, this.cfg.forgotWindowSec);
  }

  /** true when another forgot-password mail may be sent to this address in this scope. */
  async allowForgotMail(scope: string, email: string): Promise<boolean> {
    const n = await this.hit(`rl:forgot:acct:${scope}:${email}`, this.cfg.forgotWindowSec);
    return n === null || n <= this.cfg.forgotPerEmailLimit;
  }

  // ---- unknown-account mirror of the database lockout ------------------------------------------
  private ghostLockKey(scope: string, email: string) { return `rl:login:ghostlock:${scope}:${email}`; }

  /** Throws 429 if this non-existent account is currently "locked" (same timing as a real one). */
  async assertGhostUnlocked(scope: string, email: string) {
    try {
      const ttl = await this.redis.client.ttl(this.ghostLockKey(scope, email));
      if (ttl > 0) throw new TooManyRequestsException(ttl);
    } catch (e) {
      if (e instanceof TooManyRequestsException) throw e;
    }
  }

  /** Record a failed attempt on a non-existent account; lock it exactly like a real one would be. */
  async ghostFailure(scope: string, email: string) {
    const n = await this.hit(`rl:login:ghostfail:${scope}:${email}`, this.cfg.lockMaxSec);
    if (n === null) return;
    const lock = this.lockSeconds(n);
    if (lock > 0) {
      try { await this.redis.client.set(this.ghostLockKey(scope, email), '1', 'EX', lock); } catch { /* fail open */ }
    }
  }
}
