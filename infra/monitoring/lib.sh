#!/usr/bin/env bash
# Shared helpers for the host-side monitoring cron jobs. Sourced, not executed.
# Loads /etc/bmstore/production.env, keeps alert state in /var/lib/bmstore/monitor so you get
# ONE alert when something breaks, a reminder every ALERT_REPEAT_MINUTES, and a recovery notice.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$HERE/../.." && pwd)"
ENV_FILE="${BMSTORE_ENV_FILE:-/etc/bmstore/production.env}"
STATE_DIR="${BMSTORE_STATE_DIR:-/var/lib/bmstore}/monitor"
COMPOSE="${BMSTORE_COMPOSE:-$ROOT_DIR/deploy/compose.sh}"
mkdir -p "$STATE_DIR" 2>/dev/null || true

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
[[ -r "$ENV_FILE" ]] && load_env_file "$ENV_FILE"
: "${ROOT_DOMAIN:?ROOT_DOMAIN missing (env file $ENV_FILE)}"
: "${ALERT_REPEAT_MINUTES:=240}"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
notify() { "$HERE/notify.sh" "$@" || true; }

# alert_state <key> <ok|bad> <title> <message>
#   transitions ok->bad: critical alert; bad->ok: recovery (info); bad->bad: repeat after ALERT_REPEAT_MINUTES.
alert_state() {
  local key="$1" status="$2" title="$3" msg="$4"
  local f; f="$STATE_DIR/$(printf '%s' "$key" | tr -c 'A-Za-z0-9._-' '_')"
  local prev="ok" since=0 last=0 now; now=$(date +%s)
  if [[ -r "$f" ]]; then read -r prev since last < "$f" || true; fi
  if [[ "$status" == bad ]]; then
    if [[ "$prev" != bad ]]; then
      notify critical "$title" "$msg"
      printf 'bad %s %s\n' "$now" "$now" > "$f"
    elif (( ALERT_REPEAT_MINUTES > 0 && now - last >= ALERT_REPEAT_MINUTES * 60 )); then
      notify warning "STILL FAILING: $title" "$msg (since $(date -u -d "@$since" +%Y-%m-%dT%H:%MZ))"
      printf 'bad %s %s\n' "$since" "$now" > "$f"
    fi
  else
    if [[ "$prev" == bad ]]; then
      notify info "RECOVERED: $title" "$msg (was failing since $(date -u -d "@$since" +%Y-%m-%dT%H:%MZ))"
    fi
    printf 'ok %s %s\n' "$now" "$now" > "$f"
  fi
}

# psql inside the postgres container (unix-socket trust auth, no password needed).
pg_query() { "$COMPOSE" exec -T postgres psql -U "${POSTGRES_USER:-bmstore}" -d "${POSTGRES_DB:-bmstore}" -Atc "$1" 2>/dev/null; }

# All public hostnames: platform hosts + active tenants (subdomain and custom domain) + extras.
tenant_hosts() {
  pg_query "select subdomain || '.${ROOT_DOMAIN}' from tenants where status = 'active'
            union select lower(custom_domain) from tenants where status = 'active' and custom_domain is not null
            order by 1" || true
}
platform_hosts() { printf '%s\n' "api.$ROOT_DOMAIN" "admin.$ROOT_DOMAIN" "console.$ROOT_DOMAIN"; }
all_hosts() { { platform_hosts; tenant_hosts; for h in ${UPTIME_EXTRA_HOSTS:-}; do echo "$h"; done; } | awk 'NF && !seen[$0]++'; }
