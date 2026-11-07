# BMStore

One multi-tenant ecommerce platform. Each client store is a tenant; one codebase, no per-client code.
Node.js · NestJS 11 · Prisma 6 · PostgreSQL 16 (single DB, `tenant_id` on every tenant-scoped row, row-level security on every table) · Redis · TypeScript.

```
apps/api      NestJS API (tenancy, RLS, auth + login protection + password reset, superadmin, encryption, presigned uploads, isolation gate)
```

## Run it on your laptop

```bash
docker compose up -d                       # Postgres 16 + Redis 7
cp apps/api/.env.example apps/api/.env     # then fill JWT_ACCESS_SECRET, ENCRYPTION_KEY and the app-role password (see comments)
npm ci
npm run migrate:deploy -w apps/api         # runs as the owner role (DATABASE_ADMIN_URL)
npm run db:app-role -w apps/api            # creates the RLS-enforced application role named in DATABASE_URL
SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD='at-least-12-chars' npm run seed:superadmin -w apps/api
npm run start:dev -w apps/api              # http://localhost:3000
```

Stores are reached by Host: `mystore.localhost:3000` (dev), `mystore.bmstore.in` (prod), or a custom domain.
The superadmin API lives on a platform host: `admin.localhost:3000/superadmin/tenants`.

## Tests

```bash
npm test                 # whole suite (needs Postgres + Redis; uses database bmstore_test, redis db 15)
npm run test:gate        # just the tenant-isolation gate
```

`apps/api/test/gate.spec.ts` is the merge gate (see `.github/workflows/ci.yml`). See `PHASE1_REPORT.md`.

## The one rule

Feature code uses `prisma.db` (tenant-scoped, fails closed). `prisma.base` is unscoped and allowlisted by a test.

## Auth endpoints

| Route | Notes |
|---|---|
| `POST /auth/login` | per-IP window (`LOGIN_IP_LIMIT`/min, Redis) and per-account lockout: 5 consecutive failures lock the account for 1 min, doubling per further failure up to 1 h (Postgres, survives Redis). 429 + `Retry-After`. Unknown emails behave identically. |
| `POST /auth/refresh`, `POST /auth/logout` | rotating refresh tokens, family revocation on reuse |
| `POST /auth/forgot-password` | always 202; existing active accounts get a mail (stub transport: `MailerService.outbox`) with a single-use link, 30 min expiry, hash-only storage; previous tokens voided |
| `POST /auth/reset-password` | single-use (atomic), bound to the Host it was issued on, clears lockout, revokes all sessions |

## Uploads

Files never pass through the API. `POST /store/uploads/presign` (owner/staff) returns a short-lived presigned S3 `PUT`
URL for a tenant-prefixed key (`tenants/<tenantId>/<kind>/…`); content type and length are part of the signature.
Works with S3 or any S3-compatible store (`S3_ENDPOINT`, `S3_FORCE_PATH_STYLE=1`). No multipart parser, no multer:
a test fails if one appears, and root `package.json` `overrides` pin the transitive `multer` / `deepmerge-ts` copies
past their advisories.

## Two database roles

| Env var | Role | Used for |
|---|---|---|
| `DATABASE_ADMIN_URL` | owner of the tables (exempt from RLS) | `prisma migrate`, tenant resolution, the audited superadmin bypass (`prisma.base`) |
| `DATABASE_URL` | `bmstore_app`: LOGIN, NOSUPERUSER, NOBYPASSRLS, owns nothing | everything `prisma.db` does |

Postgres row-level security (migration `*_row_level_security`) is the second isolation layer: the scoped client pins the
tenant with a transaction-local `set_config('app.tenant_id', …, true)` before every query, and the policies on every
table only let that tenant's rows through. With nothing pinned (the app layer bypassed) the database returns and accepts
nothing. The API refuses to boot if the application role could sidestep RLS or if any table lacks a policy.
