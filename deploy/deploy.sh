#!/usr/bin/env bash
# =============================================================================
# BMStore production deploy (run on the VPS as the deploy user, from the repo checkout):
#
#   ./deploy/deploy.sh                  # pull DEPLOY_BRANCH (main), build, backup, migrate, grants, switch, health-check
#   ./deploy/deploy.sh v1.4.0           # a tag / branch / commit instead
#   ./deploy/deploy.sh --rollback       # go back to the previous image tag + commit
#   ./deploy/deploy.sh --app-role-only  # only re-apply infra/postgres/app-role.sql
#   flags: --no-backup  --skip-migrate  --no-pull  --dry-run
#
# Steps: 1 pull  2 build images (tag = git sha)  3 pre-deploy DB dump  4 prisma migrate deploy (OWNER role)
#        5 db:app-role grants  6 compose up with the new tag  7 health checks  -> on failure: roll back to
#        the previous tag/commit and alert. Migrations are NOT rolled back automatically (see BACKUP_RESTORE.md).
# State: /var/lib/bmstore/{current_tag,previous_tag,current_sha,previous_sha,last_deploy}
# Log:   /var/log/bmstore/deploy.log
# =============================================================================
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT_DIR/deploy/compose.sh"
ENV_FILE="${BMSTORE_ENV_FILE:-/etc/bmstore/production.env}"
STATE_DIR="${BMSTORE_STATE_DIR:-/var/lib/bmstore}"
LOG_DIR="${BMSTORE_LOG_DIR:-/var/log/bmstore}"
NOTIFY="$ROOT_DIR/infra/monitoring/notify.sh"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-150}"

REF=""; DO_BACKUP=1; DO_MIGRATE=1; DO_PULL=1; DRY=0; MODE=deploy
for a in "$@"; do
  case "$a" in
    --no-backup) DO_BACKUP=0 ;; --skip-migrate) DO_MIGRATE=0 ;; --no-pull) DO_PULL=0 ;;
    --dry-run) DRY=1 ;; --rollback) MODE=rollback ;; --app-role-only) MODE=approle ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    --*) echo "unknown flag $a" >&2; exit 2 ;;
    *) REF="$a" ;;
  esac
done

mkdir -p "$STATE_DIR" "$LOG_DIR" 2>/dev/null || true
exec > >(tee -a "$LOG_DIR/deploy.log") 2>&1
log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
run() { if (( DRY )); then log "DRY: $*"; else "$@"; fi; }
notify() { [[ -x "$NOTIFY" ]] && "$NOTIFY" "$@" || true; }

