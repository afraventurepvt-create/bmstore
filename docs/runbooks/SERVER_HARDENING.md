# Server hardening runbook

`deploy/server-setup.sh` applies everything in sections 1–6 automatically. This document explains what it does,
how to verify it, and how to do each step by hand if you prefer.

## 1. Users: no root, one `deploy` user
- `deploy` is the only login user. It is in the `docker` group (needed to run the stack) and has passwordless
  `sudo`. Membership in `docker` is already root-equivalent, so a second "admin" user would add paperwork, not security.
  If several people need access, give each their own key in `~deploy/.ssh/authorized_keys` (one line each, with a
  comment naming the person) so keys can be revoked individually.
- Root login over SSH is disabled; use `sudo -i` from `deploy` when you need a root shell.
- Containers run as unprivileged users (`node`, `postgres`, `redis`, `caddy`) with `no-new-privileges`; the API and
  tls-ask file systems are read-only.

Verify: `id deploy` → groups include `docker` and `sudo`; `sudo -n true` works for deploy.

## 2. SSH: keys only
`/etc/ssh/sshd_config.d/00-bmstore.conf` (first file wins in sshd, hence the `00-` prefix — Ubuntu cloud images ship a
`50-cloud-init.conf` that turns passwords back on):
```
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
```
Apply by hand: write the file, `sudo sshd -t` (must print nothing), `sudo systemctl reload ssh`.
**Always keep your current session open and test a new login before closing it.**

Verify from your laptop: `ssh -o PreferredAuthentications=password deploy@SERVER_IP` → `Permission denied (publickey)`.

Optional: move SSH to a non-standard port (reduces log noise, not an actual security control): set `Port 2222` in the
drop-in, `sudo ufw allow 2222/tcp`, reload sshd, test, then `sudo ufw delete allow 22/tcp`. Update `DEPLOY_PORT` in GitHub.

## 3. Firewall (ufw): only 22, 80, 443
```bash
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
sudo ufw enable
```
Docker publishes ports with its own iptables rules that bypass ufw. That is fine here because the only published ports
are Caddy's 80/443 — Postgres, Redis, MinIO and the API are reachable only on the internal Docker networks. Never add
`ports:` to those services; use `./deploy/compose.sh exec` or an SSH tunnel instead.
Also enable the **provider** firewall (Hetzner Cloud Firewall / DigitalOcean Cloud Firewall) with the same three ports —
it filters before packets reach the VM.

Verify: `sudo ufw status verbose`; from outside `nmap -p 22,80,443,5432,6379,9000 SERVER_IP` shows only 22/80/443 open.

## 4. fail2ban
`/etc/fail2ban/jail.local` enables the `sshd` jail (5 failures in 10 min → 1 h ban, aggressive mode).
Verify: `sudo fail2ban-client status sshd`. Unban yourself: `sudo fail2ban-client set sshd unbanip YOUR_IP`.
Caddy's rate limits (per IP: 600 req/min, 20 req/min on `/auth/*`) handle HTTP brute force; a Caddy jail can be added
later by pointing a filter at the JSON access logs.

## 5. Automatic security updates
`unattended-upgrades` installs security updates daily and **reboots at 04:45 UTC when a kernel update requires it**
(`Automatic-Reboot "true"`). The stack comes back on its own (`restart: unless-stopped`, Docker `live-restore`).
Expect ~1–2 minutes of downtime on those nights; if that is unacceptable, set `Automatic-Reboot "false"` in
`/etc/apt/apt.conf.d/52bmstore-unattended` and reboot manually after reading `/var/run/reboot-required`.
Docker Engine itself is updated by `apt` as well; container images are updated only by deploys (`--pull` on build).

Verify: `sudo unattended-upgrade --dry-run --debug 2>&1 | tail -5`; `cat /var/log/unattended-upgrades/unattended-upgrades.log`.

## 6. Swap, time, logs
2 GB swap file with `vm.swappiness=10` (protects a 4 GB box from the OOM killer during image builds), timezone UTC,
Docker log rotation (20 MB × 5 per container, `/etc/docker/daemon.json`), app logs in `/var/log/bmstore` rotated weekly.

## 7. Secrets handling
| Secret | Where it lives | Who can read | Rotation |
|--------|----------------|--------------|----------|
| All runtime secrets | `/etc/bmstore/production.env` (root:deploy, 640) | root, deploy | edit file → `./deploy/deploy.sh --no-pull` |
| `ENCRYPTION_KEY` | env file **and** your password manager | — | not rotatable in Phase 1 (ciphertext is versioned `v1.` so a rotation job is possible later) |
| DB owner password | env file | Postgres volume (scram hash) | `ALTER ROLE bmstore PASSWORD …` inside postgres, then env file, then redeploy |
| App DB password | env file | — | change `APP_DB_PASSWORD` in env file → `./deploy/deploy.sh --app-role-only` → restart api |
| Redis password | env file | — | change, `./deploy/compose.sh up -d redis api` |
| Backup bucket keys | env file | backup container only | rotate at the provider, update env file |
| GitHub deploy key | GitHub secret (private), `authorized_keys` (public) | — | generate new pair, swap both |
| Let's Encrypt keys/certs | `caddy_data` volume | root | automatic |

Rules:
- Secrets never go into the repo, into `docker compose` command lines, or into logs. `compose.sh` passes the env file to
  compose; scripts read it with a parser, not `source`, and the app-role password travels on psql's stdin.
- `docker inspect` shows container environment variables to anyone in the `docker` group — one more reason that group is
  the trust boundary.
- Backups are the database **in clear** (compressed). Keep the bucket private, or set `BACKUP_AGE_RECIPIENT` for
  client-side encryption with [age](https://github.com/FiloSottile/age) (keep the private key off the server; restores
  then need `BACKUP_AGE_IDENTITY_FILE`).
- When someone leaves: remove their SSH key line, rotate the GitHub deploy key if they had access to the repo secrets,
  and rotate the DB owner password if they had server access.

## 8. Checklist (print this)
- [ ] `ssh root@SERVER_IP` is refused; `ssh deploy@SERVER_IP` with key works
- [ ] password login refused
- [ ] `ufw status` active: 22, 80, 443 only; provider firewall matches
- [ ] `fail2ban-client status sshd` shows the jail
- [ ] `/etc/apt/apt.conf.d/20auto-upgrades` has `Unattended-Upgrade "1"`
- [ ] `/etc/bmstore/production.env` is `-rw-r----- root deploy`
- [ ] `grep -c CHANGE_ME /etc/bmstore/production.env` → 0
- [ ] `ENCRYPTION_KEY` stored in the password manager
- [ ] `nmap` from outside shows no database ports
