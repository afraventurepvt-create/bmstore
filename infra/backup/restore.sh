#!/usr/bin/env bash
# =============================================================================
# BMStore restore
#   restore.sh <dump> [--target-db NAME] [--yes] [--jobs N]
#     <dump>  local path, OR  remote:<kind>/<file>  (e.g. remote:nightly/bmstore_bmstore_nightly_2026....dump)
#             OR  remote:<kind>/LATEST   to take the newest of that kind
#   --target-db   database to restore INTO (default: a fresh "<db>_restored"). Restoring over the LIVE
#                 database requires --yes and the API must be stopped first (./deploy/compose.sh stop api).
# The target database is DROPPED and recreated. The owner role must exist (it does: PGUSER).
# Full procedure: docs/runbooks/BACKUP_RESTORE.md
# =============================================================================
# shellcheck source=infra/backup/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SRC="${1:-}"; shift || true
[[ -n "$SRC" ]] || die "usage: restore.sh <dump|remote:kind/file|remote:kind/LATEST> [--target-db NAME] [--yes] [--jobs N]"
TARGET="${PGDATABASE}_restored"; YES=0; JOBS=2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-db) TARGET="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    --jobs) JOBS="$2"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done

# ---- fetch -------------------------------------------------------------------
if [[ "$SRC" == remote:* ]]; then
  setup_remote || die "remote restore requested but BACKUP_S3_* not configured"
  rel="${SRC#remote:}"                       # kind/file
  kind="${rel%%/*}"; file="${rel#*/}"
  if [[ "$file" == LATEST ]]; then
    file="$(rclone cat "$(remote_path "postgres/$kind/LATEST")" | tr -d '\r\n')"
    [[ -n "$file" ]] || die "no LATEST marker under postgres/$kind"
  fi
  mkdir -p "$LOCAL_DIR/restore"
  LOCAL="$LOCAL_DIR/restore/$file"
  log "downloading postgres/$kind/$file"
  rclone copyto "$(remote_path "postgres/$kind/$file")" "$LOCAL"
  rclone copyto "$(remote_path "postgres/$kind/$file.sha256")" "$LOCAL.sha256" 2>/dev/null || true
else
  LOCAL="$SRC"
  [[ -r "$LOCAL" ]] || die "file not readable: $LOCAL"
fi

verify_checksum "$LOCAL"
PLAIN="$(maybe_decrypt "$LOCAL")"
pg_restore --list "$PLAIN" >/dev/null || die "not a valid pg_dump custom-format archive"

# ---- safety ------------------------------------------------------------------
if [[ "$TARGET" == "$PGDATABASE" ]]; then
  if [[ "$YES" != 1 ]]; then
    die "refusing to overwrite the LIVE database '$PGDATABASE' without --yes (stop the api first: ./deploy/compose.sh stop api)"
  fi
  active=$(psql -Atc "select count(*) from pg_stat_activity where datname='$PGDATABASE' and pid<>pg_backend_pid()" postgres)
  log "terminating $active connection(s) to $PGDATABASE"
  psql -q -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$PGDATABASE' and pid<>pg_backend_pid()" postgres >/dev/null
fi

# ---- recreate + restore ---------------------------------------------------------
log "dropping and recreating database $TARGET (owner $PGUSER)"
psql -q -v ON_ERROR_STOP=1 postgres -c "DROP DATABASE IF EXISTS \"$TARGET\" WITH (FORCE)"
psql -q -v ON_ERROR_STOP=1 postgres -c "CREATE DATABASE \"$TARGET\" OWNER \"$PGUSER\""

log "restoring into $TARGET with $JOBS jobs"
# --no-owner/--role: everything is owned by the owner role regardless of who made the dump.
# ACLs (grants to bmstore_app) ARE restored; the role exists because it is cluster-wide.
pg_restore --no-password --exit-on-error --no-owner --role="$PGUSER" --jobs="$JOBS" --dbname="$TARGET" "$PLAIN"

tables=$(psql -Atc "select count(*) from information_schema.tables where table_schema='public'" "$TARGET")
tenants=$(psql -Atc "select count(*) from tenants" "$TARGET" 2>/dev/null || echo "n/a")
mig=$(psql -Atc "select coalesce(max(migration_name),'none') from _prisma_migrations where finished_at is not null" "$TARGET" 2>/dev/null || echo "n/a")
log "restored: tables=$tables tenants=$tenants last_migration=$mig"
[[ "$PLAIN" != "$LOCAL" ]] && rm -f "$PLAIN"

cat <<MSG

Restore into "$TARGET" complete.
Next steps (see docs/runbooks/BACKUP_RESTORE.md):
  * inspect:   ./deploy/compose.sh exec postgres psql -U $PGUSER -d $TARGET
  * re-apply grants for the app role:  ./deploy/deploy.sh --app-role-only   (or psql -f infra/postgres/app-role.sql)
  * if this replaced the live DB: ./deploy/compose.sh start api  and  ./deploy/compose.sh run --rm migrate  (brings newer migrations in)
MSG
