# Backup & restore runbook

All jobs run inside the `backup` container (`deploy/docker/backup.Dockerfile`: pg_dump 16 + rclone + age),
scheduled from `/etc/cron.d/bmstore`. They talk to Postgres as the **owner** role.

## 1. Schedule and layout
| Job | When (UTC) | What | Bucket path |
|-----|------------|------|-------------|
| `backup nightly` | 02:15 daily | `pg_dump -Fc` (compressed custom format) of the app DB, verified with `pg_restore --list`, sha256 sidecar | `postgres/nightly/` |
| `backup weekly` | 03:30 Sunday | nightly + `pg_dumpall --globals-only` (roles) + media copy (`rclone sync` of the media bucket, deleted files parked under `media/deleted/<ts>/`) | `postgres/weekly/`, `media/current/` |
| `backup predeploy` | every deploy | same as nightly, taken before migrations | `postgres/predeploy/` |
| `backup restore-test` | 04:30 on the 1st | restores the newest nightly into `bmstore_restore_test`, checks, drops it, **notifies PASS/FAIL** | — |

Retention: `BACKUP_RETENTION_DAYS` (30) per folder in the bucket (`rclone delete --min-age`), plus the newest 3 dumps
per kind kept locally in the `backups` volume for fast access. `LATEST` marker files point at the newest dump.
Optional client-side encryption: set `BACKUP_AGE_RECIPIENT` (an `age1…` public key); files get a `.age` suffix.

Bucket credentials: `BACKUP_S3_*` in the env file. Use a **separate** bucket/token from media, with write access only
to that bucket. If `BACKUP_S3_BUCKET` is empty the job still runs but keeps the dump only on the server and sends a
warning every night until you fix it.

What is NOT in the dumps: the `ENCRYPTION_KEY` (env file — keep it in your password manager), Caddy certificates
(re-issued automatically), Redis (cache + refresh tokens: users just log in again).

## 2. Manual operations
```bash
./deploy/compose.sh run --rm backup nightly            # take a backup now
```
```bash
./deploy/compose.sh run --rm backup list [nightly|weekly|predeploy]
```
```bash
./deploy/compose.sh run --rm backup restore-test       # prove the newest nightly restores (safe, uses a scratch DB)
```
```bash
cat /var/lib/bmstore/backup.nightly.last /var/lib/bmstore/restore-test.last     # last results
```

## 3. Restore scenarios

### 3a. Inspect / recover a few rows (no downtime)
Restore into a side database and copy what you need:
```bash
./deploy/compose.sh run --rm backup restore remote:nightly/LATEST --target-db bmstore_restored
```
```bash
./deploy/compose.sh exec postgres psql -U bmstore -d bmstore_restored
```
Afterwards: `./deploy/compose.sh exec postgres psql -U bmstore -c 'DROP DATABASE bmstore_restored'`.

### 3b. Full restore of the live database (downtime)
1. Stop the API so nothing writes: `./deploy/compose.sh stop api tls-ask`
2. Pick the dump: `./deploy/compose.sh run --rm backup list nightly` (or `predeploy` right after a bad deploy).
3. Restore over the live DB (the script terminates connections, drops, recreates, restores):
   ```bash
   ./deploy/compose.sh run --rm backup restore remote:nightly/<file>.dump --target-db bmstore --yes
   ```
4. Re-apply grants and bring newer migrations in (if the dump predates them):
   ```bash
   ./deploy/deploy.sh --app-role-only
   ```
   ```bash
   ./deploy/compose.sh run --rm migrate
   ```
5. Start: `./deploy/compose.sh start api tls-ask` → `curl https://api.store.bmtechx.in/health`.
6. Flush the tenant cache so stale hosts disappear: `./deploy/compose.sh exec redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --scan --pattern 'tenant:host:*' | xargs -r ./deploy/compose.sh exec -T redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning del`

### 3c. New server (disaster)
1. GO_LIVE.md steps 5–8 on the new VPS (same `ENCRYPTION_KEY`, same `BACKUP_S3_*`, same DB passwords).
2. `./deploy/deploy.sh --no-pull --no-backup` to create the empty stack (migrations create the schema).
3. 3b steps 1, 3 (`--yes`), 4, 5 using the newest nightly or weekly dump.
4. Media: MinIO → `./deploy/compose.sh run --rm backup shell` then
   `rclone sync bk:$BACKUP_S3_BUCKET/media/current media:$S3_BUCKET` (remotes are pre-configured from env in the
   shell via `source lib.sh; setup_remote; setup_media_remote`). External S3/R2 media needs nothing.
5. Point DNS at the new IP (DNS.md §4). Certificates re-issue on demand.

### 3d. Encrypted backups
Put the age private key on the server only for the duration of the restore, e.g. `/etc/bmstore/age.key` (600, root),
mount it: add `-v /etc/bmstore/age.key:/age.key:ro -e BACKUP_AGE_IDENTITY_FILE=/age.key` to the `compose run` line.

## 4. Restore-test report
The monthly job writes `restore-test.last` (`PASS|FAIL <utc> seconds=… file=… tables=… tenants=… migration=…`) and
sends a notification either way. `failed-jobs.sh` additionally alerts if the last test is older than 32 days or
not PASS, and if the nightly is older than 26 h / weekly older than 8 days.

Checks performed: archive listable → restore with `--exit-on-error` → table count equals live → `tenants` readable →
every table SELECTable → migration name vs live (warning only) → tenant count within 50 % of live (warning only).

## 5. Testing the whole thing without production data
`infra/backup/*.sh` run against any Postgres with `PGHOST/PGUSER/PGPASSWORD/PGDATABASE` and no bucket
(local-only mode) — that is how they were exercised in the sandbox (DEPLOY_REPORT.md).
