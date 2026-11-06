# Phase 1 report

Status: **all 7 items built, committed one-by-one, 294/294 tests passing locally.**
Not done on purpose: anything from Phase 2.

> Honest caveat up front: I could not run GitHub Actions from this sandbox. I validated the workflow YAML, and
> rehearsed every CI step (fresh clone → `npm ci` → `migrate deploy` on an empty DB → drift check → typecheck →
> gate) locally. The first real run will be on your first push — see "Decisions / unsure" #15.

## What was built (one commit per numbered item)

| # | Item | Where |
|---|------|-------|
| 1 | Prisma schema + 3 migrations, `.env.example`, `docker-compose.yml`, monorepo scaffold | `apps/api/prisma/`, `docker-compose.yml` |
| 2 | Host → tenant middleware (`store.localhost`, `store.bmstore.in`, custom domain), Redis cache 5 min, tenant in `AsyncLocalStorage` request context | `src/tenancy/`, `src/common/request-context.ts` |
| 3 | Prisma client extension that injects `tenant_id` into every read/write; audited superadmin bypass | `src/prisma/tenant-scope.ts`, `prisma.service.ts` |
| 4 | JWT access + rotating refresh tokens, fail-closed role guards | `src/auth/` |
| 5 | Superadmin API: create / list / get / suspend / unsuspend / set expiry | `src/superadmin/` |
| 6 | AES-256-GCM for Razorpay keys; secrets kept out of logs | `src/crypto/`, `src/store/`, `common/safe-exception.filter.ts` |
| 7 | **The gate test** + GitHub Actions workflow | `test/gate.spec.ts`, `.github/workflows/ci.yml` |

### How isolation works (defence in depth)

