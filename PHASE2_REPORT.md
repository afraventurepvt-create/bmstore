# Phase 2 report

Status: **all 7 items built, one commit each (plus one for the item-1 API and one for docs/screenshots), 455/455 tests
passing locally** (16 suites; Phase 1 ended at 294). `npm audit`: production dependencies **0 vulnerabilities**; full tree
0 high / 0 moderate, 7 low (jest's `deepmerge`, dev-only, no fixed release). Nothing merged; the branch is
`claude/clever-pasteur-tjop17`.

> Same caveat as Phase 1: GitHub Actions has not run from this sandbox. The workflow was extended (admin build step) and
> every CI step was rehearsed locally in order. Your first push of the branch runs it for real.

| # | Commit | What |
|---|--------|------|
| 1 | `feat(api): store admin API …` | products/variants/categories, orders, customers, coupons, pages, settings, theme, profile, dashboard |
| 2 | `feat(import): CSV / XLSX product import …` | raw-body upload, csv-parse + exceljs, rupees→paise, per-row report, templates, dry run, upsert |
| 3 | `feat(media): bulk image upload …` | presign/complete, sharp worker (WebP 1600 + 400 thumb, EXIF stripped), media bytes, MinIO in compose |
| 4 | `feat(limits): fair-use limits …` | 2,000 products / 10 GB per tenant, trigger-kept counters, `GET /store/usage`, superadmin edits |
| 5 | `feat(admin): mobile-first store admin UI` | Next.js 15 at `apps/admin`, cookie proxy, all screens, WhatsApp help, Tamil fonts |
| 6 | `test(gate): cover every new model, every store route …` | router-driven route matrix, cross-tenant id probes, media paths |
| 7 | `feat(seed): demo store seed …` | `npm run seed:demo`, 25 products + generated images, 500-row CSV, tests for both |

## How to run locally

```bash
docker compose up -d                                  # Postgres 16, Redis 7, MinIO (bucket "bmstore", console :9001)
cp apps/api/.env.example apps/api/.env                # fill JWT_ACCESS_SECRET, ENCRYPTION_KEY; S3_* already point at MinIO
npm ci
npm run migrate:deploy -w apps/api                    # owner role
npm run db:app-role -w apps/api                       # RLS-enforced app role (password from DATABASE_URL)
npm run seed:demo -w apps/api                         # demo store: http://demo.localhost:3001, owner@demo.test / demo-password-123
npm run start:dev -w apps/api                         # API on :3000
npm run dev -w apps/admin                             # admin on :3001 (open it on the store host, e.g. demo.localhost:3001)
```

Tests: `npm test` (needs Postgres + Redis; object storage is an in-process S3 double started by jest) and
`npm run test:gate`. Admin: `npm run build -w apps/admin`.

## What was built

### 1. Store admin API (`apps/api/src/{catalog,orders,crm,content,settings}`)

Every route under `/store` runs in the Host-resolved tenant through the Prisma extension and RLS; roles `store_owner` /
`staff` (settings, theme and profile writes are owner-only). Consistent list shape `{ items, total, page, pageSize }`,
query-string filters, plain-language errors (Prisma errors are translated: 409 "This SKU is already in use", 404, 400,
plan limit 403).

- **Products**: list (search name/SKU/slug, status, category, low stock, sort), create with slug auto-generation
  (de-duplicated `-2`, `-3`; Tamil names fall back to `product-xxxxxx`), MRP ≥ price, images restricted to the tenant's
  own media URLs, update, stock by absolute value or delta, bulk `ACTIVATE | DRAFT | ARCHIVE | DELETE`, variants CRUD
  with stock. STARTER cap and fair-use limit give friendly 403s before the database says no.
- **Categories**: nested (3 levels), cycle check, tree + product counts, cannot delete with children or products.
- **Orders**: list with filters (status, open, payment, mode, date range, search by order no / phone / name), detail
  with parsed items and history, status moves per `ORDER_TRANSITIONS` (cancel/return restocks items), payment-status
  moves, one-tap `mark-paid` for COD, all audited. `GET /store/dashboard`: today's orders and sales (IST), to-pack,
  open, low stock, COD to collect.
- **Customers**: list with spend/last order, detail with orders, update name/email/addresses.
- **Coupons**: `PERCENT` whole percent ≤ 100, `FLAT` paise, upper-cased unique codes, expiry.
- **Pages**: CRUD; `POST /store/pages/policies` creates the five standard Indian policy pages.
- **Settings**: shipping `FLAT | FREE | FREE_ABOVE`, per-city overrides (`settings.city_rates`), COD on/off and charge,
  order prefix, low-stock threshold. **Theme** read/update (hex colours, own-media logo and banners). **Profile**
  (name, address, GST, phones). `GET /store/public` for login-screen branding.

### 2. Import (`src/imports`)

`POST /store/import/products?filename=…[&dryRun][&status][&mode=upsert]` with the file bytes as the request body
(no multipart parser anywhere; `express.raw` for CSV/XLSX types, 25 MB). `csv-parse` for CSV (BOM, `;`/tab,
Windows line endings, latin1 fallback), `exceljs` for `.xlsx`. Headings matched case/space-insensitively; `name`,
`price`, `mrp` required. Rupees → paise strictly (≤ 2 decimals). Every row validated; valid rows imported in chunks of
100 with row-level fallback so a database error lands on the right row. Report: `{ totalRows, imported, updated, failed,
errors: [{ row, reason }], warnings }` with sheet row numbers. Categories found or created by name; `image_filename`
resolves against READY media (unmatched = warning, product still imports). Modes: create (existing SKUs reported) or
upsert (update matching SKUs). Templates: `GET /store/import/products/template?format=csv|xlsx`. Tested with a 600-row
file (7 deliberately broken rows), the 500-row seed file (0 failures, ~0.4 s) and XLSX.

### 3. Media (`src/media`, `src/storage`)

`POST /store/media/presign` (≤ 50 files) → presigned PUTs to `tenants/<tenantId>/originals/…` (Content-Type and
Content-Length signed) → browser uploads → `POST /store/media/complete` (HEAD-verified, size must match) → worker:
auto-rotate, resize to longest edge 1600 (never enlarge), WebP q82, 400 px thumbnail, metadata dropped (EXIF proven
gone in tests), original deleted, `bytes` = webp + thumb. Claims use one `UPDATE … SKIP LOCKED` on the owner connection
(the only cross-tenant step, allowlisted in the gate); each item is processed inside `runAsTenant`. 3 attempts then
`FAILED` with a plain reason. Worker runs in-process (`MEDIA_WORKER=1`, interval + poke after complete). One
`ObjectStorageService` for MinIO/R2/S3 (`requestChecksumCalculation: WHEN_REQUIRED` for R2/MinIO). MinIO added to
docker-compose with the bucket created and made public-read. Tests use an in-process S3 double (`test/s3-fake.ts`).

### 4. Fair-use limits (`src/limits`)

`tenants.max_products` (2,000) and `tenants.max_media_mb` (10,240), per tenant, superadmin-editable
(`PATCH /superadmin/tenants/:id/limits`, audited). Counters in `tenant_usage` (product rows, media bytes as `bigint`)
are maintained by `AFTER` triggers on `products` and `media`, so a check is one row read and sums cannot overflow.
Enforced in product create, import (rows past the room fail individually), media presign (announced bytes on top of
stored bytes). `GET /store/usage` shows plan, products used/limit/live/live-limit and media used/limit; the admin's
Settings screen renders it as meters.

### 5. Admin UI (`apps/admin`)

Next.js 15 (app router) + Tailwind 4, hand-designed (warm paper background, teal brand, saffron accent, Noto Sans +
Noto Sans Tamil). Screens: login (forgot/reset flow, store branding), dashboard, products list/edit (photos via the
presigned pipeline, variants, stock, bulk actions), import with the per-row report, orders list/detail with one-tap
status and COD mark-paid plus call/WhatsApp the customer, customers, coupons, pages (+ policy pages), settings
(shipping, city rates, COD, prefix, store details, usage meters) and look & logo. Mobile-first: bottom tabs, 48 px tap
targets, no horizontal overflow at 390 px (checked by Playwright), plain-language copy, "Get help on WhatsApp"
(`wa.me/919403892971`) on login, header and More. No onboarding wizard.

Auth: `/api/*` route handlers proxy to the API with the browser's store **Host** (Node `http.request`; `fetch` drops
Host) and keep the token pair in httpOnly cookies; 401 → one refresh and retry; middleware redirects signed-out visitors.
Smoke-tested end to end against the API and rendered with Playwright.

