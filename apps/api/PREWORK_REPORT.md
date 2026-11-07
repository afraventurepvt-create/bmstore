# Pre-work report (decisions A–E)

Status: **all five done, one commit each, 379/379 tests passing locally** (was 294). `npm audit`: **0 high** (production
dependencies: 0 vulnerabilities; 7 low, all dev-only, see E).

| # | Commit | What changed |
|---|--------|--------------|
| A | `feat(db): Postgres row-level security …` | RLS on every table, pinned per transaction; two DB roles; boot check; gate test attacks the database directly |
| B | `feat(db): tenant_id on variants …` | `variants.tenant_id` backfilled, composite FK to products, tenant-first indexes, RLS on the column |
| C | `feat(db): fixed vocabulary as Prisma enums and money as integer paise` | the exact enum values, Int paise everywhere, data-mapping migration, STARTER cap trigger, status semantics |
| D | `feat(auth): login rate limiting, account lockout with backoff, password reset` | per-IP + per-account limits, DB lockout 1m→1h, reset tokens (single-use, 30 min), stub mailer |
| E | `feat(uploads): presigned direct-to-S3 uploads …` | `POST /store/uploads/presign`, no multipart parser, `multer`/`deepmerge-ts` overridden past their advisories |

## A. Row-level security

**Design.** Two database roles, one database:

| Env | Role | Used by |
|---|---|---|
| `DATABASE_ADMIN_URL` | owner of the tables (Postgres exempts owners from RLS) | `prisma migrate` (`directUrl`), tenant resolution, the audited superadmin/system bypass, tests' `prisma.base` |
| `DATABASE_URL` | `bmstore_app`: LOGIN, NOSUPERUSER, NOBYPASSRLS, owns nothing | everything `prisma.db` does |

`scripts/db-app-role.ts` (`npm run db:app-role`) creates/updates the application role from the two URLs: grants DML on
existing tables and default privileges for tables future migrations create, revokes `_prisma_migrations`. CI runs it
after `migrate deploy`; the jest global setup does the same.

**Pinning.** Policies read `app_tenant_id()` = `nullif(current_setting('app.tenant_id', true), '')::uuid` (and
`app_platform_scope()` for `tenant_id IS NULL` rows of `users` / `refresh_tokens` / `password_reset_tokens` /
`audit_logs`). The extension pins the scope with a **transaction-local** `set_config(..., true)`:

- a single operation runs as `$transaction([pin, query])`, so the pin and the statement share a connection and the
  pin dies at COMMIT (pooled connections can never carry a stale tenant);
- `db.$transaction(fn | [...])` pins once on the transaction's connection; operations inside see
  `__internalParams.transaction` and skip the wrap;
- the bypass runs on the owner connection, still audited per operation; opening a bypass *inside* a tenant
  transaction is refused (its statements would run on another connection).

With nothing pinned every comparison is NULL: **the database shows and accepts no rows**. That is the guarantee for
"the app layer is bypassed": not another tenant's rows, zero rows.

**Boot check** (`src/prisma/rls-check.ts`): the API refuses to start if the app role is a superuser, has BYPASSRLS or
owns any model table, if any model table lacks RLS or a policy (new tables cannot ship unscoped at the DB level
either), or if the owner connection could not bypass. There is no override switch.

**Gate test** additions (`DATABASE LAYER` section, 43 tests): a plain `PrismaClient` on the app role with no extension
at all. For every model: nothing pinned → `findMany/count/findUnique` empty, `updateMany/deleteMany` 0, raw
`SELECT/DELETE` 0, inserting even a perfectly valid row refused by the policy. Pinned as A attacking B and vice
versa: unscoped `findMany` returns exactly A's rows, every targeted read/update/delete of B's rows is 0 (Prisma and
raw SQL), inserting into B or moving a row to B fails `WITH CHECK`. Platform pin sees only NULL-tenant rows and
cannot write into a tenant. The pin is proven transaction-local. Mutation-tested: `DISABLE ROW LEVEL SECURITY` or
`DROP POLICY` on any table is caught by the boot check; a *permissive* policy (`USING (true)`) is caught by the gate.

