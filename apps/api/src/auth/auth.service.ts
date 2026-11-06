import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppConfig } from '../config/app-config';
import { AuthActor, RequestContext, Role } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';

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

  async login(emailRaw: string, password: string): Promise<TokenPair> {
    const email = emailRaw.trim().toLowerCase();
    return this.scoped(async () => {
      const user = await this.prisma.db.user.findFirst({ where: { email } });
      this.dummyHash ??= this.hashPassword('dummy-password-for-timing');
      const ok = await argon2.verify(user?.passwordHash ?? (await this.dummyHash), password).catch(() => false);
      if (!user || !ok || !user.isActive) throw new UnauthorizedException('Invalid credentials');
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
