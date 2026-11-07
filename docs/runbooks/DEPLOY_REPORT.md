# Deploy report — infrastructure for one-VPS production

Scope delivered: `/infra`, `/deploy`, `/docs/runbooks` and `.github/workflows/deploy.yml`. **No application code was
changed** (`apps/`, `package.json`, `docker-compose.yml`, `ci.yml` untouched).

## 1. What was built

| Requirement | Where | Status |
|---|---|---|
| Production Compose: api, storefront, admin, console, Postgres 16, Redis, MinIO or S3/R2, Caddy | `deploy/docker-compose.prod.yml`, `deploy/docker/*.Dockerfile`, `deploy/compose.sh`, `deploy/.env.production.example` | built; frontends behind the `web` profile because `apps/storefront|admin|console` do not exist yet |
| App DB role = non-owner `bmstore_app`, migrations as owner | `infra/postgres/app-role.sql`, `initdb/01-app-role.sh`, `migrate` service (owner URL), `api` service (app URL) | built and **tested against Postgres 16** |
| Caddy: on-demand TLS gated by an "ask" endpoint, HTTP→HTTPS, security headers, rate limits | `infra/caddy/Caddyfile` (+ `Caddyfile.wildcard`), `infra/tls-ask/`, `deploy/docker/caddy.Dockerfile` | built; tls-ask **unit-tested** (14 cases); Caddyfile syntax not machine-validated (see §2) |
| Deploy script: pull, build, migrate:deploy, db:app-role, health check, rollback | `deploy/deploy.sh` | built; **dry-run tested**; real run needs Docker |
| GitHub Actions manual deploy over SSH, secrets documented | `.github/workflows/deploy.yml`, `docs/runbooks/DEPLOY.md`, `deploy/ci-entry.sh` (forced command) | built; YAML parsed; not executed |
| Backups: nightly + weekly, 30-day retention, object storage, restore script, monthly restore test with pass/fail | `infra/backup/*.sh`, `deploy/docker/backup.Dockerfile`, `infra/cron/bmstore.cron` | built; **nightly backup, restore, and restore-test executed locally** (local-only mode, no bucket) |
| Monitoring: per-tenant uptime, disk/media, SSL expiry, failed-job alerts to WhatsApp via a notification stub | `infra/monitoring/*.sh`, `notify.sh` | built; alert state machine unit-tested; checks need a live stack |
| Hardening runbook | `docs/runbooks/SERVER_HARDENING.md`, automated by `deploy/server-setup.sh` | written; script shellcheck-clean, not executed (needs a root Ubuntu box) |
| DNS runbook | `docs/runbooks/DNS.md` | written |
| GO_LIVE checklist | `docs/runbooks/GO_LIVE.md` | written |

## 2. What was verified in this sandbox (no Docker daemon, no public network)

| Check | Result |
|---|---|
| `shellcheck -S warning` on every script in `deploy/`, `infra/backup/`, `infra/monitoring/` | clean |
| `docker compose config` (all profiles) with the example env filled in | valid; api gets `bmstore_app` URL, migrate gets owner URL |
| `infra/postgres/app-role.sql` on a real Postgres 16 with the 3 project migrations applied | role created; DML works; `CREATE TABLE` denied; `_prisma_migrations` denied; tables created later by the owner automatically granted; re-run idempotent; password rotation via stdin works |
| `infra/tls-ask/test.js` (fake API) | 14/14: tenant subdomain + custom domain + suspended → allow; unknown, root, reserved, nested, IP, invalid → deny |
| `backup.sh nightly` → `restore-test.sh` → `restore.sh --target-db` → refuse live without `--yes` | all behaved as designed against local Postgres (local-only mode) |
| `deploy.sh --dry-run --no-pull` | correct step order, state files written, no secret in the log |
| `ci-entry.sh` | allows `deploy <ref> <safe flags>` / `status`; rejects `;`, shells, other flags |
| Monitoring `alert_state` | alert once → suppressed → recovery → silent |
| `.github/workflows/deploy.yml` | parses as YAML; logic reviewed by hand |
| Caddyfiles | brace-balanced; env placeholders listed; **not** loaded by a Caddy binary |

## 3. Could NOT be tested without a real server — verify on day one
1. **Docker image builds** (`api.Dockerfile`, `web.Dockerfile`, `caddy.Dockerfile` via xcaddy, `backup.Dockerfile`).
   Risk points: the `prod-deps` stage (`npm ci --omit=dev --ignore-scripts` + `npm rebuild argon2`) and copying the
   generated Prisma client (`node_modules/.prisma`) from the build stage. If `api` fails to start with a Prisma engine
   error, add `COPY --from=build /app/node_modules/prisma ./node_modules/prisma` or run `npx prisma generate` in `prod-deps`.
