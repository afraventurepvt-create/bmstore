# Deploying the API

Three steps, always in this order. The API refuses to start if step 2 was skipped or done wrong.

```bash
npm ci
npm run build -w apps/api
```

## 1. Migrate, as the owner role

```bash
npm run migrate:deploy -w apps/api
```

Uses `DATABASE_ADMIN_URL` (the role that owns the tables; it needs to be able to run DDL). Never run migrations as the
application role.

## 2. Create or refresh the application role

```bash
npm run db:app-role -w apps/api
```

Connects with `DATABASE_ADMIN_URL` and makes sure the user named in `DATABASE_URL` exists with that password, is
`NOSUPERUSER NOBYPASSRLS`, owns nothing, and can read/write every table (including tables future migrations add).
Idempotent: safe to run on every deploy. Changing the app-role password = change it in `DATABASE_URL`, rerun this.

## 3. Start the API

```bash
npm run start -w apps/api        # node apps/api/dist/main.js
```

On boot the API checks that row-level security is enforceable (app role not a superuser, no BYPASSRLS, owns no table;
every table has a policy). If it is not, it logs the reason and exits.

## Environment

Copy `apps/api/.env.example`. Required: `DATABASE_URL`, `DATABASE_ADMIN_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`
(≥ 32 chars), `ENCRYPTION_KEY` (32 random bytes, base64), `ROOT_DOMAIN` (`bmstore.in` in production),
`TRUST_PROXY=1` behind the load balancer. Optional: `S3_*` for uploads (unset = uploads disabled), login-protection
knobs, `PASSWORD_RESET_URL_TEMPLATE`.

## First deploy only

```bash
SUPERADMIN_EMAIL=you@example.com SUPERADMIN_PASSWORD='at-least-12-chars' npm run seed:superadmin -w apps/api
```

## Rollback

Migrations are forward-only. Roll the application back to the previous build; the previous build must be compatible
with the current schema (keep migrations additive, or ship the code change one release before the destructive step).
