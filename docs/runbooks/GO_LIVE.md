# GO LIVE — BMStore on one VPS

A numbered checklist for a developer who has never run a production server. Do the steps in order;
each one says how to check it worked. Budget: about 2 hours plus DNS waiting time.

Assumptions: Ubuntu 22.04/24.04 VPS with 4–8 GB RAM (Hetzner CX22/CPX21 or DigitalOcean 4 GB), the
domain `bmtechx.in` managed at your domain provider, a GitHub account with this repo, and a laptop with
`ssh`. The platform root is `store.bmtechx.in`; stores live at `<slug>.store.bmtechx.in`.

Companion runbooks: [SERVER_HARDENING.md](SERVER_HARDENING.md) · [DNS.md](DNS.md) · [DEPLOY.md](DEPLOY.md) ·
[BACKUP_RESTORE.md](BACKUP_RESTORE.md) · [MONITORING.md](MONITORING.md) · [DEPLOY_REPORT.md](DEPLOY_REPORT.md)

---

## A. Before you touch the server

1. **Create an SSH key on your laptop** (skip if `~/.ssh/id_ed25519.pub` exists):
   ```bash
   ssh-keygen -t ed25519 -C "you@laptop"
   cat ~/.ssh/id_ed25519.pub
   ```
   ✅ You can print a line starting with `ssh-ed25519`.

2. **Create the VPS** (Hetzner: Ubuntu 24.04, CPX21/CX22, add your SSH key in the wizard; DigitalOcean: Ubuntu 24.04,
   4 GB Basic droplet, "SSH key" authentication). Note the public IPv4 address, call it `SERVER_IP`.
   ✅ `ssh root@SERVER_IP` logs in without a password.

3. **Create two object-storage buckets** — one for media, one for backups (ideally at a different provider/account
   than the VPS so a lost server never means lost backups). Cloudflare R2 is free up to 10 GB:
   R2 → Create bucket `bmstore-backups` → Manage R2 API tokens → "Object Read & Write" token scoped to that bucket.
   Save: endpoint (`https://ACCOUNT_ID.r2.cloudflarestorage.com`), access key, secret key.
   If you prefer to keep media on the VPS, the stack bundles MinIO; you then only need the backup bucket.
   ✅ You have endpoint + access key + secret for the **backup** bucket (and for media, unless using MinIO).

4. **DNS** — follow [DNS.md](DNS.md) section 1 now (records take time to propagate):
   `A store.bmtechx.in → SERVER_IP` and `A *.store.bmtechx.in → SERVER_IP`.
   ✅ `dig +short api.store.bmtechx.in` prints `SERVER_IP` (may take 5–60 min).

## B. Prepare the server (once)

5. **Harden and install Docker** — as root on the server, run the bootstrap script
   (details and the manual equivalent in [SERVER_HARDENING.md](SERVER_HARDENING.md)):
   ```bash
   ssh root@SERVER_IP
   ```
   ```bash
   curl -fsSL https://raw.githubusercontent.com/afraventurepvt-create/bmstore/main/deploy/server-setup.sh -o server-setup.sh
   ```
   ```bash
   bash server-setup.sh --ssh-key "$(echo 'PASTE_YOUR_ssh-ed25519_PUBLIC_KEY_HERE')"
   ```
   It creates the `deploy` user, disables password + root SSH logins, enables the firewall (SSH/80/443), fail2ban,
   automatic security updates, swap and Docker.
   ✅ **Open a second terminal** and confirm `ssh deploy@SERVER_IP` works **before** closing the root session.
   ✅ `sudo ufw status` shows `Status: active` with 22, 80, 443 allowed.

6. **Clone the repository as `deploy`**:
   ```bash
   ssh deploy@SERVER_IP
   ```
   ```bash
   git clone https://github.com/afraventurepvt-create/bmstore.git /opt/bmstore && cd /opt/bmstore
   ```
   (private repo: create a read-only deploy key on GitHub → Settings → Deploy keys, or use a fine-grained PAT.)
   ✅ `ls /opt/bmstore/deploy` lists `deploy.sh`, `compose.sh`, `docker-compose.prod.yml`.

7. **Create the environment file** (secrets live outside the repo, in `/etc/bmstore/production.env`):
   ```bash
   sudo install -m 640 -o root -g deploy deploy/.env.production.example /etc/bmstore/production.env
   ```
   ```bash
   sudo nano /etc/bmstore/production.env
   ```
   Fill every `CHANGE_ME_*`. Generate values with `openssl rand -base64 48` (passwords, JWT) and
   `openssl rand -base64 32` (**ENCRYPTION_KEY** — exactly this command). Set `ACME_EMAIL`, the `BACKUP_S3_*` block,
   and either keep `MEDIA_BACKEND=minio` (set `MINIO_ROOT_*` = `S3_ACCESS_KEY/S3_SECRET_KEY`) or set `MEDIA_BACKEND=s3`
   with your media bucket details and `COMPOSE_PROFILES=` (empty).
   ✅ `grep -c CHANGE_ME /etc/bmstore/production.env` prints `0`.
   ✅ `./deploy/compose.sh config --quiet` prints nothing (no errors).

8. **Save ENCRYPTION_KEY and the DB passwords somewhere safe off the server** (password manager). Losing
   `ENCRYPTION_KEY` makes every stored Razorpay secret unrecoverable; backups are useless without it.
   ✅ The key is in your password manager.

## C. First deploy