**Cost.** Every tenant-scoped Prisma operation outside an explicit transaction is now a 2-statement transaction
(one extra round trip). Fine at this scale; if it ever matters, group hot paths in `db.$transaction`.

## B. `variants.tenant_id`

Added and backfilled from `products` in the migration (verified against pre-existing rows), `NOT NULL`, composite FK
`(tenant_id, product_id) → products(tenant_id, id)` (so `products` gained `UNIQUE (tenant_id, id)`), indexes:
`UNIQUE (tenant_id, id)`, `UNIQUE (tenant_id, product_id, option_name, option_value)` (replaces the product-only
one), `UNIQUE (tenant_id, sku)`, `INDEX (tenant_id, product_id)`. The extension lost its special "via product" scope
and the per-write ownership lookup; the only model without `tenant_id` is `tenants` itself (asserted by the gate).
No other table lacked it.

## C. Vocabulary and money

Enums exactly as specified: `TenantPlan`, `TenantStatus`, `ProductStatus`, `PaymentMode`, `PaymentStatus`,
`OrderStatus`, `CouponType`. Money is `Int` paise on products, variants, orders, coupons, settings; a gate test
asserts no `Float`/`Decimal` field exists in any model, and `plans.spec.ts` checks the Postgres column types and the
enum label lists. The migration maps data (`active→LIVE`, `suspended→SUSPENDED`, `placed→PENDING`,
`starter→STARTER`, any other plan→`STANDARD`, lower→UPPER) and converts `DECIMAL` rupees with `round(x*100)`.

Judgement calls, please confirm:

1. **`ShippingMode`** was not in your list; I upper-cased it (`FLAT|FREE|FREE_ABOVE`) so every enum follows one
   convention. Cheap to change.
2. **`coupons.value`** for `PERCENT` coupons is a whole percent (CHECK ≤ 100); for `FLAT` it is paise.
3. **`Int` (32-bit)** caps a single amount at ₹2,14,74,836.47. Plenty for these stores; say so if you want `BigInt`.
4. **STARTER = 10 products** is enforced by a `BEFORE INSERT` trigger on `products` that locks the tenant row
   (concurrent inserts serialise; `createMany` past the cap is rejected whole; binds the owner connection too).
   `PLAN_LIMITS` in `src/tenancy/plans.ts` is exported for the products API to give a friendly 4xx first. A
   STANDARD→STARTER downgrade keeps existing products and blocks new ones. Archived products count.
5. **Status semantics**: `BUILDING` and `LIVE` are served on the store host (admins can set the store up);
   `SUSPENDED` and `PARKED` answer 403 (`Store suspended` / `Store parked`). New tenants start `BUILDING`. The public
   storefront, when it lands, must additionally require `LIVE`; `SERVES_REQUESTS` in `plans.ts` is the single place
   to adjust. Superadmin API: `POST :id/status {status}` (any value) and `PATCH :id/plan {plan}` were added; the
   `suspend`/`unsuspend` shortcuts remain (`unsuspend` → `LIVE`). Redis tenant-cache key bumped to `v2`.
6. `UserRole` (`superadmin|store_owner|staff`) was not in the list and is unchanged.

## D. Login protection and password reset

- **Per IP**: `LOGIN_IP_LIMIT` (20) per `LOGIN_IP_WINDOW_SECONDS` (60) in Redis → 429 + `Retry-After`. Also on
  `forgot-password` and `reset-password` (`FORGOT_PER_IP_LIMIT`). **Fails open** if Redis is down (logged).
- **Per account**: `users.failed_login_attempts` / `locked_until` in Postgres (survives Redis). 5 consecutive failures
  lock for 60 s; each further failure doubles it (2 m, 4 m, …) up to 1 h. A locked account gets 429 even with the
  right password. Success or password reset clears it. Lockouts write `auth.account_locked` audit rows.
