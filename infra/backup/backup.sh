#!/usr/bin/env bash
# =============================================================================
# BMStore backup
#   backup.sh nightly    pg_dump (custom format, compressed) -> bucket/postgres/nightly/
#   backup.sh weekly     nightly + role globals + media copy  -> bucket/postgres/weekly/ (+ bucket/media/)
#   backup.sh predeploy  dump taken by deploy.sh before migrations -> bucket/postgres/predeploy/
# Retention: BACKUP_RETENTION_DAYS (30) in the bucket, BACKUP_KEEP_LOCAL (3) files per kind locally.
# Without bucket credentials it keeps LOCAL copies only and raises a warning (fine for first boot,
# not for production). Failures notify via infra/monitoring/notify.sh.
# =============================================================================
# shellcheck source=infra/backup/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

KIND="${1:-nightly}"
case "$KIND" in nightly|weekly|predeploy) ;; *) die "usage: backup.sh nightly|weekly|predeploy" ;; esac

TS="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="bmstore_${PGDATABASE}_${KIND}_${TS}"
WORK="$LOCAL_DIR/$KIND"; mkdir -p "$WORK"
DUMP="$WORK/$BASE.dump"
START=$(date +%s)

on_error() {
  set_state "backup.$KIND.last" "FAIL $TS"
  notify critical "Backup FAILED ($KIND)" "Backup $KIND failed at step: ${STEP:-?}. See backup log on the server."
  exit 1
}
trap on_error ERR

STEP="connect"
pg_isready -q || die "postgres not reachable at $PGHOST:$PGPORT"

STEP="pg_dump"
log "dumping $PGDATABASE -> $DUMP"
pg_dump --format=custom --compress=6 --no-password --file="$DUMP" "$PGDATABASE"
[[ -s "$DUMP" ]] || die "dump is empty"

STEP="verify"
# The archive must be listable; a truncated/corrupt file fails here.
pg_restore --list "$DUMP" >/dev/null
SIZE=$(stat -c %s "$DUMP")
log "dump OK: $(human "$SIZE")"

FILES=("$DUMP")
if [[ "$KIND" == weekly ]]; then
  STEP="globals"
  GLOB="$WORK/$BASE.globals.sql"
  pg_dumpall --globals-only --no-password > "$GLOB"   # roles (incl. bmstore_app) + their grants
  FILES+=("$GLOB")
fi

STEP="encrypt"
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  command -v age >/dev/null || die "BACKUP_AGE_RECIPIENT set but age not installed"
  enc=()
  for f in "${FILES[@]}"; do age -r "$BACKUP_AGE_RECIPIENT" -o "$f.age" "$f" && rm -f "$f" && enc+=("$f.age"); done
  FILES=("${enc[@]}")
  log "encrypted with age (${#FILES[@]} files)"
fi

STEP="checksum"
for f in "${FILES[@]}"; do sha256_of "$f" | awk -v n="$(basename "$f")" '{print $1"  "n}' > "$f.sha256"; done

STEP="upload"
if setup_remote; then
  dest="$(remote_path "postgres/$KIND")"
  for f in "${FILES[@]}"; do
    rclone copyto --s3-no-check-bucket "$f" "$dest/$(basename "$f")"
    rclone copyto --s3-no-check-bucket "$f.sha256" "$dest/$(basename "$f").sha256"
  done
  printf '%s\n' "$(basename "${FILES[0]}")" | rclone rcat "$dest/LATEST"
  log "uploaded to $dest"

  STEP="media"
  if [[ "$KIND" == weekly && "${BACKUP_INCLUDE_MEDIA:-0}" == 1 ]]; then
    if setup_media_remote; then
      rclone sync --s3-no-check-bucket --transfers 8 --fast-list "media:$S3_BUCKET" "$(remote_path media/current)" \
        --backup-dir "$(remote_path "media/deleted/$TS")"
      log "media synced (deleted objects parked under media/deleted/$TS)"
    else
      log "media copy requested but S3_* media credentials missing — skipped"
    fi
  fi

  STEP="retention"
  rclone delete --min-age "${RETENTION_DAYS}d" "$dest" --exclude LATEST || log "retention sweep had errors (non-fatal)"
  rclone delete --min-age "${RETENTION_DAYS}d" "$(remote_path media/deleted)" 2>/dev/null || true
  rclone rmdirs --leave-root "$(remote_path media/deleted)" 2>/dev/null || true
else
  log "WARNING: no backup bucket configured (BACKUP_S3_*) — keeping LOCAL copy only"
  notify warning "Backup stored locally only ($KIND)" "BACKUP_S3_* is not configured; $BASE is only on this server."
fi

STEP="local-retention"
# keep the newest $KEEP_LOCAL dumps per kind (plus their sidecars)
mapfile -t old < <(ls -1t "$WORK"/*.dump "$WORK"/*.dump.age 2>/dev/null | tail -n +$((KEEP_LOCAL + 1)))
for f in "${old[@]:-}"; do [[ -n "$f" ]] && rm -f "$f" "$f.sha256" "${f%.dump*}.globals.sql"* ; done

DUR=$(( $(date +%s) - START ))
set_state "backup.$KIND.last" "OK $TS size=$SIZE seconds=$DUR file=$(basename "${FILES[0]}")"
log "backup $KIND finished in ${DUR}s"