9. **Run the first deploy** (builds images on the server; 5–10 minutes the first time):
   ```bash
   cd /opt/bmstore && ./deploy/deploy.sh --no-pull
   ```
   The script: builds → starts Postgres/Redis(/MinIO) → pre-deploy dump (local only until the bucket is configured)
   → `prisma migrate deploy` as the owner role → grants for `bmstore_app` → starts api/tls-ask/caddy → health checks.
   ✅ Last line reads `=== deploy OK: <tag>`.
   ✅ `./deploy/compose.sh ps` shows `api`, `caddy`, `tls-ask`, `postgres`, `redis` (and `minio`) as `running (healthy)`.

10. **Check the platform host over HTTPS** (DNS from step 4 must be live):
    ```bash
    curl -i https://api.store.bmtechx.in/health
    ```
    ✅ `HTTP/2 200` with `{"ok":true,"tenant":null}` and a valid certificate (no `-k` needed).
    If it fails: `./deploy/compose.sh logs --tail=50 caddy` — typical causes are DNS not propagated or port 80/443 blocked
    by a provider firewall (Hetzner Cloud Firewall / DO Cloud Firewall must also allow 80 and 443).

11. **Create the first superadmin**:
    ```bash
    ./deploy/compose.sh run --rm -e SUPERADMIN_EMAIL=you@bmtechx.in -e SUPERADMIN_PASSWORD='a-long-passphrase-12+' migrate npm run seed:superadmin -w apps/api
    ```
    ✅ Prints `Superadmin you@bmtechx.in created`.

12. **Create a test tenant and confirm on-demand TLS.** Superadmin routes live on the api host
    (`apps/api/src/superadmin/tenants.controller.ts`). Log in, then create a tenant with slug/subdomain `demo`:
    ```bash
    TOKEN=$(curl -sS https://api.store.bmtechx.in/auth/login -H 'Content-Type: application/json' -d '{"email":"you@bmtechx.in","password":"a-long-passphrase-12+"}' | jq -r .accessToken)
    ```
    ```bash
    curl -sS https://api.store.bmtechx.in/superadmin/tenants -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"Demo Store","slug":"demo","subdomain":"demo","owner":{"email":"owner@demo.test","password":"owner-passphrase-10+"}}'
    ```
    (If the login response names the token field differently, read it from the JSON printed by the first call.) Then:
    ```bash
    curl -i https://demo.store.bmtechx.in/api/health
    ```
    ✅ `200` with `"tenant":"demo"` — the certificate was issued on first visit because tls-ask approved the host.
    ✅ `curl -i https://nothere.store.bmtechx.in/` fails the TLS handshake (no certificate for non-tenants) — correct.

## D. Backups, monitoring, automation

13. **Install the cron jobs** (nightly/weekly backups, monthly restore test, uptime/disk/SSL/failed-job checks):
    ```bash
    sudo ./deploy/install-cron.sh deploy
    ```
    ✅ `cat /etc/cron.d/bmstore` shows the schedule; `ls /var/log/bmstore` exists.

14. **Run one backup and one restore test by hand** so the first scheduled run is not the first run ever:
    ```bash
    ./deploy/compose.sh run --rm backup nightly
    ```
    ```bash
    ./deploy/compose.sh run --rm backup restore-test
    ```
    ✅ `backup nightly` ends with `backup nightly finished` and **no** "stored locally only" warning.
    ✅ `restore-test` prints `PASS: ...` and sends a "Restore test PASSED" notification.
    ✅ `./deploy/compose.sh run --rm backup list` shows the dump in the bucket.

15. **Point alerts at your WhatsApp** — [MONITORING.md](MONITORING.md) section 3 explains the Meta Cloud API setup
    (or use `webhook` for Slack/Discord meanwhile). Then test:
    ```bash
    ./infra/monitoring/notify.sh info "Test" "Hello from the server"
    ```
    ✅ The message arrives.

16. **Run each monitor once** and read the output:
    ```bash
    ./infra/monitoring/uptime-check.sh && ./infra/monitoring/ssl-expiry.sh && ./infra/monitoring/disk-usage.sh && ./infra/monitoring/failed-jobs.sh
    ```
    ✅ `uptime: N/N hosts up`, `ssl: ... 0 problem(s)`, a usage line, `failed-jobs: services[ ok ] failed_jobs=0`.

17. **Enable deploys from GitHub** (optional but recommended) — [DEPLOY.md](DEPLOY.md) section 3: create a dedicated
    key pair, add its public half to `~deploy/.ssh/authorized_keys` **with the forced command**, add the five secrets,
    then run the workflow with `dry_run = true`.
    ✅ The workflow run is green and its log shows `DRY:` lines from the server.

## E. Client domains

18. **Connecting a client's own domain** (`shop.client.com`) — [DNS.md](DNS.md) section 2: the client adds
    `CNAME shop → store.bmtechx.in`; you create the tenant with `"customDomain":"shop.client.com"` (Phase 1 has no
    endpoint to change it afterwards; DNS.md shows the SQL stopgap).
    ✅ `curl -i https://shop.client.com/api/health` returns `200` with the tenant slug.

## F. Before announcing

19. **Rollback drill**: `./deploy/deploy.sh --rollback` then `./deploy/deploy.sh` again. ✅ Both end healthy.
20. **Reboot drill**: `sudo reboot`, wait 2 minutes. ✅ `./deploy/compose.sh ps` shows everything healthy again (restart policy).
21. **Write down** where the env file, ENCRYPTION_KEY backup, bucket credentials and this checklist live. Hand the owner
    the WhatsApp alert number and the GO-LIVE date.
22. Read [DEPLOY_REPORT.md](DEPLOY_REPORT.md) — it lists what could **not** be verified without a real server and the
    assumptions you must confirm on day one (frontends, wildcard option, Caddy plugin build).
