# deploy/

| File | Purpose |
|------|---------|
| `docker-compose.prod.yml` | The production stack (profiles: `minio`, `web`, `tools`) |
| `compose.sh` | Wrapper: `docker compose` with the env file `/etc/bmstore/production.env`, repo root, current image tag |
| `deploy.sh` | pull → build → pre-deploy dump → migrate (owner) → app-role grants → switch → health → rollback on failure |
| `server-setup.sh` | One-time Ubuntu bootstrap: Docker, deploy user, SSH keys-only, ufw, fail2ban, auto-updates, swap |
| `install-cron.sh` | Installs backup + monitoring cron jobs and logrotate |
| `ci-entry.sh` | Forced command for the GitHub Actions SSH key (only the deploy script can be run) |
| `.env.production.example` | Every variable, documented — copy to `/etc/bmstore/production.env` |
| `docker/` | Dockerfiles: `api` (runtime + migrate targets), `web` (frontends), `caddy` (xcaddy + rate-limit), `backup` |

Start with `docs/runbooks/GO_LIVE.md`.