### 6. Gate (`test/gate.spec.ts`, 324 tests)

Models come from the DMMF, so `media`, `tenant_usage` and `password_reset_tokens` went through the app-layer and RLS
matrices automatically. New: route inventory read from the Express router (54 `/store` routes today): anonymous → 401,
other store's owner on this host → 403, this owner on the other host → 403, superadmin routes → 403 for owners.
Cross-tenant id probes through every id-taking admin route answer 404 / touch 0 rows; lists never leak. Media paths:
B's media URLs refused on A's products/categories/theme, presigned keys under `tenants/<A>/`, B's upload ids
NOT_FOUND, import cannot attach B's image filename. Final byte-for-byte snapshot still holds. Runs in CI (`test:gate`).

### 7. Seed (`scripts/seed-demo.ts`, `seed/`)

`npm run seed:demo`: recreates "Sri Lakshmi Silks" (`demo`), owner + staff logins, settings, theme, 4 categories,
25 products from `seed/demo-products.csv`, 25 generated placeholder images (sharp-rendered SVG) pushed through the real
media pipeline and attached by `image_filename`, 6 customers, 12 orders in every status (3 dated today), 2 coupons,
policy pages. `seed/test-500-products.csv` (500 rows, 20 categories). `test/seed.spec.ts` runs the seed (25 READY WebP
images, dashboard numbers, login, clean re-seed) and imports the 500-row file with 0 failures.