2. **Caddy configuration load** with the rate-limit plugin: `order rate_limit after header`, the `rate_limit` zone syntax
   (`match`/`key`/`events`/`window`), `on_demand_tls { ask … }` and the `https://` + `http://` catch-all sites. First
   deploy: `./deploy/compose.sh logs caddy` must not show `adapting config`/`unrecognized directive` errors.
   Also confirm `{$ROOT_DOMAIN}` placeholders in site addresses expand (they are substituted before parsing).
3. **Real certificate issuance** (Let's Encrypt/ZeroSSL rate limits, port 80/443 reachability, the ask round-trip).
   `Caddyfile.wildcard` (DNS-01, `CADDY_DNS_PLUGIN`) is entirely untested and provider-specific.
4. **Compose health gating**: `up --wait`, the `node -e fetch(...)` health commands, `caddy` health via `wget :2019/metrics`
   (admin endpoint; if disabled, replace with `caddy version`).
5. **Redis `rename-command`** lines in `infra/redis/redis.conf` with the `redis:7-alpine` image (deprecated but supported);
   the health check uses `redis-cli ping` which is unaffected.
6. **MinIO** image tags pinned to 2025 releases and `mc anonymous set download` for public read of the media bucket;
   adjust if your MinIO/mc versions differ. MinIO console at `minio.<root>` is exposed through Caddy — restrict by IP or
   remove that site if you do not need it.
7. **Backups to a real bucket** (rclone S3 provider settings for R2/DO Spaces/Hetzner; `--s3-no-check-bucket`), the
   weekly media sync, retention deletes, the `LATEST` markers, and `age` encryption/decryption.
8. **`server-setup.sh`** end to end on Ubuntu 22.04/24.04 (sshd drop-in precedence, ufw, fail2ban `backend=systemd`,
   unattended-upgrades reboot), and that your provider image does not override `authorized_keys` on reboot (cloud-init).
9. **GitHub Actions** run: secrets, `ssh-keyscan` known_hosts format with a non-22 port, the forced-command key path.
10. **Monitoring against the live stack**: `docker ps` label filtering (`com.docker.compose.project=bmstore`),
    `compose exec -T postgres psql` without a password (unix socket trust inside the official image), `compose exec minio du`,
    Redis `--scan` with `-a`. WhatsApp Cloud API delivery (template approval) and webhook formats.
11. **Deploy rollback for real** (image retag/`--no-build` with a previous tag that still exists locally; images are
    pruned only when older than 7 days and untagged, so the previous tag survives).
12. **Resource sizing**: Postgres `shared_buffers=512MB` etc. assume ≥ 4 GB; the api memory limit is 1 GB; builds on a
    4 GB box rely on the 2 GB swap created by `server-setup.sh`.

## 4. Assumptions and decisions to confirm
- **ROOT_DOMAIN** is `store.bmtechx.in`; the Phase 1 README mentions `bmstore.in` — the env file is the single place to change it.
- **Platform hosts**: `api.`, `admin.` (store-owner app), `console.` (superadmin app), `media.`/`minio.` (bundled MinIO),
  root + `www.` redirect to `console.`. `console`, `media`, `minio` are **not** in the API's `reservedSubdomains`
  (`apps/api/src/config/app-config.ts`), so tls-ask denies them itself and Caddy proxies `console.<root>/api/*` with
  `Host: api.<root>` so superadmin calls work. Adding them to `reservedSubdomains` in Phase 2 would be cleaner.
- **Tenant API path**: `https://<tenant-host>/api/*` → API with the tenant Host (prefix stripped). The API's own CORS is
  not configured (Phase 1 report #9), so same-origin `/api` is the intended pattern for the frontends.
- **Subdomain certificates** are issued per host on demand by default (works with any DNS provider; LE limit 50 new
  certificates per registered domain per week). Switch to `Caddyfile.wildcard` when you have a DNS API token.
- **Suspended/expired tenants still get certificates** (tls-ask treats the API's 403 as "exists") so visitors see the
  proper 403 instead of a TLS error.
- **Custom domains** can only be set at tenant creation in Phase 1 (no update endpoint); DNS.md documents the SQL stopgap.
- **Rollback never reverts migrations**; a pre-deploy dump is taken for that purpose.
- **Secrets** live in `/etc/bmstore/production.env` outside the repo (the repo's `.gitignore` only covers `.env`).
- **`deploy` user has passwordless sudo**; it is root-equivalent through the docker group anyway. The CI key is restricted
  to the deploy script via a forced command.
- **Failed-job alerts** have real targets today (service health, backup freshness, deploy status) and a Redis
  `bull:*:failed` probe for the workers that do not exist yet; the WhatsApp transport is wired but needs Meta credentials
  and an approved template — hence "stub".
- Docker log rotation, `read_only` root fs for api/tls-ask, `no-new-privileges` everywhere, memory limit on api.

## 5. Suggested first-day order
GO_LIVE.md steps 1–10, then run **every** "could not be tested" item above that applies, in the order listed. Expect to
spend most of the time on §3 items 1–3; everything after them is scriptable and already exercised.
