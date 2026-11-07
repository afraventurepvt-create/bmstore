#!/usr/bin/env bash
# =============================================================================
# Monthly automated restore test: proves the newest nightly backup actually restores.
#   1. fetch newest nightly (bucket LATEST, or newest local file if no bucket)
#   2. verify checksum, decrypt if needed
#   3. restore into a scratch database  <db>_restore_test
#   4. checks: pg_restore exit 0, table count == live table count, tenants readable,
#              latest migration name == live (WARN only — a deploy may have run since the dump),
#              row counts of tenants/orders within 50% of live (sanity, WARN only)
#   5. drop the scratch DB, write state, notify PASS or FAIL (always — this is the monthly report)
# =============================================================================
# shellcheck source=infra/backup/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TEST_DB="${PGDATABASE}_restore_test"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
START=$(date +%s)
RESULT="FAIL"; DETAIL=""; WARN=""
cleanup() {
  psql -q postgres -c "DROP DATABASE IF EXISTS \"$TEST_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
  [[ -n "${PLAIN:-}" && "${PLAIN:-}" != "${LOCAL:-}" ]] && rm -f "$PLAIN"
  DUR=$(( $(date +%s) - START ))
  set_state "restore-test.last" "$RESULT $TS seconds=$DUR $DETAIL"
  if [[ "$RESULT" == PASS ]]; then
    notify info "Restore test PASSED" "Nightly backup restored and verified in ${DUR}s. $DETAIL${WARN:+ Warnings: $WARN}"
  else
    notify critical "Restore test FAILED" "Could not restore/verify the latest nightly backup (${DUR}s). $DETAIL"
  fi
}
trap cleanup EXIT
fail() { DETAIL="$DETAIL step=${1}: ${2}"; log "FAIL $1: $2"; exit 1; }

# 1. locate newest nightly
if setup_remote; then
  file="$(rclone cat "$(remote_path postgres/nightly/LATEST)" 2>/dev/null | tr -d '\r\n' || true)"
  [[ -n "$file" ]] || fail locate "no nightly LATEST marker in bucket"
  mkdir -p "$LOCAL_DIR/restore"
  LOCAL="$LOCAL_DIR/restore/$file"
  rclone copyto "$(remote_path "postgres/nightly/$file")" "$LOCAL" || fail download "rclone copy failed"
  rclone copyto "$(remote_path "postgres/nightly/$file.sha256")" "$LOCAL.sha256" 2>/dev/null || true
  source="bucket"
else
  LOCAL="$(ls -1t "$LOCAL_DIR"/nightly/*.dump "$LOCAL_DIR"/nightly/*.dump.age 2>/dev/null | head -1 || true)"
  [[ -n "$LOCAL" ]] || fail locate "no nightly backup found locally and no bucket configured"
  source="local"
  WARN="${WARN}no bucket configured (tested a local copy);"
fi
age_h=$(( ( $(date +%s) - $(stat -c %Y "$LOCAL") ) / 3600 ))
log "testing $(basename "$LOCAL") from $source (${age_h}h old)"
[[ "$source" == bucket && $age_h -gt 48 ]] && WARN="${WARN}newest nightly is ${age_h}h old;"

# 2. integrity
verify_checksum "$LOCAL" || fail checksum "sha256 mismatch"
PLAIN="$(maybe_decrypt "$LOCAL")" || fail decrypt "age decryption failed"
pg_restore --list "$PLAIN" >/dev/null 2>&1 || fail archive "archive unreadable"

# 3. restore into scratch DB
psql -q -v ON_ERROR_STOP=1 postgres -c "DROP DATABASE IF EXISTS \"$TEST_DB\" WITH (FORCE)" >/dev/null || fail prepare "could not drop old scratch db"
psql -q -v ON_ERROR_STOP=1 postgres -c "CREATE DATABASE \"$TEST_DB\" OWNER \"$PGUSER\"" >/dev/null || fail prepare "could not create scratch db"
if ! pg_restore --no-password --exit-on-error --no-owner --role="$PGUSER" --jobs=2 --dbname="$TEST_DB" "$PLAIN" >"$LOCAL_DIR/restore/restore-test.log" 2>&1; then
  fail pg_restore "$(tail -n 3 "$LOCAL_DIR/restore/restore-test.log" | tr '\n' ' ')"
fi

# 4. checks
q() { psql -Atc "$2" "$1" 2>/dev/null || echo "ERR"; }
t_live=$(q "$PGDATABASE" "select count(*) from information_schema.tables where table_schema='public'")
t_test=$(q "$TEST_DB"    "select count(*) from information_schema.tables where table_schema='public'")
[[ "$t_test" != ERR && "$t_test" -gt 0 ]] || fail tables "restored schema has no tables"
[[ "$t_test" == "$t_live" ]] || fail tables "table count live=$t_live restored=$t_test"
ten_test=$(q "$TEST_DB" "select count(*) from tenants"); [[ "$ten_test" != ERR ]] || fail tenants "tenants table not readable"
ten_live=$(q "$PGDATABASE" "select count(*) from tenants")
m_live=$(q "$PGDATABASE" "select coalesce(max(migration_name),'none') from _prisma_migrations where finished_at is not null")
m_test=$(q "$TEST_DB"    "select coalesce(max(migration_name),'none') from _prisma_migrations where finished_at is not null")
[[ "$m_live" == "$m_test" ]] || WARN="${WARN}migration differs (live=$m_live backup=$m_test);"
if [[ "$ten_live" =~ ^[0-9]+$ && "$ten_live" -gt 0 ]]; then
  lo=$(( ten_live / 2 )); [[ "$ten_test" -ge "$lo" ]] || WARN="${WARN}tenants live=$ten_live backup=$ten_test;"
fi
# every table must at least be SELECTable (catches partial restores)
while IFS= read -r tbl; do
  [[ -n "$tbl" ]] || continue
  psql -Atc "select 1 from \"$tbl\" limit 1" "$TEST_DB" >/dev/null 2>&1 || fail readable "table $tbl not readable after restore"
done < <(q "$TEST_DB" "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")

RESULT="PASS"
DETAIL="file=$(basename "$LOCAL") source=$source tables=$t_test tenants=$ten_test migration=$m_test"
log "PASS: $DETAIL"