[[ -r "$ENV_FILE" ]] || { log "env file $ENV_FILE not readable — see docs/runbooks/GO_LIVE.md"; exit 2; }
# Parse KEY=value lines like docker compose does (quotes stripped, "# comment" after unquoted values dropped).
load_env_file() {
  local line k v
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    k="${BASH_REMATCH[2]}"; v="${BASH_REMATCH[3]}"
    if [[ "$v" =~ ^\"(.*)\"[[:space:]]*(#.*)?$ ]]; then v="${BASH_REMATCH[1]}"
    elif [[ "$v" =~ ^\'(.*)\'[[:space:]]*(#.*)?$ ]]; then v="${BASH_REMATCH[1]}"
    else v="${v%%[[:space:]]#*}"; v="${v%"${v##*[![:space:]]}"}"; fi
    export "$k=$v"
  done < "$1"
}
load_env_file "$ENV_FILE"
: "${ROOT_DOMAIN:?ROOT_DOMAIN missing in $ENV_FILE}"
REF="${REF:-${DEPLOY_BRANCH:-main}}"

# One deploy at a time.
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || { log "another deploy is running (lock $STATE_DIR/deploy.lock)"; exit 3; }

PREV_TAG="$(cat "$STATE_DIR/current_tag" 2>/dev/null || true)"
PREV_SHA="$(cat "$STATE_DIR/current_sha" 2>/dev/null || true)"
cd "$ROOT_DIR"

# ----------------------------------------------------------------------------- helpers
compose_profiles_have() { [[ ",${COMPOSE_PROFILES:-}," == *",$1,"* ]]; }
app_services() { # services that change with a release
  local s="api tls-ask caddy"
  compose_profiles_have web && s="$s storefront admin console"
  echo "$s"
}
build_services() {
  local s="api migrate tls-ask caddy backup"
  compose_profiles_have web && s="$s storefront admin console"
  echo "$s"
}
psql_quote() { local v="${1//\\/\\\\}"; v="${v//\'/\'\'}"; printf "'%s'" "$v"; }   # for psql \set
apply_app_role() {
  log "step 5: db:app-role (grants for ${APP_DB_USER:-bmstore_app})"
  # The password travels on psql's stdin (\set), never on a command line / in ps / in this log.
  {
    printf '\\set app_password %s\n' "$(psql_quote "${APP_DB_PASSWORD:?APP_DB_PASSWORD missing}")"
    printf '\\i /opt/bmstore/app-role.sql\n'
  } | run "$COMPOSE" exec -T postgres psql -q -v ON_ERROR_STOP=1 \
        -U "${POSTGRES_USER:-bmstore}" -d "${POSTGRES_DB:-bmstore}" \
        -v app_user="${APP_DB_USER:-bmstore_app}" -v owner="${POSTGRES_USER:-bmstore}" -v dbname="${POSTGRES_DB:-bmstore}"
}
wait_healthy() { # tag
  local tag="$1" deadline=$(( $(date +%s) + HEALTH_TIMEOUT )) status
  while :; do
    status="$(IMAGE_TAG="$tag" "$COMPOSE" ps --format '{{.Service}} {{.Health}}' api 2>/dev/null | awk '{print $2}')"
    [[ "$status" == healthy ]] && return 0
    (( $(date +%s) > deadline )) && { log "api not healthy after ${HEALTH_TIMEOUT}s (status: ${status:-none})"; return 1; }
    sleep 5
  done
}
check_edge() {
  # Through Caddy on port 80: a 308 redirect proves Caddy is up and routing this host.
  local code
  code="$(curl -sS -o /dev/null -m 10 -w '%{http_code}' -H "Host: api.$ROOT_DOMAIN" http://127.0.0.1/health 2>/dev/null || echo 000)"
  if [[ "$code" != 308 && "$code" != 301 && "$code" != 200 ]]; then log "edge check FAILED: Caddy returned HTTP $code on :80"; return 1; fi
  # Full HTTPS path (warn only: before DNS/certificates exist this cannot succeed).
  code="$(curl -sS -o /dev/null -m 15 -w '%{http_code}' --resolve "api.$ROOT_DOMAIN:443:127.0.0.1" "https://api.$ROOT_DOMAIN/health" 2>/dev/null || echo 000)"
  if [[ "$code" == 200 ]]; then log "edge check OK: https://api.$ROOT_DOMAIN/health -> 200"; else log "WARN: https://api.$ROOT_DOMAIN/health -> $code (expected before DNS/TLS are live; otherwise check: compose.sh logs caddy)"; fi
  return 0
}
record() { # status tag sha
  printf 'OK %s %s %s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$2" "$3" > "$STATE_DIR/last_deploy"
  [[ -n "$PREV_TAG" ]] && printf '%s\n' "$PREV_TAG" > "$STATE_DIR/previous_tag"
  [[ -n "$PREV_SHA" ]] && printf '%s\n' "$PREV_SHA" > "$STATE_DIR/previous_sha"
  printf '%s\n' "$2" > "$STATE_DIR/current_tag"; printf '%s\n' "$3" > "$STATE_DIR/current_sha"
}
rollback_to() { # tag sha reason
  local tag="$1" sha="$2" why="$3"
  log "!!! ROLLING BACK to tag $tag ($sha): $why"
  if [[ -z "$tag" ]]; then
    log "no previous tag recorded — nothing to roll back to. Fix forward: ./deploy/compose.sh logs api"
    printf 'FAILED %s %s %s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "${NEW_TAG:-?}" "${NEW_SHA:-?}" > "$STATE_DIR/last_deploy"
    notify critical "Deploy FAILED (no rollback available)" "$why on $(hostname -s). Check /var/log/bmstore/deploy.log"
    return 1
  fi
  [[ -n "$sha" ]] && run git -c advice.detachedHead=false checkout -q --detach "$sha"
  # shellcheck disable=SC2046
  IMAGE_TAG="$tag" run "$COMPOSE" up -d --no-build $(app_services)
  if wait_healthy "$tag"; then
    printf 'ROLLED_BACK %s %s %s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "${NEW_TAG:-?}" "$tag" > "$STATE_DIR/last_deploy"
    printf '%s\n' "$tag" > "$STATE_DIR/current_tag"; printf '%s\n' "$sha" > "$STATE_DIR/current_sha"
    notify critical "Deploy FAILED — rolled back" "$why. Serving previous release $tag again. DB migrations were NOT reverted; pre-deploy dump is in the backups bucket (postgres/predeploy)."
    log "rollback complete; previous release $tag is serving"
  else
    printf 'FAILED %s %s %s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "${NEW_TAG:-?}" "$tag" > "$STATE_DIR/last_deploy"
    notify critical "Deploy FAILED and rollback FAILED" "$why. Manual action needed: ./deploy/compose.sh ps && ./deploy/compose.sh logs api"
    log "rollback did NOT become healthy — manual intervention required"
  fi
  return 1
}

# ----------------------------------------------------------------------------- modes
if [[ "$MODE" == approle ]]; then apply_app_role; log "done"; exit 0; fi

if [[ "$MODE" == rollback ]]; then
  tag="$(cat "$STATE_DIR/previous_tag" 2>/dev/null || true)"; sha="$(cat "$STATE_DIR/previous_sha" 2>/dev/null || true)"
  [[ -n "$tag" ]] || { log "no previous_tag recorded"; exit 1; }
  NEW_TAG="$PREV_TAG"; NEW_SHA="$PREV_SHA"
  rollback_to "$tag" "$sha" "manual rollback requested" || true
  # after a manual rollback, "previous" becomes what we just left
  printf '%s\n' "$PREV_TAG" > "$STATE_DIR/previous_tag"; printf '%s\n' "$PREV_SHA" > "$STATE_DIR/previous_sha"
  exit 0
fi

# ----------------------------------------------------------------------------- deploy
START=$(date +%s)
log "=== deploy start: ref=$REF prev_tag=${PREV_TAG:-none} dry_run=$DRY"
command -v docker >/dev/null || { log "docker not installed"; exit 2; }

if (( DO_PULL )); then
  log "step 1: fetch $REF"
  if [[ -n "$(git status --porcelain --untracked-files=no)" && "${FORCE_DIRTY:-0}" != 1 ]]; then
    log "working tree has local modifications; commit/stash them or set FORCE_DIRTY=1"; git status --short; exit 2
  fi
  run git fetch --prune origin
  if git show-ref --verify --quiet "refs/remotes/origin/$REF"; then
    run git checkout -q "$REF" 2>/dev/null || run git checkout -q -b "$REF" "origin/$REF"
    run git merge --ff-only "origin/$REF"
  else
    run git -c advice.detachedHead=false checkout -q --detach "$REF"
  fi
fi
NEW_SHA="$(git rev-parse HEAD)"; NEW_TAG="$(git rev-parse --short=12 HEAD)"
log "deploying commit $NEW_SHA as image tag $NEW_TAG"

log "step 2: build images"
# shellcheck disable=SC2046
IMAGE_TAG="$NEW_TAG" run "$COMPOSE" --profile tools build --pull $(build_services)

log "step 2b: data services up"
svcs="postgres redis"; compose_profiles_have minio && svcs="$svcs minio"
# shellcheck disable=SC2086
IMAGE_TAG="$NEW_TAG" run "$COMPOSE" up -d --wait --wait-timeout 120 $svcs
compose_profiles_have minio && IMAGE_TAG="$NEW_TAG" run "$COMPOSE" run --rm -T minio-init

if (( DO_BACKUP )); then
  log "step 3: pre-deploy database dump"
  IMAGE_TAG="$NEW_TAG" run "$COMPOSE" run --rm -T backup predeploy || { log "pre-deploy backup failed; aborting before touching the schema (use --no-backup to override)"; exit 1; }
fi

if (( DO_MIGRATE )); then
  log "step 4: prisma migrate deploy (owner role)"
  if ! IMAGE_TAG="$NEW_TAG" run "$COMPOSE" run --rm -T migrate; then
    log "migration FAILED. The running release is untouched. Inspect: ./deploy/compose.sh run --rm migrate npx prisma migrate status"
    printf 'FAILED %s %s %s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$NEW_TAG" "$NEW_SHA" > "$STATE_DIR/last_deploy"
    notify critical "Deploy FAILED at migration" "prisma migrate deploy failed for $NEW_TAG; old release still serving. See deploy.log"
    [[ -n "$PREV_SHA" ]] && run git -c advice.detachedHead=false checkout -q --detach "$PREV_SHA"
    exit 1
  fi
fi

apply_app_role

log "step 6: switch application containers to $NEW_TAG"
# shellcheck disable=SC2046
if ! IMAGE_TAG="$NEW_TAG" run "$COMPOSE" up -d --remove-orphans --no-build $(app_services); then
  rollback_to "$PREV_TAG" "$PREV_SHA" "compose up failed"; exit 1
fi

log "step 7: health checks"
(( DRY )) || wait_healthy "$NEW_TAG" || { rollback_to "$PREV_TAG" "$PREV_SHA" "api container never became healthy"; exit 1; }
(( DRY )) || check_edge      || { rollback_to "$PREV_TAG" "$PREV_SHA" "Caddy edge check failed"; exit 1; }

record OK "$NEW_TAG" "$NEW_SHA"
DUR=$(( $(date +%s) - START ))
log "=== deploy OK: $NEW_TAG in ${DUR}s (previous: ${PREV_TAG:-none})"
notify info "Deploy OK" "$NEW_TAG ($(git log -1 --format=%s | cut -c1-80)) live on $(hostname -s) in ${DUR}s"
