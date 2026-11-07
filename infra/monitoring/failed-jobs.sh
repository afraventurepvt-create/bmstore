#!/usr/bin/env bash
# Failed-job / unhealthy-service alerts (cron: every 15 minutes) -> owner's WhatsApp via notify.sh.
#  1. compose services not running / unhealthy / restart-looping
#  2. backup freshness: nightly < 26 h, weekly < 8 d, restore-test < 32 d and PASS, predeploy failures
#  3. last deploy status (written by deploy/deploy.sh)
#  4. queue failures in Redis (BullMQ-style "bull:<queue>:failed" sets) — ready for Phase 2 workers
# shellcheck source=infra/monitoring/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
APP_STATE="${BMSTORE_STATE_DIR:-/var/lib/bmstore}"
now=$(date +%s)

# 1. containers --------------------------------------------------------------
bad_services=""
while IFS=$'\t' read -r name state health; do
  [[ -n "$name" ]] || continue
  svc="${name#bmstore-}"; svc="${svc%-[0-9]*}"
  case "$svc" in migrate|backup|minio-init) continue ;; esac   # one-off jobs
  restarts=$(docker inspect -f '{{.RestartCount}}' "$name" 2>/dev/null || echo 0)
  prev_f="$STATE_DIR/restarts.$svc"; prev=0; [[ -r "$prev_f" ]] && prev=$(<"$prev_f"); echo "$restarts" > "$prev_f"
  if [[ "$state" != running || "$health" == unhealthy ]]; then
    bad_services="$bad_services $svc($state${health:+/$health})"
  elif (( restarts - prev >= 3 )); then
    bad_services="$bad_services $svc(restarted $((restarts - prev))x in 15m)"
  fi
done < <(docker ps -a --filter 'label=com.docker.compose.project=bmstore' --format '{{.Names}}\t{{.State}}\t{{.Label "health"}}' 2>/dev/null \
         | while IFS=$'\t' read -r n s _; do printf '%s\t%s\t%s\n' "$n" "$s" "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$n" 2>/dev/null)"; done)
if [[ -n "$bad_services" ]]; then
  alert_state "services" bad "Service problem" "Unhealthy or stopped:$bad_services — ./deploy/compose.sh ps ; ./deploy/compose.sh logs --tail=100 <service>"
else
  alert_state "services" ok "Service problem" "all services running"
fi

# 2. backups -----------------------------------------------------------------
check_job() { # key file max_age_seconds label
  local key="$1" f="$APP_STATE/$2" max="$3" label="$4" status ts age
  if [[ ! -r "$f" ]]; then
    alert_state "$key" bad "$label never ran" "no state file $f — run it once by hand: see docs/runbooks/BACKUP_RESTORE.md"; return
  fi
  read -r status ts _ < "$f"
  age=$(( now - $(date -u -d "${ts:0:4}-${ts:4:2}-${ts:6:2}T${ts:9:2}:${ts:11:2}:${ts:13:2}Z" +%s 2>/dev/null || echo 0) ))
  if [[ "$status" != OK && "$status" != PASS ]]; then
    alert_state "$key" bad "$label FAILED" "last result: $(<"$f")"
  elif (( age > max )); then
    alert_state "$key" bad "$label is stale" "last success $(( age / 3600 )) h ago — check cron (/etc/cron.d/bmstore) and /var/log/bmstore/backup.log"
  else
    alert_state "$key" ok "$label" "last success $(( age / 3600 )) h ago"
  fi
}
# Backup state files are written by the backup container into /var/lib/bmstore (bind mount, see compose).
check_job backup.nightly   backup.nightly.last   $(( 26 * 3600 ))      "Nightly backup"
check_job backup.weekly    backup.weekly.last    $(( 8 * 86400 ))      "Weekly backup"
check_job restore.test     restore-test.last     $(( 32 * 86400 ))     "Monthly restore test"

# 3. last deploy ---------------------------------------------------------------
if [[ -r "${BMSTORE_STATE_DIR:-/var/lib/bmstore}/last_deploy" ]]; then
  read -r dstatus dts dtag _ < "${BMSTORE_STATE_DIR:-/var/lib/bmstore}/last_deploy"
  if [[ "$dstatus" != OK ]]; then
    alert_state "deploy" bad "Last deploy $dstatus" "at $dts (tag $dtag) — see /var/log/bmstore/deploy.log"
  else
    alert_state "deploy" ok "Last deploy" "OK at $dts (tag $dtag)"
  fi
fi

# 4. queue failures (future workers) ----------------------------------------------
failed_total=0 detail=""
while IFS= read -r key; do
  [[ -n "$key" ]] || continue
  n=$("$COMPOSE" exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASSWORD" zcard "$key" 2>/dev/null | tr -d '\r' || echo 0)
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  (( n > 0 )) && { failed_total=$((failed_total + n)); detail="$detail ${key#bull:}=$n"; }
done < <("$COMPOSE" exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASSWORD" --scan --pattern 'bull:*:failed' 2>/dev/null | tr -d '\r' || true)
if (( failed_total > 0 )); then
  alert_state "jobs.failed" bad "Failed background jobs: $failed_total" "queues:$detail"
else
  alert_state "jobs.failed" ok "Failed background jobs" "none"
fi

log "failed-jobs: services[${bad_services:- ok}] failed_jobs=$failed_total"
