import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppConfig } from '../config/app-config';
import { TooManyRequestsException } from '../common/errors';
import { AuthActor, RequestContext, Role } from '../common/request-context';
import { MailerService } from '../mail/mailer.service';
import { PrismaService } from '../prisma/prisma.service';
import { ThrottleService } from './throttle.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  tokenType: 'Bearer';
}

export interface AccessClaims {
  sub: string;
  role: Role;
  tid: string | null;
}

const JWT_OPTS = { issuer: 'bmstore', audience: 'bmstore-api' } as const;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class AuthService {
  /** Verified against when the user doesn't exist, so response time doesn't reveal which emails exist. */
  private dummyHash?: Promise<string>;

  constructor(
    private readonly cfg: AppConfig,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly throttle: ThrottleService,
    private readonly mailer: MailerService,
  ) {}

  hashPassword(plain: string) {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  /**
   * Run in the request's own scope: the tenant resolved from Host, or - on a platform host - the
   * tenant_id IS NULL scope (superadmins). A store user can therefore never log in on the platform
   * host, and a superadmin never on a store host, and store A's users are invisible on store B.
   */
  private scoped<T>(fn: () => Promise<T>): Promise<T> {
    return RequestContext.tenantId() ? fn() : this.prisma.asPlatform(fn);
  }
  /** Key prefix for per-account counters: the tenant, or the platform. */
  private scopeKey() {
    return RequestContext.tenantId() ?? 'platform';
  }

  private audit(action: string, meta: Record<string, unknown>, actorId: string | null = null) {
    return this.prisma.db.auditLog.create({ data: { actorId, action, meta: meta as Prisma.InputJsonValue } });
  }

  // ---- login ---------------------------------------------------------------------------------------
  /**
   * Limits, in order: per-IP window (429), per-account lock (429, Retry-After), then the password.
   * Failures increment users.failed_login_attempts; at the threshold the account locks for lockSeconds(n)
   * (1m, 2m, 4m … capped). Unknown emails get the identical treatment through a Redis mirror, so neither
   * the status code nor the timing says whether an account exists. Success resets the counter.
   */
  async login(emailRaw: string, password: string, ip: string): Promise<TokenPair> {
    await this.throttle.assertLoginIp(ip);
    const email = emailRaw.trim().toLowerCase();
    return this.scoped(async () => {
      const db = this.prisma.db;
      const user = await db.user.findFirst({ where: { email } });
      const now = new Date();
      if (user?.lockedUntil && user.lockedUntil > now) {
        throw new TooManyRequestsException(Math.max(1, Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000)));
      }
      if (!user) await this.throttle.assertGhostUnlocked(this.scopeKey(), email);

      this.dummyHash ??= this.hashPassword('dummy-password-for-timing');
      const ok = await argon2.verify(user?.passwordHash ?? (await this.dummyHash), password).catch(() => false);

      if (!user) {
        await this.throttle.ghostFailure(this.scopeKey(), email);
        throw new UnauthorizedException('Invalid credentials');
      }
      if (!ok || !user.isActive) {
        if (ok) throw new UnauthorizedException('Invalid credentials'); // inactive: right password, no counter
        const failures = user.failedLoginAttempts + 1;
        const lock = this.throttle.lockSeconds(failures);
        const lockedUntil = lock ? new Date(Date.now() + lock * 1000) : null;
        await db.user.update({ where: { id: user.id }, data: { failedLoginAttempts: { increment: 1 }, lockedUntil } });
        if (lockedUntil) await this.audit('auth.account_locked', { userId: user.id, failures, lockSeconds: lock, ip }, user.id);
        throw new UnauthorizedException('Invalid credentials');
      }
      if (user.failedLoginAttempts || user.lockedUntil) {
        await db.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
      }
      return this.issue(user.id, user.role, user.tenantId, randomUUID());
    });
  }

  async refresh(rawToken: string): Promise<TokenPair> {
    return this.scoped(async () => {
      const db = this.prisma.db;
      const tokenHash = sha256(rawToken);
      const tok = await db.refreshToken.findUnique({ where: { tokenHash } }); // scoped to this host's tenant
      if (!tok) throw new UnauthorizedException('Invalid refresh token');

      if (tok.revokedAt) {
        // A rotated/revoked token was replayed: assume theft, kill the whole session family.
        await db.refreshToken.updateMany({ where: { familyId: tok.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        throw new UnauthorizedException('Invalid refresh token');
      }
      if (tok.expiresAt <= new Date()) throw new UnauthorizedException('Invalid refresh token');

      const user = await db.user.findUnique({ where: { id: tok.userId } });
      if (!user || !user.isActive) throw new UnauthorizedException('Invalid refresh token');

      // Atomic rotate: only one concurrent caller can flip revokedAt from NULL.
      const flipped = await db.refreshToken.updateMany({ where: { id: tok.id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (flipped.count !== 1) {
        await db.refreshToken.updateMany({ where: { familyId: tok.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        throw new UnauthorizedException('Invalid refresh token');
      }
      return this.issue(user.id, user.role, user.tenantId, tok.familyId);
    });
  }

  async logout(rawToken: string): Promise<void> {
    await this.scoped(async () => {
      const tok = await this.prisma.db.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
      if (tok) {
        await this.prisma.db.refreshToken.updateMany({ where: { familyId: tok.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
    });
  }

  // ---- password reset ------------------------------------------------------------------------------
  /**
   * Always answers the same way. For an existing, active account: outstanding tokens are voided, a new 256-bit
   * token is issued (only its sha256 is stored, 30 minute expiry) and emailed as a link built from the request Host.
   * Per-email and per-IP windows stop mail floods; above the per-email limit nothing is sent (still a 202).
   */
  async forgotPassword(emailRaw: string, host: string, ip: string): Promise<void> {
    await this.throttle.assertForgotIp(ip);
    const email = emailRaw.trim().toLowerCase();
    await this.scoped(async () => {
      const db = this.prisma.db;
      const user = await db.user.findFirst({ where: { email, isActive: true } });
      if (!user) return;
      if (!(await this.throttle.allowForgotMail(this.scopeKey(), email))) return;

      const raw = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + this.cfg.passwordResetTtlMin * 60_000);
      await db.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
      await db.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(raw), expiresAt } });
      await this.audit('auth.password_reset_requested', { userId: user.id, ip }, user.id);

      const link = this.cfg.passwordResetUrlTemplate.replace('{host}', host).replace('{token}', raw);
      await this.mailer.send({
        to: user.email,
        subject: 'Reset your password',
        text: `Someone (hopefully you) asked to reset the password for ${user.email}.\n\nReset it here within ${this.cfg.passwordResetTtlMin} minutes:\n${link}\n\nIf you did not ask for this, ignore this email; your password has not changed.`,
      });
    });
  }

  /**
   * Single use: the token row is flipped used_at=null -> now atomically, so two concurrent redemptions yield one
   * success. Sets the new password, clears any lockout and revokes every refresh-token family of the user.
   */
  async resetPassword(rawToken: string, newPassword: string, ip: string): Promise<void> {
    await this.throttle.assertResetIp(ip);
    const invalid = () => new BadRequestException('Invalid or expired token');
    await this.scoped(async () => {
      const db = this.prisma.db;
      const tok = await db.passwordResetToken.findUnique({ where: { tokenHash: sha256(rawToken) } }); // scoped to this host's tenant
      if (!tok || tok.usedAt || tok.expiresAt <= new Date()) throw invalid();
      const user = await db.user.findUnique({ where: { id: tok.userId } });
      if (!user || !user.isActive) throw invalid();
      const passwordHash = await this.hashPassword(newPassword);
      const flipped = await db.passwordResetToken.updateMany({ where: { id: tok.id, usedAt: null }, data: { usedAt: new Date() } });
      if (flipped.count !== 1) throw invalid();
      await db.user.update({ where: { id: user.id }, data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null } });
      await db.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit('auth.password_reset', { userId: user.id, ip }, user.id);
    });
  }

  verifyAccess(token: string): AuthActor {
    let claims: AccessClaims;
    try {
      claims = this.jwt.verify<AccessClaims>(token, { secret: this.cfg.jwtAccessSecret, algorithms: ['HS256'], ...JWT_OPTS });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (!claims.sub || !['superadmin', 'store_owner', 'staff'].includes(claims.role)) throw new UnauthorizedException('Invalid token');
    return { id: claims.sub, role: claims.role, tenantId: claims.tid ?? null };
  }

  private async issue(userId: string, role: Role, tenantId: string | null, familyId: string): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync({ role, tid: tenantId } satisfies Omit<AccessClaims, 'sub'>, {
      secret: this.cfg.jwtAccessSecret,
      algorithm: 'HS256',
      expiresIn: this.cfg.jwtAccessTtl as any,
      subject: userId,
      ...JWT_OPTS,
    });
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.db.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: sha256(refreshToken), // only the hash is stored
        expiresAt: new Date(Date.now() + this.cfg.refreshTtlDays * 86_400_000),
      },
    });
    return { accessToken, refreshToken, expiresIn: this.cfg.jwtAccessTtl, tokenType: 'Bearer' };
  }
}