1. **Prisma extension** wraps *every* operation on *every* model. Inside a tenant context it ANDs `tenant_id` into
   `where` and forces it into `data`; a foreign `tenantId` is rejected; with **no context it throws** (never
   "unscoped by default"). Unique-key operations keep their key and get the tenant filter ANDed beside it.
   Nested `connect/connectOrCreate/set` are refused (they could attach another tenant's row). Raw SQL is disabled on the
   scoped client. The client refuses to build if any Prisma model is unclassified.
2. **Composite foreign keys** `(tenant_id, x_id) → (tenant_id, id)` for order→customer, product→category,
   category→parent, refresh_token→user: the *database* refuses cross-tenant references even if the app code were wrong.
3. **Variants** have no `tenant_id` (per your spec), so they're scoped through `product.tenant_id`; the extension verifies
   product ownership on every create/update/upsert.
4. **Superadmin bypass is explicit** (`prisma.asSuperadmin(actor, reason, fn)`) and writes an `audit_logs` row for *every*
   operation inside (model, operation, redacted filter, data **keys only**, never values). `audit_logs` is append-only,
   enforced by a DB trigger. Pre-login superadmin lookup uses a narrower `asPlatform` scope (only `tenant_id IS NULL` rows,
   only 3 models), not a bypass.
5. **HTTP**: a store user's token only works on its own store's host; suspended/expired stores get 403 on every route; the
   role guard denies any route that has neither `@Public()` nor `@Roles()`.

## Test output

Full suite (`npm test`, real Postgres 16 + Redis 7):

```
PASS test/gate.spec.ts
PASS test/superadmin.spec.ts
PASS test/auth.spec.ts
PASS test/store-secrets.spec.ts
PASS test/tenant-scope.spec.ts
PASS test/tenant-resolution.spec.ts
PASS test/tenant-resolver.prod.spec.ts
PASS test/crypto.spec.ts

Test Suites: 8 passed, 8 total
Tests:       294 passed, 294 total
```

| Suite | Tests | Covers |
|---|---:|---|
| `gate.spec.ts` | 221 | the isolation matrix (below) |
| `auth.spec.ts` | 19 | login, wrong-host login, expired/forged/`alg=none` tokens, role guards, refresh rotation + replay → family revoked, concurrent refresh, logout |
| `tenant-scope.spec.ts` | 17 | extension behaviours, transactions, platform scope, audit rows without secrets, append-only |
| `tenant-resolution.spec.ts` | 11 | subdomain/custom domain, 404/403, cache TTL, no secrets cached, Redis-down fallback |
| `superadmin.spec.ts` | 10 | RBAC, create/list/suspend/expiry take effect immediately, audit rows, seed script |
| `store-secrets.spec.ts` | 6 | ciphertext-only storage, never returned, **never logged** (incl. a provoked DB error that embeds the row) |
| `crypto.spec.ts` | 6 | round-trip, tamper, AAD binding, key parsing |
| `tenant-resolver.prod.spec.ts` | 4 | `acme.bmstore.in` shape, Host-header tricks |

### The gate (`test/gate.spec.ts`)

Two tenants; rows written in **all 13 models** for each, *as that tenant*. For every model, in both directions (A→B and B→A):
reads (`findMany/First/Unique/OrThrow`, `count`, `aggregate`, `groupBy`; `OR`/`NOT`/`in`/relation filters; `include`
traversal), `update`/`delete`/`upsert` by id **and** by compound key, filtered and unfiltered `updateMany/deleteMany`
(unfiltered ones inside rolled-back transactions, asserting the count equals *own* rows only), create with a foreign
`tenantId`/product/FK, moving a row to the other tenant, nested connect/set. Plus: every operation × every model fails
closed with no context; platform scope; audited bypass; tenants cannot raise their own plan/status/expiry/domain; an HTTP
cross-host token test; a static check that nothing outside an allowlist touches the unscoped client; and a final
byte-for-byte snapshot proving no attack changed either tenant's data.

The model list comes from the **Prisma DMMF**, not a hand-written list: add a table without classifying it in `SCOPES` and
without a factory in the test, and the suite fails.

**I mutation-tested the gate** (a test that has never failed proves little): I deliberately broke the isolation engine
~25 ways — drop `where` scoping on filter ops / unique ops / `upsert` / `deleteMany` / `count` / `groupBy` /
`findUniqueOrThrow` / `update` / `delete`, skip the variant ownership check, allow foreign `tenantId` on create or update,
allow nested `connect`, unscope the tenants table, allow tenant deletes, remove the audit-log append-only guard, remove
fail-closed-on-no-context, allow platform scope everywhere, stop auditing the bypass, remove the tenant self-write
whitelist, re-enable raw SQL. **Every one is caught** (the first run missed the tenant self-escalation case; I added it to
the gate). Two of my first mutants "survived" only because a second guard (unknown-operation rejection) caught them; I
re-ran them in a form that isolates the scoping line, and they are caught too.

CI rehearsal result (fresh clone, empty DB): `3 migrations applied`, `No difference detected`, gate `221 passed`.

## Things I added that your spec didn't list (please review)

- **`refresh_tokens` table** (hash only, family id, rotation, reuse detection). Needed for refresh tokens.
- `users.is_active`; `products.created_at/updated_at`; enums for statuses (see #6 below).
- DB integrity rules in migration 2: superadmin ⇔ `tenant_id IS NULL` CHECK; unique superadmin email; lower-case email CHECK; append-only `audit_logs`.
- Semantic audit rows (`tenant.created/suspended/…`) on top of the per-query bypass rows.
- `GET/PUT /store/razorpay` (owner-only) and `GET /store/me` so item 6 is exercisable end-to-end and role guards have real routes.
- `seed-superadmin` script (you need a first superadmin somehow).

## Decisions I need from you / things I'm unsure about

1. **Prisma 6.19 + NestJS 11 pinned.** Prisma's npm `latest` tag is currently a release candidate (8.0.0-rc), so I stayed on the last stable 6.x line. Say if you want 7.x.
2. **Types don't enforce "can't forget" at compile time.** `prisma.db` is typed as the plain `PrismaClient`, so TypeScript still demands `tenantId` on `create` (the runtime injects/validates it; passing it is allowed, a *wrong* one is rejected). Options: (a) thin typed wrapper that makes `tenantId` optional, (b) **Postgres Row-Level Security** with `DEFAULT current_setting('app.tenant_id')`, which also gives a third, database-level layer. I recommend (b) before real customer data; it's a Phase-2-sized change and I didn't want to add it unasked.
3. **Variants rely on the app layer only** (no `tenant_id` column, so the DB can't enforce it). If you're open to it I'd denormalise `tenant_id` onto `variants` with a composite FK to products — it's the one table where the DB can't back up the extension.
4. **Prisma-promise gotcha:** queries are lazy and run when *awaited*. Inside HTTP requests this is invisible, but background jobs/queues must use `prisma.runAsTenant(id, fn)` (it awaits inside the scope). Forgetting it fails **closed** (throws), never leaks. Worth knowing before Phase 2 workers.
5. **`prisma.base` is an unscoped escape hatch** (tenant resolution and audit writer need it). A test fails the build if any non-allowlisted file touches it. Raw SQL on `prisma.db` is disabled.
6. **Enum/vocabulary guesses** since the doc wasn't available: `plan` is free text (default `starter`); `status` active|suspended; product status draft|active|archived; payment mode cod|online; payment status pending|paid|failed|refunded; order status placed→…→delivered|cancelled|returned; coupon type percent|flat; shipping mode flat|free|free_above; money is `Decimal(12,2)`; `customer_id` on orders is required (no guest orders); `tenants.address` is plain text. All cheap to change now, annoying later.
7. **Audit volume:** every operation under a superadmin bypass (including reads) writes a row, **before** it executes (so attempts that fail are still recorded). Safe, but noisy; if you'd rather audit only writes, it's a one-line change.
8. **Not audited yet:** logins, token refreshes, failed logins. Recommended before launch.
9. **Not built (outside the Phase 1 list, but needed before production):** login rate-limiting/lockout, password reset, CORS/helmet, request-size limits, structured access logs, Redis persistence config, key rotation procedure for `ENCRYPTION_KEY` (ciphertext is versioned `v1.` so rotation is possible).
10. **Access tokens (15 min) aren't re-checked against the DB.** A deactivated user or changed role stays valid up to 15 minutes (refresh is checked). Suspending a *store* is immediate (checked per request via the Redis-cached tenant, invalidated on change).
11. **Cache details:** unknown hosts are negatively cached 60 s (so random Host headers can't hammer Postgres); creating a tenant invalidates that entry. Behind a proxy set `TRUST_PROXY=1` so `X-Forwarded-Host` is honoured — otherwise leave it `0`.
12. **Custom domains** are looked up as the exact Host (no automatic `www.` ↔ apex mapping) and no DNS/TLS verification exists yet.
13. **`npm audit` (prod deps): 5 high**, all unfixable without major bumps: `multer` (DoS in file-upload handling, pulled in by `@nestjs/platform-express`; there are no upload endpoints yet, so not reachable today) and `deepmerge-ts` (inside Prisma's CLI config). Revisit at Phase 2 when uploads arrive.
14. **Local environment:** Postgres 16 and Redis 7 were already installed in the sandbox; I started them with `pg_ctlcluster`/`redis-server` and created DBs `bmstore` and `bmstore_test` with a *superuser* role named `bmstore`. That's fine locally; in production the app should connect as a non-superuser role (and that's a prerequisite if you adopt RLS in #2). `docker-compose.yml` is for your laptop and was **not** run here (no Docker daemon).
15. **CI has not run on GitHub yet.** Pushing the branch triggers it. The workflow has two jobs — `Tenant isolation gate` (must pass) and `Typecheck, build and full test suite`. To make the gate truly blocking, mark **"Tenant isolation gate"** as a required status check in branch protection (I can't change repo settings).
16. **Spec reading:** `slug` and `subdomain` are both unique columns as listed (usually equal). A store's own profile edits are limited to name/address/GST/phones/Razorpay keys; plan, status, expiry, slug, subdomain and custom domain are superadmin-only (enforced in the extension, covered by the gate).

## Run it

See `README.md`. Quick version: `docker compose up -d`, copy `.env.example` → `.env` and fill the two secrets,
`npm ci`, `npm run migrate:deploy -w apps/api`, `npm run seed:superadmin -w apps/api`, `npm run start:dev -w apps/api`.
