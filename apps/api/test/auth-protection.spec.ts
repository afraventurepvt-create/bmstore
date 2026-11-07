/**
 * Login rate limiting (per IP, per account), lockout with exponential backoff, and the password reset flow.
 * Runs with TRUST_PROXY=1 so each request can present its own X-Forwarded-For and the limits can be exercised
 * independently; limits are set tight here and restored afterwards (the other suites log in a lot).
 */
const SAVED = { TRUST_PROXY: process.env.TRUST_PROXY, LOGIN_IP_LIMIT: process.env.LOGIN_IP_LIMIT, FORGOT_PER_IP_LIMIT: process.env.FORGOT_PER_IP_LIMIT, FORGOT_PER_EMAIL_LIMIT: process.env.FORGOT_PER_EMAIL_LIMIT };
process.env.TRUST_PROXY = '1';
process.env.LOGIN_IP_LIMIT = '5';
process.env.FORGOT_PER_IP_LIMIT = '4';
process.env.FORGOT_PER_EMAIL_LIMIT = '2';

import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash, randomInt } from 'node:crypto';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { MailerService } from '../src/mail/mailer.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { createApp, deleteTenants, makeTenant, uniq } from './helpers';

describe('login protection and password reset', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base: PrismaClient;
  let auth: AuthService;
  let mailer: MailerService;
  let A: any, B: any;
  const PW = 'correct-horse-battery';
  const api = () => request(app.getHttpServer());
  const host = (t: any) => `${t.subdomain}.localhost`;
  const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  const login = (h: string, email: string, password = PW, from = ip()) =>
    api().post('/auth/login').set('Host', h).set('X-Forwarded-For', from).send({ email, password });
  const forgot = (h: string, email: string, from = ip()) => api().post('/auth/forgot-password').set('Host', h).set('X-Forwarded-For', from).send({ email });
  const reset = (h: string, token: string, password: string, from = ip()) =>
    api().post('/auth/reset-password').set('Host', h).set('X-Forwarded-For', from).send({ token, password });
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
  const tokenFromMail = (email: string) => new URL(mailer.lastTo(email)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
  const userRow = (email: string) => base.user.findFirstOrThrow({ where: { email } });

  async function mkUser(tenant: any | null, role: any, extra: any = {}) {
    const email = `${role}-${uniq()}@prot.test`;
    const passwordHash = await auth.hashPassword(PW);
    const data = { email, passwordHash, role, ...extra };
    if (tenant) await prisma.runAsTenant(tenant.id, () => prisma.db.user.create({ data }));
    else await prisma.asSystem('test', () => prisma.db.user.create({ data }));
    return email;
  }

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    base = prisma.base;
    auth = app.get(AuthService);
    mailer = app.get(MailerService);
    A = await makeTenant(base);
    B = await makeTenant(base);
  });
  afterAll(async () => {
    await base.user.deleteMany({ where: { tenantId: null, email: { endsWith: '@prot.test' } } });
    await deleteTenants(base, [A.id, B.id]);
    await app.close();
    for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  describe('per-IP limit', () => {
    it('blocks the 6th login attempt from one address within the window, with Retry-After; other addresses are unaffected', async () => {
      const from = ip();
      const email = await mkUser(A, 'staff');
      for (let i = 0; i < 5; i++) await login(host(A), `nobody-${uniq()}@prot.test`, 'x', from).expect(401);
      const r = await login(host(A), email, PW, from).expect(429); // right password, wrong moment
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(60);
      expect(r.body.message).toMatch(/Too many/);
      await login(host(A), email, PW).expect(200);
    });

    it('fails open when Redis is unavailable (the database lockout below still applies)', async () => {
      const redis = app.get(RedisService);
      const spy = jest.spyOn(redis.client, 'incr').mockRejectedValue(new Error('down'));
      try {
        const email = await mkUser(A, 'staff');
        const from = ip();
        for (let i = 0; i < 7; i++) await login(host(A), email, PW, from).expect(200);
        const locked = await mkUser(A, 'staff', { lockedUntil: new Date(Date.now() + 60_000), failedLoginAttempts: 5 });
        await login(host(A), locked, PW).expect(429);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('per-account lockout with backoff', () => {
    it('locks after 5 consecutive failures, even for the right password; backoff doubles and is capped; success resets', async () => {
      const email = await mkUser(A, 'store_owner');
      for (let i = 0; i < 5; i++) await login(host(A), email, 'wrong').expect(401);
      const r = await login(host(A), email, PW).expect(429);
      const retry = Number(r.headers['retry-after']);
      expect(retry).toBeGreaterThan(50);
      expect(retry).toBeLessThanOrEqual(60);
      let u = await userRow(email);
      expect(u.failedLoginAttempts).toBe(5);
      expect(u.lockedUntil!.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
      expect(await base.auditLog.count({ where: { action: 'auth.account_locked', actorId: u.id, tenantId: A.id } })).toBe(1);

      // lock expires -> one more failure -> 2 minutes
      await base.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
      await login(host(A), email, 'wrong').expect(401);
      u = await userRow(email);
      expect(u.failedLoginAttempts).toBe(6);
      const secs = (u.lockedUntil!.getTime() - Date.now()) / 1000;
      expect(secs).toBeGreaterThan(110);
      expect(secs).toBeLessThanOrEqual(120);

      // deep into the series the lock is capped at one hour
      await base.user.update({ where: { id: u.id }, data: { failedLoginAttempts: 30, lockedUntil: new Date(Date.now() - 1000) } });
      await login(host(A), email, 'wrong').expect(401);
      u = await userRow(email);
      const capped = (u.lockedUntil!.getTime() - Date.now()) / 1000;
      expect(capped).toBeGreaterThan(3500);
      expect(capped).toBeLessThanOrEqual(3600);

      // unlocked (by time) + right password -> counters cleared
      await base.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
      await login(host(A), email, PW).expect(200);
      u = await userRow(email);
      expect(u).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null });
    });

    it('an unknown email gets the identical sequence of responses (no enumeration)', async () => {
      const real = await mkUser(A, 'staff');
      const ghost = `ghost-${uniq()}@prot.test`;
      const seq = async (email: string) => {
        const out: number[] = [];
        for (let i = 0; i < 7; i++) out.push((await login(host(A), email, 'wrong')).status);
        return out;
      };
      const a = await seq(real);
      const b = await seq(ghost);
      expect(a).toEqual([401, 401, 401, 401, 401, 429, 429]);
      expect(b).toEqual(a);
      const g = await login(host(A), ghost, 'wrong').expect(429);
      expect(Number(g.headers['retry-after'])).toBeLessThanOrEqual(60);
    });

    it('an inactive account with the right password is refused without counting as a failure', async () => {
      const email = await mkUser(A, 'staff', { isActive: false });
      for (let i = 0; i < 6; i++) await login(host(A), email, PW).expect(401);
      expect((await userRow(email)).failedLoginAttempts).toBe(0);
    });
  });

  describe('password reset', () => {
    it('forgot-password always answers 202; only existing active accounts get a mail with a single-use link', async () => {
      const before = mailer.outbox.length;
      await forgot(host(A), `nobody-${uniq()}@prot.test`).expect(202);
      const inactive = await mkUser(A, 'staff', { isActive: false });
      await forgot(host(A), inactive).expect(202);
      expect(mailer.outbox.length).toBe(before);

      const email = await mkUser(A, 'store_owner');
      await forgot(host(A), email.toUpperCase()).expect(202);
      const mail = mailer.lastTo(email)!;
      expect(mail.subject).toMatch(/Reset your password/);
      const link = mail.text.match(/https?:\/\/\S+/)![0];
      expect(link).toBe(`https://${host(A)}/reset-password?token=${new URL(link).searchParams.get('token')}`);
      const token = tokenFromMail(email);
      expect(token.length).toBeGreaterThanOrEqual(40);
      const u = await userRow(email);
      const rows = await base.passwordResetToken.findMany({ where: { userId: u.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tokenHash: sha256(token), usedAt: null, tenantId: A.id });
      expect(JSON.stringify(rows)).not.toContain(token);
      const ttlMin = (rows[0].expiresAt.getTime() - Date.now()) / 60_000;
      expect(ttlMin).toBeGreaterThan(29);
      expect(ttlMin).toBeLessThanOrEqual(30);
      expect(await base.auditLog.count({ where: { action: 'auth.password_reset_requested', actorId: u.id, tenantId: A.id } })).toBe(1);

      // a second request voids the first token; above the per-email limit nothing more is sent (still 202)
      await forgot(host(A), email).expect(202);
      const token2 = tokenFromMail(email);
      expect(token2).not.toBe(token);
      expect((await base.passwordResetToken.findMany({ where: { userId: u.id, usedAt: null } })).map((r) => r.tokenHash)).toEqual([sha256(token2)]);
      const n = mailer.outbox.length;
      await forgot(host(A), email).expect(202);
      expect(mailer.outbox.length).toBe(n);
      await reset(host(A), token, 'brand-new-password-1').expect(400); // voided
      await reset(host(A), token2, 'brand-new-password-1').expect(204);
    });

    it('reset: sets the password, clears a lockout, revokes sessions, is single-use, expires after 30 minutes', async () => {
      const email = await mkUser(A, 'staff');
      const session = (await login(host(A), email).expect(200)).body;
      // lock the account the hard way
      await base.user.updateMany({ where: { email }, data: { failedLoginAttempts: 7, lockedUntil: new Date(Date.now() + 3_600_000) } });
      await login(host(A), email, PW).expect(429);

      await forgot(host(A), email).expect(202);
      const token = tokenFromMail(email);
      await reset(host(A), token, 'short').expect(400); // password policy
      await reset(host(A), token, 'brand-new-password-2').expect(204);
      await login(host(A), email, PW).expect(401);
      await login(host(A), email, 'brand-new-password-2').expect(200);
      expect(await userRow(email)).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null });
      await api().post('/auth/refresh').set('Host', host(A)).send({ refreshToken: session.refreshToken }).expect(401); // revoked
      await reset(host(A), token, 'brand-new-password-3').expect(400); // single use
      expect(await base.auditLog.count({ where: { action: 'auth.password_reset', tenantId: A.id, actorId: (await userRow(email)).id } })).toBe(1);

      // expiry
      await forgot(host(A), email).expect(202);
      const t2 = tokenFromMail(email);
      await base.passwordResetToken.updateMany({ where: { tokenHash: sha256(t2) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await reset(host(A), t2, 'brand-new-password-4').expect(400);
      await reset(host(A), 'x'.repeat(43), 'brand-new-password-4').expect(400); // unknown token
      await reset(host(A), 'short', 'brand-new-password-4').expect(400); // validation
    });

    it('a token is bound to the store it was issued on, and concurrent redemptions yield exactly one success', async () => {
      const email = await mkUser(B, 'store_owner');
      await forgot(host(B), email).expect(202);
      const token = tokenFromMail(email);
      await reset(host(A), token, 'brand-new-password-5').expect(400);
      await reset('admin.localhost', token, 'brand-new-password-5').expect(400);
      const rs = await Promise.all([1, 2, 3, 4].map(() => reset(host(B), token, 'brand-new-password-5')));
      expect(rs.filter((r) => r.status === 204)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 400)).toHaveLength(3);
      await login(host(B), email, 'brand-new-password-5').expect(200);
      // store B's token request is invisible on store A's host (different scope), and vice versa
      await forgot(host(A), email).expect(202);
      expect(mailer.lastTo(email)!.text).toContain(host(B)); // no new mail: A has no such user
    });

    it('superadmins reset on the platform host only', async () => {
      const email = await mkUser(null, 'superadmin');
      await forgot(host(A), email).expect(202); // not visible there
      expect(mailer.lastTo(email)).toBeUndefined();
      await forgot('admin.localhost', email).expect(202);
      const token = tokenFromMail(email);
      expect(mailer.lastTo(email)!.text).toContain('https://admin.localhost/reset-password?token=');
      const row = await base.passwordResetToken.findFirst({ where: { tokenHash: sha256(token) } });
      expect(row!.tenantId).toBeNull();
      await reset(host(A), token, 'brand-new-password-6').expect(400);
      await reset('admin.localhost', token, 'brand-new-password-6').expect(204);
      await login('admin.localhost', email, 'brand-new-password-6').expect(200);
    });

    it('forgot-password is rate limited per IP', async () => {
      const from = ip();
      for (let i = 0; i < 4; i++) await forgot(host(A), `nobody-${uniq()}@prot.test`, from).expect(202);
      const r = await forgot(host(A), `nobody-${uniq()}@prot.test`, from).expect(429);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    });
  });
});
