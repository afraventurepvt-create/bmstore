# infra/

Runtime configuration mounted or executed by the production stack (`deploy/docker-compose.prod.yml`).

| Path | Purpose |
|------|---------|
| `caddy/Caddyfile` | Edge: on-demand TLS gated by tls-ask, security headers, rate limits, routing (default) |
| `caddy/Caddyfile.wildcard` | Same, with a `*.store.bmtechx.in` wildcard certificate via DNS-01 (needs a DNS plugin) |
| `tls-ask/` | Zero-dependency service answering Caddy's `ask` — approves only real tenant hosts (`node test.js`) |
| `postgres/app-role.sql` | Creates/updates the non-owner `bmstore_app` role and its grants (`db:app-role`) |
| `postgres/initdb/` | First-boot hook that applies `app-role.sql` |
| `redis/redis.conf` | Persistence, memory policy, disabled dangerous commands |
| `backup/` | `backup.sh` (nightly/weekly/predeploy), `restore.sh`, `restore-test.sh`, run inside the `backup` container |
| `monitoring/` | Cron checks (uptime, disk/media, SSL, failed jobs) and `notify.sh` (stdout/webhook/WhatsApp) |
| `cron/` | `/etc/cron.d/bmstore` and logrotate templates (installed by `deploy/install-cron.sh`) |

Runbooks: `docs/runbooks/`.
