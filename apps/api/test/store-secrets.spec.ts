import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Roles } from '../src/auth/decorators';
import { AuthService } from '../src/auth/auth.service';
import { CryptoService } from '../src/crypto/crypto.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { deleteTenants, makeTenant, uniq } from './helpers';

const HASH_SECRET = 'HASHSECRETXYZ987';
@Controller('probe')
class BoomController {
  constructor(private readonly prisma: PrismaService) {}
  /** Provokes a Postgres CHECK failure whose error text embeds the whole row (incl. password_hash). */
  @Get('boom') @Roles('store_owner')
  boom() {
    return this.prisma.db.user.create({ data: { email: 'UPPER@CASE.TEST', passwordHash: HASH_SECRET, role: 'staff' } });
  }
}

describe('razorpay secrets: encrypted at rest, never returned, never logged', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base: PrismaClient;
  let A: any, B: any;
  let tokA: string, tokStaffA: string, tokB: string;
  const KEY_ID = 'rzp_live_AbCdEf123456';
  const KEY_SECRET = 'SuperSecretRazorpayValue-9f8e7d';
  const PW = 'correct-horse-battery';
  const api = () => request(app.getHttpServer());
  const host = (t: any) => `${t.subdomain}.localhost`;

  const captured: string[] = [];
  const spies: jest.SpyInstance[] = [];
  function startCapture() {
    const push = (...a: any[]) => { captured.push(a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack + x.message : JSON.stringify(x))).join(' ')); return true; };
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) spies.push(jest.spyOn(console, m).mockImplementation(push as any));
    spies.push(jest.spyOn(process.stdout, 'write').mockImplementation(((c: any) => push(String(c))) as any));
    spies.push(jest.spyOn(process.stderr, 'write').mockImplementation(((c: any) => push(String(c))) as any));
  }
  const stopCapture = () => spies.splice(0).forEach((s) => s.mockRestore());

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule], controllers: [BoomController] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    base = prisma.base;
    A = await makeTenant(base);
    B = await makeTenant(base);
    const auth = app.get(AuthService);
    const passwordHash = await auth.hashPassword(PW);
    for (const [t, role, email] of [[A, 'store_owner', 'owner-a@t.local'], [A, 'staff', 'staff-a@t.local'], [B, 'store_owner', 'owner-b@t.local']] as const) {
      await prisma.runAsTenant(t.id, () => prisma.db.user.create({ data: { email, passwordHash, role } }));
    }
    const login = async (t: any, email: string) => (await api().post('/auth/login').set('Host', host(t)).send({ email, password: PW }).expect(200)).body.accessToken;
    tokA = await login(A, 'owner-a@t.local');
    tokStaffA = await login(A, 'staff-a@t.local');
    tokB = await login(B, 'owner-b@t.local');
  });
  afterAll(async () => {
    stopCapture();
    await deleteTenants(base, [A.id, B.id]);
    await app.close();
  });

  const put = (tok: string, t: any, body: any) => api().put('/store/razorpay').set('Host', host(t)).set('Authorization', `Bearer ${tok}`).send(body);

  it('only the store owner can set keys; staff and other stores cannot', async () => {
    await put(tokStaffA, A, { keyId: KEY_ID, keySecret: KEY_SECRET }).expect(403);
    await put(tokB, A, { keyId: KEY_ID, keySecret: KEY_SECRET }).expect(403); // B's token on A's host
    await api().put('/store/razorpay').set('Host', host(A)).send({ keyId: KEY_ID, keySecret: KEY_SECRET }).expect(401);
  });

  it('validates the key format', async () => {
    await put(tokA, A, { keyId: 'nope', keySecret: KEY_SECRET }).expect(400);
    await put(tokA, A, { keyId: KEY_ID, keySecret: 'short' }).expect(400);
  });

  it('stores ciphertext only; plaintext is not in the DB; API never returns secrets', async () => {
    startCapture();
    let res: request.Response, masked: request.Response, me: request.Response;
    try {
      res = await put(tokA, A, { keyId: KEY_ID, keySecret: KEY_SECRET });
      masked = await api().get('/store/razorpay').set('Host', host(A)).set('Authorization', `Bearer ${tokA}`);
      me = await api().get('/store/me').set('Host', host(A)).set('Authorization', `Bearer ${tokA}`);
    } finally { stopCapture(); }
    expect(res.status).toBe(204);
    expect(masked.body).toEqual({ configured: true, keyId: 'rzp_live_••••3456' });
    for (const body of [JSON.stringify(res.body), JSON.stringify(masked.body), JSON.stringify(me.body)]) {
      expect(body).not.toContain(KEY_SECRET);
      expect(body).not.toMatch(/razorpay.*enc/i);
    }
    const row = await base.tenant.findUnique({ where: { id: A.id } });
    expect(row!.razorpayKeyEnc).toMatch(/^v1\./);
    expect(row!.razorpaySecretEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(KEY_SECRET);
    expect(JSON.stringify(row)).not.toContain(KEY_ID);
    expect(captured.join('\n')).not.toContain(KEY_SECRET);
    // decrypts for internal (payments) use under the right tenant
    const creds = await prisma.runAsTenant(A.id, () => app.get(require('../src/crypto/tenant-secrets.service').TenantSecretsService).getRazorpayCredentials());
    expect(creds).toEqual({ keyId: KEY_ID, keySecret: KEY_SECRET });
  });

  it('a ciphertext copied into another tenant (or column) does not decrypt', async () => {
    const a = await base.tenant.findUnique({ where: { id: A.id } });
    await base.tenant.update({ where: { id: B.id }, data: { razorpayKeyEnc: a!.razorpayKeyEnc, razorpaySecretEnc: a!.razorpaySecretEnc } });
    await expect(
      prisma.runAsTenant(B.id, () => app.get(require('../src/crypto/tenant-secrets.service').TenantSecretsService).getRazorpayCredentials()),
    ).rejects.toThrow('Decryption failed');
    await base.tenant.update({ where: { id: B.id }, data: { razorpayKeyEnc: null, razorpaySecretEnc: null } });
    expect(app.get(CryptoService)).toBeDefined();
  });

  it('a store cannot overwrite razorpay via the generic tenant update path of another store', async () => {
    await expect(prisma.runAsTenant(B.id, () => prisma.db.tenant.update({ where: { id: A.id }, data: { razorpayKeyEnc: 'x' } }))).rejects.toThrow();
  });

  it('secrets never reach logs, even when Prisma/Postgres errors embed the failing row', async () => {
    captured.length = 0;
    startCapture();
    let status = 0, body = '';
    try {
      await prisma.runAsTenant(A.id, async () => {
        await prisma.db.user.create({ data: { email: 'UPPER@CASE.TEST', passwordHash: HASH_SECRET, role: 'staff' } }).catch(() => undefined);
      });
      const r = await api().get('/probe/boom').set('Host', host(A)).set('Authorization', `Bearer ${tokA}`);
      status = r.status; body = JSON.stringify(r.body);
      await put(tokA, A, { keyId: KEY_ID, keySecret: KEY_SECRET });
      await put(tokA, A, { keyId: KEY_ID, keySecret: 'x' });
      await new Promise((r2) => setTimeout(r2, 200)); // let async Prisma log events flush
    } finally { stopCapture(); }
    const logs = captured.join('\n');
    // a CHECK violation is translated to a plain 400 (common/prisma-errors.ts); neither body nor logs carry the row
    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({ statusCode: 400, message: 'A value is out of range' });
    expect(body).not.toContain(HASH_SECRET);
    expect(logs).not.toContain(HASH_SECRET);
    expect(logs).not.toContain(KEY_SECRET);
    expect(logs).not.toMatch(/Failing row/);
  });
});
