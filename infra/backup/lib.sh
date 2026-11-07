#!/usr/bin/env bash
# Shared helpers for backup.sh / restore.sh / restore-test.sh. Sourced, not executed.
# Runs inside the "backup" container (deploy/docker/backup.Dockerfile) — or on any box with
# pg_dump 16, rclone, jq, curl (age optional) and PG* env vars set.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITORING_DIR="${MONITORING_DIR:-$HERE/../monitoring}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-/backups}"
STATE_DIR="${BMSTORE_STATE_DIR:-/state}"
# shellcheck disable=SC2034  # used by the scripts that source this file
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
# shellcheck disable=SC2034
KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-3}"
: "${PGHOST:=postgres}" "${PGPORT:=5432}" "${PGUSER:=bmstore}" "${PGDATABASE:=bmstore}"
export PGHOST PGPORT PGUSER PGDATABASE
mkdir -p "$LOCAL_DIR" "$LOCAL_DIR/restore" "$STATE_DIR" 2>/dev/null || true
export PGOPTIONS="-c client_min_messages=warning"

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die()  { log "ERROR: $*"; exit 1; }
notify() { # severity title message
  if [[ -x "$MONITORING_DIR/notify.sh" ]]; then "$MONITORING_DIR/notify.sh" "$@" || true; else log "notify($1): $2 — $3"; fi
}
set_state() { # key value
  printf '%s\n' "$2" > "$STATE_DIR/$1" 2>/dev/null || true
}

# ---- object storage via rclone, configured purely from env (no config file on disk) ----
have_remote() {
  [[ -n "${BACKUP_S3_BUCKET:-}" && -n "${BACKUP_S3_ACCESS_KEY:-}" && -n "${BACKUP_S3_SECRET_KEY:-}" ]]
}
setup_remote() {
  have_remote || return 1
  command -v rclone >/dev/null || die "rclone not installed"
  export RCLONE_CONFIG_BK_TYPE=s3
  export RCLONE_CONFIG_BK_PROVIDER="${BACKUP_S3_PROVIDER:-Other}"
  export RCLONE_CONFIG_BK_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY"
  export RCLONE_CONFIG_BK_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY"
  export RCLONE_CONFIG_BK_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
  export RCLONE_CONFIG_BK_REGION="${BACKUP_S3_REGION:-auto}"
  export RCLONE_CONFIG_BK_ACL=private
  export RCLONE_CONFIG_BK_NO_CHECK_BUCKET=true   # R2 / restricted keys cannot HEAD the bucket
  export RCLONE_CONFIG_BK_ENV_AUTH=false
  return 0
}
remote_path() { printf 'bk:%s/%s' "$BACKUP_S3_BUCKET" "$1"; }

# Media bucket (MinIO or external S3) as a second rclone remote, for the weekly media copy.
setup_media_remote() {
  [[ -n "${S3_ACCESS_KEY:-}" && -n "${S3_SECRET_KEY:-}" && -n "${S3_BUCKET:-}" ]] || return 1
  export RCLONE_CONFIG_MEDIA_TYPE=s3
  local prov=Other; [[ "${MEDIA_BACKEND:-minio}" == minio ]] && prov=Minio
  export RCLONE_CONFIG_MEDIA_PROVIDER="$prov"
  export RCLONE_CONFIG_MEDIA_ACCESS_KEY_ID="$S3_ACCESS_KEY"
  export RCLONE_CONFIG_MEDIA_SECRET_ACCESS_KEY="$S3_SECRET_KEY"
  export RCLONE_CONFIG_MEDIA_ENDPOINT="${S3_ENDPOINT:-}"
  export RCLONE_CONFIG_MEDIA_REGION="${S3_REGION:-auto}"
  export RCLONE_CONFIG_MEDIA_NO_CHECK_BUCKET=true
  export RCLONE_CONFIG_MEDIA_ENV_AUTH=false
  return 0
}

sha256_of() { sha256sum "$1" | awk '{print $1}'; }
human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "$1 bytes"; }

# Decrypt if the file is age-encrypted. Prints the plaintext path.
maybe_decrypt() {
  local f="$1"
  if [[ "$f" == *.age ]]; then
    [[ -n "${BACKUP_AGE_IDENTITY_FILE:-}" && -r "$BACKUP_AGE_IDENTITY_FILE" ]] || die "backup is encrypted; set BACKUP_AGE_IDENTITY_FILE to the age private key"
    age -d -i "$BACKUP_AGE_IDENTITY_FILE" -o "${f%.age}" "$f" || die "age decryption failed"
    printf '%s' "${f%.age}"
  else
    printf '%s' "$f"
  fi
}

# Verify a sidecar .sha256 file when present.
verify_checksum() {
  local f="$1"
  if [[ -r "$f.sha256" ]]; then
    local want have; want="$(awk '{print $1}' "$f.sha256")"; have="$(sha256_of "$f")"
    [[ "$want" == "$have" ]] || die "checksum mismatch for $f"
    log "checksum OK"
  else
    log "no checksum sidecar for $f (skipping verification)"
  fi
}