- **No enumeration**: unknown emails get the identical 401×5 then 429 sequence through a Redis mirror of the lockout
  (asserted side by side in the test). Inactive accounts with the right password are refused without counting.
- **Reset**: `POST /auth/forgot-password` always 202; for an existing active account it voids older tokens, stores
  only the sha256 of a 256-bit token (30 min, `password_reset_tokens`, composite FK to `users(tenant_id, id)`, RLS)
  and emails a link built from the request Host (`PASSWORD_RESET_URL_TEMPLATE`). Per-email window (3 / 15 min) stops
  mail floods (still 202, nothing sent). `POST /auth/reset-password` flips `used_at` atomically (4 concurrent
  redemptions → one 204), sets the password, clears the lockout, revokes every refresh-token family, audits. A token
  is scoped to the host it was issued on: store A's token is a 400 on store B and on the platform host.
- **Mailer** is a stub (`MailerService`): in-memory outbox, logs recipient masked, never the body. Swap `deliver()`
  for SES/SMTP later.

## E. Uploads and the audit

- **Direct-to-S3 presigned PUTs** (`src/uploads`): `POST /store/uploads/presign {kind, contentType, size}` →
  `{ key, uploadUrl, headers, expiresIn, publicUrl }`. Keys are `tenants/<tenantId>/<kind>/<yyyy>/<mm>/<uuid>.<ext>`
  (clients cannot choose keys); only image types; size ≤ `UPLOAD_MAX_BYTES` (5 MiB); `Content-Type` and
  `Content-Length` are signed headers, so the object can only be what was approved; 5 minute URLs. Works with S3
  or S3-compatible stores (`S3_ENDPOINT`, path style). Unset `S3_BUCKET` → 503. Signing is offline, so tests need
  no network. No multipart parser exists in the API and a test fails if `multer`/`busboy`/`@fastify/multipart` or a
  Nest `FileInterceptor` is ever imported.
- **`multer` and `deepmerge-ts`** are not used by our code but are transitive: `multer` via
  `@nestjs/platform-express` (Nest's Express adapter hard-depends on it), `deepmerge-ts` via Prisma's CLI config
  loader (dev-only). Root `package.json` `overrides` force `multer@2.5.0` and `deepmerge-ts@^8.0.2`, the first
  versions past GHSA-q7qp-rjg7-q26m and GHSA-ggr8-5vv4-36mx; a test checks the installed versions. Prisma's CLI
  (`generate`, `migrate deploy/status/diff`, `validate`) was exercised with deepmerge-ts 8 and works. Dropping
  multer from the tree entirely means moving to `@nestjs/platform-fastify`; I did not do that unasked.
- **`npm audit` after everything**:
  - production dependencies (`--omit=dev`): **0 vulnerabilities**
  - full tree: **0 high / 0 critical / 0 moderate, 7 low**, all one advisory: `deepmerge` (GHSA-gcqx-w48m-w2h4,
    prototype poisoning) pulled in by `jest-config` → `jest` / `ts-jest`. Dev-only, not in the runtime image, and
    there is no fixed `deepmerge` release yet (npm's only "fix" is a downgrade to jest 25). Nothing to do but watch.
  - **No high severity findings remain.**

## Things to know

- **Run order on a new database**: `migrate:deploy` (owner URL) → `db:app-role` → start. The API refuses to start if
  the app role could sidestep RLS, so a misconfigured deployment fails loudly, not silently.
- `prisma migrate dev` needs the owner role to be able to create the shadow database (local superuser is fine).
- Jest keeps handles open if `beforeAll` fails on the RLS boot check; `--forceExit` is a workaround while
  debugging, not needed on green runs.
- CI workflow updated (`DATABASE_ADMIN_URL`, `db:app-role` step, drift check against the owner URL). It has still
  not run on GitHub from this sandbox; the first push of this branch triggers it.