## Test output

```
Test Suites: 16 passed, 16 total
Tests:       455 passed, 455 total
```

| Suite | Tests | Covers |
|---|---:|---|
| `gate.spec.ts` | 324 | isolation matrix: app layer, RLS, HTTP routes, cross-tenant ids, media paths |
| `admin-api.spec.ts` | 15 | item 1 end to end |
| `import.spec.ts` | 6 | item 2 (600 rows, upsert, XLSX, templates, bad files, cap) |
| `media.spec.ts` | 6 | item 3 (pipeline, EXIF, orientation, batch, failures, isolation, import hookup) |
| `limits.spec.ts` | 4 | item 4 |
| `seed.spec.ts` | 2 | item 7 |
| `plans.spec.ts` | 6 | STARTER cap incl. archived products, enum/paise columns |
| `auth.spec.ts`, `auth-protection.spec.ts` | 29 | login, tokens, lockout, reset |
| others | 63 | superadmin, tenant resolution, secrets, crypto, uploads, tenant-scope |

Screenshots (390 px wide, 2×): `docs/screenshots/s2/01-login.png`, `02-dashboard.png`, `03-products.png`,
`04-order-detail.png`, `05-import-report.png`, `06-settings.png`.

## Decisions I made (please confirm) and things I am unsure about

1. **Import default is "make live"** (`status=ACTIVE`); the admin has a toggle for drafts. Unmatched `image_filename`
   is a warning, not an error.
2. **Fair-use product limit counts every product row** (any status); the STARTER cap counts live ones. Variants do not count.
3. **Originals are deleted after processing** (only the WebP and the thumbnail are stored and counted). Keeping originals
   would roughly triple storage against the 10 GB; say if you want them kept.
4. **Image limits**: 12 MB per file (`UPLOAD_MAX_BYTES`), 12 photos per product, 50 files per presign batch,
   80-megapixel decode guard. WebP quality 82 / thumb 78.
5. **Order cancel / return restocks** the items (products or variants) automatically. Refunds for ONLINE payments are a
   manual payment-status change until Razorpay is wired (Phase 3).
6. **Dashboard "to pack" = PENDING + CONFIRMED**; "today" is midnight IST.
7. **Orders are only created by the seed and tests today** (no storefront checkout yet). `orders.items` has a defined
   shape (`src/orders/order-items.ts`) the checkout must write.
8. **Admin is served on the store host** (`demo.localhost:3001`, in production the store domain on an admin path or
   port of your choosing) so one deployment serves every store. Tokens in httpOnly cookies, 30-day refresh.
9. **Tests use an S3 double, not MinIO.** docker-compose brings MinIO for developers; CI stays dependency-free. The
   S3 client is the same code path.
10. **Google Fonts are loaded at runtime** (no network in CI builds). Fallbacks: Latha / Nirmala UI / system.
11. **Admin has no automated UI test suite** beyond the Playwright render/flow check I ran manually (kept as a scratch
    script). Adding Playwright e2e to CI is a Phase 3 candidate.
12. **Staff can do almost everything** except settings/theme/profile writes. If you want staff read-only on prices or
    customers, it is one decorator per route.
13. `GET /store/public` exposes name, status, support/WhatsApp numbers and theme colours/logo to anyone on the host
    (needed by the login screen and later the storefront).
14. Not built on purpose (Phase 3): storefront, checkout/Razorpay, invoices, notifications, staff management.

## Audit

`npm audit`: production 0; dev 7 low (`deepmerge` via jest). Overrides in the root `package.json` pin transitive
copies past their advisories: `multer@2.5.0`, `deepmerge-ts@^8.0.2`, `uuid@^11.1.1` (exceljs), `postcss@^8.5.23`
(Next's bundled copy). No multer, no deepmerge-ts in our code; a test fails if a multipart parser is imported.
