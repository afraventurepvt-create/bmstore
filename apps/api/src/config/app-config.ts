import { Injectable } from '@nestjs/common';

/**
 * Typed, validated environment. Fails fast at boot on missing/weak secrets.
 * Never log this object: it holds secrets.
 */
@Injectable()
export class AppConfig {
  readonly nodeEnv = process.env.NODE_ENV ?? 'development';
  readonly port = Number(process.env.PORT ?? 3000);
  readonly rootDomain = (process.env.ROOT_DOMAIN ?? 'localhost').toLowerCase();
  readonly trustProxy = process.env.TRUST_PROXY === '1';
  /** Application role: owns no tables, NOBYPASSRLS. Row-level security applies to every query. */
  readonly databaseUrl = required('DATABASE_URL');
  /** Owner role: migrations and the audited superadmin bypass. Exempt from RLS. Never used for tenant traffic. */
  readonly databaseAdminUrl = required('DATABASE_ADMIN_URL');
  readonly redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  readonly tenantCacheTtl = Number(process.env.TENANT_CACHE_TTL_SECONDS ?? 300);
  /** Short negative cache so random Host headers cannot hammer Postgres. */
  readonly tenantNegativeCacheTtl = 60;
  readonly jwtAccessSecret = minLen('JWT_ACCESS_SECRET', 32);
  readonly jwtAccessTtl = process.env.JWT_ACCESS_TTL ?? '15m';
  readonly refreshTtlDays = Number(process.env.REFRESH_TTL_DAYS ?? 30);
  readonly encryptionKey = parseKey(required('ENCRYPTION_KEY'));
  /** Subdomains that are platform hosts, never tenants. */
  readonly reservedSubdomains = new Set(['www', 'admin', 'api', 'app', 'static', 'cdn', 'mail']);

  get isProd() {
    return this.nodeEnv === 'production';
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function minLen(name: string, n: number): string {
  const v = required(name);
  if (v.length < n) throw new Error(`${name} must be at least ${n} characters`);
  return v;
}

function parseKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or 64 hex chars)');
  return key;
}
