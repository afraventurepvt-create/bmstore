import { Controller, Get, INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Roles } from '../src/auth/decorators';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { deleteTenants, makeTenant, uniq } from './helpers';

@Controller('probe')
class ProbeController {
  @Get('owner') @Roles('store_owner') owner() { return { ok: 1 }; }
  @Get('admin') @Roles('superadmin') admin() { return { ok: 1 }; }
  @Get('forgot-roles') forgot() { return { ok: 1 }; } // no @Roles, not @Public => must be denied
}

describe('auth', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base: PrismaClient;
  let auth: AuthService;
  let A: any, B: any;
  const PW = 'correct-horse-battery';
  const emails: Record<string, string> = {};
  let superEmail: string;

  const host = (t: any) => `${t.subdomain}.localhost`;
  const api = () => request(app.getHttpServer());
  const login = (h: string, email: string, password = PW) => api().post('/auth/login').set('Host', h).send({ email, password });

  async function mkUser(tenant: any | null, role: any, label: string, extra: any = {}) {
    const email = `${label}-${uniq()}@test.local`.toLowerCase();
    const passwordHash = await auth.hashPassword(PW);
    const data = { email, passwordHash, role, ...extra };
    if (tenant) await prisma.runAsTenant(tenant.id, () => prisma.db.user.create({ data }));
    else await prisma.asSystem('test', () => prisma.db.user.create({ data }));
    emails[label] = email;
    return email;
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule], controllers: [ProbeController] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    base = prisma.base;
    auth = app.get(AuthService);
    A = await makeTenant(base);
    B = await makeTenant(base);
    await mkUser(A, 'store_owner', 'ownerA');
    await mkUser(A, 'staff', 'staffA');
    await mkUser(B, 'store_owner', 'ownerB');
    await mkUser(A, 'staff', 'inactiveA', { isActive: false });
    superEmail = await mkUser(null, 'superadmin', 'super');
  });
  afterAll(async () => {
    await base.user.deleteMany({ where: { email: superEmail } });
    await deleteTenants(base, [A.id, B.id]);
    await app.close();
  });

  describe('login', () => {
    it('logs a store owner in on their own store host', async () => {
      const res = await login(host(A), emails.ownerA).expect(200);
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.refreshToken).toBeTruthy();
      const me = await api().get('/auth/me').set('Host', host(A)).set('Authorization', `Bearer ${res.body.accessToken}`).expect(200);
      expect(me.body).toMatchObject({ role: 'store_owner', tenantId: A.id });
    });

    it('rejects bad password / unknown email / inactive user with the same generic 401', async () => {
      const bodies = [
        (await login(host(A), emails.ownerA, 'wrong-password').expect(401)).body,
        (await login(host(A), `nobody-${uniq()}@test.local`).expect(401)).body,
        (await login(host(A), emails.inactiveA).expect(401)).body,
      ];
      expect(new Set(bodies.map((b) => b.message)).size).toBe(1);
    });

    it("a store's user cannot log in on another store or on the platform host", async () => {
      await login(host(B), emails.ownerA).expect(401);
      await login('localhost', emails.ownerA).expect(401);
      await login('admin.localhost', emails.staffA).expect(401);
    });

    it('superadmin logs in on the platform host only', async () => {
      const ok = await login('admin.localhost', superEmail).expect(200);
      const me = await api().get('/auth/me').set('Host', 'admin.localhost').set('Authorization', `Bearer ${ok.body.accessToken}`).expect(200);
      expect(me.body).toMatchObject({ role: 'superadmin', tenantId: null });
      await login(host(A), superEmail).expect(401);
    });

    it('validates input (no huge passwords into argon2, no extra fields)', async () => {
      await api().post('/auth/login').set('Host', host(A)).send({ email: 'not-an-email', password: 'x' }).expect(400);
      await api().post('/auth/login').set('Host', host(A)).send({ email: emails.ownerA, password: 'x'.repeat(5000) }).expect(400);
      await api().post('/auth/login').set('Host', host(A)).send({ email: emails.ownerA, password: PW, role: 'superadmin' }).expect(400);
    });

    it('is case-insensitive on email', async () => {
      await login(host(A), emails.ownerA.toUpperCase()).expect(200);
    });
  });

  describe('access tokens and guards', () => {
    let tokA: string, tokStaffA: string, tokSuper: string, tokB: string;
    beforeAll(async () => {
      tokA = (await login(host(A), emails.ownerA)).body.accessToken;
      tokStaffA = (await login(host(A), emails.staffA)).body.accessToken;
      tokB = (await login(host(B), emails.ownerB)).body.accessToken;
      tokSuper = (await login('admin.localhost', superEmail)).body.accessToken;
    });
    const get = (path: string, h: string, tok?: string) => {
      const r = api().get(path).set('Host', h);
      return tok ? r.set('Authorization', `Bearer ${tok}`) : r;
    };

    it('requires a token', async () => {
      await get('/auth/me', host(A)).expect(401);
      await get('/auth/me', host(A), 'garbage').expect(401);
    });

    it('rejects expired, wrong-secret and alg=none tokens', async () => {
      const jwt = app.get(JwtService);
      const claims = { role: 'store_owner', tid: A.id };
      const expired = jwt.sign(claims, { secret: process.env.JWT_ACCESS_SECRET, subject: randomUUID(), issuer: 'bmstore', audience: 'bmstore-api', expiresIn: -10 });
      const forged = jwt.sign(claims, { secret: 'x'.repeat(40), subject: randomUUID(), issuer: 'bmstore', audience: 'bmstore-api' });
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ ...claims, sub: randomUUID(), iss: 'bmstore', aud: 'bmstore-api' })).toString('base64url')}.`;
      const wrongAud = jwt.sign(claims, { secret: process.env.JWT_ACCESS_SECRET, subject: randomUUID(), issuer: 'bmstore', audience: 'other' });
      for (const t of [expired, forged, none, wrongAud]) await get('/auth/me', host(A), t).expect(401);
    });

    it("a store token is not valid on another store's host or on the platform host", async () => {
      await get('/auth/me', host(B), tokA).expect(403);
      await get('/auth/me', 'admin.localhost', tokA).expect(403);
      await get('/auth/me', host(A), tokB).expect(403);
    });

    it('role guards: owner / staff / superadmin', async () => {
      await get('/probe/owner', host(A), tokA).expect(200);
      await get('/probe/owner', host(A), tokStaffA).expect(403);
      await get('/probe/owner', 'admin.localhost', tokSuper).expect(403);
      await get('/probe/admin', 'admin.localhost', tokSuper).expect(200);
      await get('/probe/admin', host(A), tokA).expect(403);
      await get('/probe/admin', 'admin.localhost', tokStaffA).expect(403);
    });

    it('a route with no @Roles() and not @Public() is denied (fail closed)', async () => {
      await get('/probe/forgot-roles', host(A), tokA).expect(403);
      await get('/probe/forgot-roles', 'admin.localhost', tokSuper).expect(403);
    });

    it('health stays public', async () => {
      await get('/health', host(A)).expect(200);
    });
  });

  describe('refresh tokens', () => {
    it('stores only a hash of the refresh token', async () => {
      const { body } = await login(host(A), emails.ownerA).expect(200);
      const hash = createHash('sha256').update(body.refreshToken).digest('hex');
      const row = await base.refreshToken.findUnique({ where: { tokenHash: hash } });
      expect(row).not.toBeNull();
      expect(row!.tenantId).toBe(A.id);
      expect(await base.refreshToken.count({ where: { tokenHash: body.refreshToken } })).toBe(0);
    });

    it('rotates: new pair works, old token is dead, reuse revokes the whole family', async () => {
      const first = (await login(host(A), emails.ownerA)).body;
      const second = (await api().post('/auth/refresh').set('Host', host(A)).send({ refreshToken: first.refreshToken }).expect(200)).body;
      expect(second.refreshToken).not.toBe(first.refreshToken);
      // replay of the rotated token => theft assumed
      await api().post('/auth/refresh').set('Host', host(A)).send({ refreshToken: first.refreshToken }).expect(401);
      // the legitimate newest token was in the same family and is now revoked too
      await api().post('/auth/refresh').set('Host', host(A)).send({ refreshToken: second.refreshToken }).expect(401);
    });

    it("refresh token from store A cannot be redeemed on store B or the platform host", async () => {
      const t = (await login(host(A), emails.ownerA)).body;
      await api().post('/auth/refresh').set('Host', host(B)).send({ refreshToken: t.refreshToken }).expect(401);
      await api().post('/auth/refresh').set('Host', 'admin.localhost').send({ refreshToken: t.refreshToken }).expect(401);
      await api().post('/auth/refresh').set('Host', host(A)).send({ refreshToken: t.refreshToken }).expect(200);
    });

    it('concurrent redemption of one token yields exactly one success', async () => {
      const t = (await login(host(A), emails.ownerA)).body;
      const rs = await Promise.all(
        [1, 2, 3, 4].map(() => api().post('/auth/refresh').set('Host', host(A)).send({ refreshToken: t.refreshToken })),
      );
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    });

    it('logout revokes the session family', async () => {
      const t = (await login(host(A), emails.ownerA)).body;
      await api().post('/auth/logout').set('Host', host(A)).send({ refreshToken: t.refreshToken }).expect(204);
      await api().post('/auth/refresh').set('Host', host(A)).send({ refreshToken: t.refreshToken }).expect(401);
    });

    it('superadmin refresh works on the platform host', async () => {
      const t = (await login('admin.localhost', superEmail)).body;
      await api().post('/auth/refresh').set('Host', 'admin.localhost').send({ refreshToken: t.refreshToken }).expect(200);
    });

    it('deactivated users cannot refresh', async () => {
      const email = await mkUser(A, 'staff', 'soon-inactive');
      const t = (await login(host(A), email)).body;
      await prisma.runAsTenant(A.id, () => prisma.db.user.updateMany({ where: { email }, data: { isActive: false } }));
      await api().post('/auth/refresh').set('Host', host(A)).send({ refreshToken: t.refreshToken }).expect(401);
    });
  });
});
