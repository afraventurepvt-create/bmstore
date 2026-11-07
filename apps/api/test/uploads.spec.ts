/** Direct-to-S3 presigned uploads: signed offline, so no network is needed. */
// This suite asserts the AWS-shaped URL, so it overrides the S3 double configured by setup-env.ts and restores it after.
const SAVED = Object.fromEntries(['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PUBLIC_BASE_URL', 'S3_ENDPOINT', 'S3_FORCE_PATH_STYLE'].map((k) => [k, process.env[k]]));
Object.assign(process.env, { S3_BUCKET: 'bm-test-bucket', S3_REGION: 'ap-south-1', S3_ACCESS_KEY_ID: 'AKIATESTKEY', S3_SECRET_ACCESS_KEY: 'test-secret', S3_PUBLIC_BASE_URL: 'https://cdn.example.test', S3_ENDPOINT: '', S3_FORCE_PATH_STYLE: '0' });

import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { AppConfig } from '../src/config/app-config';
import { PrismaService } from '../src/prisma/prisma.service';
import { ObjectStorageService } from '../src/storage/object-storage.service';
import { UploadsService } from '../src/uploads/uploads.service';
import { createApp, deleteTenants, makeTenant, uniq } from './helpers';

describe('uploads: presigned direct-to-S3 PUTs', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base: PrismaClient;
  let cfg: AppConfig;
  let A: any, B: any, tokA: string, tokStaffA: string, tokB: string;
  const PW = 'correct-horse-battery';
  const api = () => request(app.getHttpServer());
  const host = (t: any) => `${t.subdomain}.localhost`;
  const presign = (t: any, tok: string, body: any) => api().post('/store/uploads/presign').set('Host', host(t)).set('Authorization', `Bearer ${tok}`).send(body);

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    base = prisma.base;
    cfg = app.get(AppConfig);
    A = await makeTenant(base);
    B = await makeTenant(base);
    const auth = app.get(AuthService);
    const passwordHash = await auth.hashPassword(PW);
    const mk = async (t: any, role: any) => {
      const email = `${role}-${uniq()}@up.test`;
      await prisma.runAsTenant(t.id, () => prisma.db.user.create({ data: { email, passwordHash, role } }));
      return (await api().post('/auth/login').set('Host', host(t)).send({ email, password: PW }).expect(200)).body.accessToken;
    };
    tokA = await mk(A, 'store_owner');
    tokStaffA = await mk(A, 'staff');
    tokB = await mk(B, 'store_owner');
  });
  afterAll(async () => {
    await deleteTenants(base, [A.id, B.id]);
    await app.close();
    for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('owner and staff of the store can presign; anonymous and other stores cannot', async () => {
    const body = { kind: 'product', contentType: 'image/jpeg', size: 1234 };
    await api().post('/store/uploads/presign').set('Host', host(A)).send(body).expect(401);
    await presign(A, tokB, body).expect(403);
    await presign(A, tokStaffA, body).expect(200);
    await presign(A, tokA, body).expect(200);
  });

  it('issues a tenant-prefixed key and a PUT URL whose signature pins content type, length and expiry', async () => {
    const r = await presign(A, tokA, { kind: 'product', contentType: 'image/png', size: 2048 }).expect(200);
    expect(r.body).toMatchObject({ method: 'PUT', expiresIn: 300, headers: { 'Content-Type': 'image/png', 'Content-Length': '2048' } });
    expect(r.body.key).toMatch(new RegExp(`^tenants/${A.id}/product/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.png$`));
    expect(r.body.publicUrl).toBe(`https://cdn.example.test/${r.body.key}`);
    const u = new URL(r.body.uploadUrl);
    expect(u.protocol).toBe('https:');
    expect(u.host).toBe('bm-test-bucket.s3.ap-south-1.amazonaws.com');
    expect(u.pathname).toBe(`/${r.body.key}`);
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Credential')).toMatch(/^AKIATESTKEY\/\d{8}\/ap-south-1\/s3\/aws4_request$/);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(u.searchParams.get('X-Amz-SignedHeaders')!.split(';').sort()).toEqual(['content-length', 'content-type', 'host']);
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.uploadUrl).not.toContain('test-secret');
    // every presign is a fresh object; another store's keys live under its own prefix
    const r2 = await presign(A, tokA, { kind: 'banner', contentType: 'image/webp', size: 1 }).expect(200);
    expect(r2.body.key).not.toBe(r.body.key);
    expect(r2.body.key).toMatch(/\.webp$/);
    const rb = await presign(B, tokB, { kind: 'logo', contentType: 'image/jpeg', size: 10 }).expect(200);
    expect(rb.body.key.startsWith(`tenants/${B.id}/logo/`)).toBe(true);
  });

  it('rejects non-image types, bad sizes and unknown kinds', async () => {
    await presign(A, tokA, { kind: 'product', contentType: 'application/x-sh', size: 10 }).expect(400);
    await presign(A, tokA, { kind: 'product', contentType: 'text/html', size: 10 }).expect(400);
    await presign(A, tokA, { kind: 'product', contentType: 'image/jpeg', size: 0 }).expect(400);
    await presign(A, tokA, { kind: 'product', contentType: 'image/jpeg', size: cfg.uploadMaxBytes + 1 }).expect(400);
    await presign(A, tokA, { kind: 'product', contentType: 'image/jpeg', size: 1.5 }).expect(400);
    await presign(A, tokA, { kind: 'backup', contentType: 'image/jpeg', size: 10 }).expect(400);
    await presign(A, tokA, { kind: 'product', contentType: 'image/jpeg', size: 10, key: 'tenants/other/x.jpg' }).expect(400); // no client-chosen keys
  });

  it('works against S3-compatible endpoints (path style) and answers 503 when not configured', async () => {
    const mk = (over: Partial<AppConfig>) => { const c = { ...cfg, ...over } as AppConfig; return new UploadsService(c, new ObjectStorageService(c)); };
    const compat = mk({ s3Endpoint: 'http://localhost:9000', s3ForcePathStyle: true, s3PublicBaseUrl: undefined });
    const r = await prisma.runAsTenant(A.id, () => compat.presign({ kind: 'page', contentType: 'image/gif', size: 5 }));
    expect(r.uploadUrl.startsWith(`http://localhost:9000/bm-test-bucket/tenants/${A.id}/page/`)).toBe(true);
    expect(r.publicUrl).toBe(`http://localhost:9000/bm-test-bucket/${r.key}`);
    const off = mk({ s3Bucket: undefined });
    expect(off.configured).toBe(false);
    await expect(prisma.runAsTenant(A.id, () => off.presign({ kind: 'page', contentType: 'image/gif', size: 5 }))).rejects.toThrow(/not configured/);
    await expect(compat.presign({ kind: 'page', contentType: 'image/gif', size: 5 })).rejects.toThrow(/No tenant context/);
  });

  it('static check: no multipart parser in the API (no multer / FileInterceptor), and the audited packages are pinned past their advisories', () => {
    const root = join(__dirname, '..', 'src');
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const USES_PARSER = /from '(multer|busboy|@fastify\/multipart)'|require\('(multer|busboy|@fastify\/multipart)'\)|\b(File|Files|AnyFiles|FileFields)Interceptor\b/;
    const offenders = walk(root).filter((f) => f.endsWith('.ts')).filter((f) => USES_PARSER.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
    const deps = { ...require('../package.json').dependencies, ...require('../package.json').devDependencies };
    expect(Object.keys(deps)).not.toEqual(expect.arrayContaining(['multer', 'deepmerge-ts']));
    // transitive copies (via @nestjs/platform-express and prisma's CLI config) are forced to fixed versions by root overrides
    const semverGte = (v: string, min: [number, number, number]) => { const p = v.split('.').map(Number); return p[0] > min[0] || (p[0] === min[0] && (p[1] > min[1] || (p[1] === min[1] && p[2] >= min[2]))); };
    const installed = (pkg: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'node_modules', pkg, 'package.json'), 'utf8')).version as string;
    expect(semverGte(installed('multer'), [2, 5, 0])).toBe(true); // GHSA-q7qp-rjg7-q26m fixed in 2.5.0
    expect(semverGte(installed('deepmerge-ts'), [8, 0, 0])).toBe(true); // GHSA-ggr8-5vv4-36mx fixed in 8.0.0
    expect(JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')).overrides).toMatchObject({ multer: expect.any(String), 'deepmerge-ts': expect.any(String) });
  });
});
