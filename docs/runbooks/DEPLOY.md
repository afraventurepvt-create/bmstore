# Deploy runbook

## 1. What a deploy does (`deploy/deploy.sh`)
Run on the server as `deploy`, in `/opt/bmstore`. Steps, in order:

| # | Step | Command behind it | On failure |
|---|------|-------------------|------------|
| 1 | Pull the requested ref (default `DEPLOY_BRANCH=main`) | `git fetch` + `merge --ff-only` (or detach on a tag/sha) | abort; nothing changed |
| 2 | Build images tagged with the git sha | `compose build --pull api migrate tls-ask caddy backup` (+ web profile) | abort; nothing changed |
| 2b | Data services up | `compose up -d --wait postgres redis (minio)` | abort |
| 3 | Pre-deploy DB dump → bucket `postgres/predeploy/` | `compose run backup predeploy` | abort before touching the schema (`--no-backup` skips) |
| 4 | Migrations as the **owner** role | `compose run migrate` → `prisma migrate deploy` | abort; old release keeps running, alert sent |
| 5 | `db:app-role` grants for `bmstore_app` | `psql -f infra/postgres/app-role.sql` (password via stdin) | abort |
| 6 | Switch api / tls-ask / caddy (+ frontends) to the new tag | `compose up -d --no-build` | **rollback** |
| 7 | Health: api container `healthy` (≤150 s), Caddy answers on :80, HTTPS check (warn only) | `compose ps`, `curl` | **rollback** |

Rollback = previous image tag + previous git commit for the app services, then the same health wait, then a
critical alert. **Migrations are never reverted automatically** — Prisma migrations are forward-only. If a deploy
rolled back after a migration ran, the old code is running against the new schema; that is normally fine for
additive migrations. For destructive ones restore the pre-deploy dump (BACKUP_RESTORE.md §3) after stopping the api.

State files in `/var/lib/bmstore`: `current_tag`, `previous_tag`, `current_sha`, `previous_sha`, `last_deploy`
(`OK|FAILED|ROLLED_BACK <utc> <tag> <sha>`), `deploy.lock`. Log: `/var/log/bmstore/deploy.log`.

## 2. Commands
```bash
./deploy/deploy.sh                       # deploy main
```
```bash
./deploy/deploy.sh v1.4.0                # deploy a tag/branch/commit
```
```bash
./deploy/deploy.sh --rollback            # back to the previous release
```
```bash
./deploy/deploy.sh --no-pull             # redeploy the checkout as-is (after editing the env file)
```
```bash
./deploy/deploy.sh --app-role-only       # only re-apply grants (after rotating APP_DB_PASSWORD)
```
```bash
./deploy/deploy.sh --dry-run             # print the steps without running them
```
Day-to-day:
```bash
./deploy/compose.sh ps
```
```bash
./deploy/compose.sh logs -f --tail=100 api
```
```bash
./deploy/compose.sh exec postgres psql -U bmstore -d bmstore
```
```bash
./deploy/compose.sh run --rm migrate npx prisma migrate status
```
```bash
./deploy/compose.sh restart caddy
```

## 3. GitHub Actions (manual trigger)
Workflow: `.github/workflows/deploy.yml` → Actions → **Deploy to production** → *Run workflow*. Inputs: `ref`
(default `main`), `skip_backup`, `dry_run`. The runner only SSHes in and runs `deploy/deploy.sh`; builds happen on
the server, so no registry is needed. One deploy at a time (`concurrency: deploy-production`).

### Secrets (repo → Settings → Secrets and variables → Actions → *New repository secret*)
| Secret | Value | How to get it |
|--------|-------|---------------|
| `DEPLOY_HOST` | server IP or DNS name | provider console |
| `DEPLOY_USER` | `deploy` | — |
| `DEPLOY_PORT` | `22` (optional) | — |
| `DEPLOY_APP_DIR` | `/opt/bmstore` (optional) | — |
| `DEPLOY_SSH_KEY` | **private** key, full text incl. `-----BEGIN/END-----` lines | step below |
| `DEPLOY_KNOWN_HOSTS` | server host key line(s) | `ssh-keyscan -p 22 SERVER_IP 2>/dev/null` (run from your laptop; paste all lines) |

Optional repository **variable** `ROOT_DOMAIN` (used only for the environment URL shown in the run).

### Create a dedicated deploy key, restricted to the deploy script
On your laptop:
```bash
ssh-keygen -t ed25519 -N "" -f ./github-deploy -C github-deploy
```
`cat ./github-deploy` → secret `DEPLOY_SSH_KEY`. Then on the server append the **public** key with a forced command,
so this key can run nothing except the deploy:
```bash
echo "command=\"/opt/bmstore/deploy/ci-entry.sh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat ./github-deploy.pub)" >> ~/.ssh/authorized_keys
```
Delete `./github-deploy` from your laptop afterwards. (`server-setup.sh --ci-key "<public key>"` does the same line.)
`deploy/ci-entry.sh` accepts only `deploy <ref> [--no-backup] [--skip-migrate] [--rollback] [--dry-run]` and `status`.

### Approval gate (optional)
Settings → Environments → `production` → *Required reviewers*. The job targets `environment: production`, so the run
pauses until a reviewer approves.

### First run
Run with `dry_run = true`; the log should show `DRY:` lines coming from the server. Then run for real.

## 4. Frontends (storefront / admin / console)
`apps/storefront`, `apps/admin`, `apps/console` do not exist yet. When they land:
1. each needs `npm run build` and `npm start` honouring `PORT` (3000) — see `deploy/docker/web.Dockerfile`;
2. set `COMPOSE_PROFILES=minio,web` (or `web`) and change `STOREFRONT_UPSTREAM=storefront:3000`,
   `ADMIN_UPSTREAM=admin:3000`, `CONSOLE_UPSTREAM=console:3000` in the env file;
3. `./deploy/deploy.sh`.
Routing (infra/caddy/Caddyfile): tenant hosts → storefront, with `/api/*` proxied to the API with the tenant Host
(prefix stripped); `admin.`/`console.` → their app, with `/api/*` proxied as the **platform** host
(`api.<root>`), which is what superadmin routes need. Store-scoped calls from the admin app must therefore go to
`https://<store-host>/api/...` (same pattern the storefront uses), or the routing must be adapted.

## 5. Troubleshooting
| Symptom | Look at | Usual cause |
|---------|---------|-------------|
| `api not healthy after 150s` | `./deploy/compose.sh logs --tail=200 api` | missing/invalid env var (the API fails fast on `ENCRYPTION_KEY`, `JWT_ACCESS_SECRET` < 32 chars, bad `DATABASE_URL`) |
| `migration FAILED` | same command on `migrate`; `npx prisma migrate status` | failed SQL; fix forward with a new migration |
| `edge check FAILED` | `./deploy/compose.sh logs caddy` | Caddyfile error (plugin missing → rebuild caddy), port 80 in use |
| HTTPS warns but HTTP 308 ok | `logs caddy` for `obtaining certificate` | DNS not pointing here yet, port 443 blocked, LE rate limit |
| Tenant host: TLS handshake fails | `logs tls-ask` | `decision: deny` → host not a tenant / not active; `api-error` → API down |
| `another deploy is running` | `cat /var/lib/bmstore/last_deploy`; `ps aux \| grep deploy.sh` | a stuck run; kill it, remove nothing else |
| Out of disk | `docker system df`; MONITORING.md | prune old images: `docker image prune -af --filter "until=168h"` |
