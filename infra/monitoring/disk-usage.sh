#!/usr/bin/env bash
# Disk + media usage (cron: every 6 hours). Alerts above DISK_WARN_PERCENT / DISK_CRIT_PERCENT
# and when media exceeds MEDIA_WARN_GB. Prints a short report either way.
# shellcheck source=infra/monitoring/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
: "${DISK_WARN_PERCENT:=80}" "${DISK_CRIT_PERCENT:=90}" "${MEDIA_WARN_GB:=50}"

report=""
# Check "/" and, only when it is a separate filesystem, /var/lib/docker.
mounts=(/)
if [[ -d /var/lib/docker ]] && [[ "$(df -P /var/lib/docker | awk 'NR==2{print $1}')" != "$(df -P / | awk 'NR==2{print $1}')" ]]; then
  mounts+=(/var/lib/docker)
fi
for mnt in "${mounts[@]}"; do
  read -r pct availk < <(df -P "$mnt" | awk 'NR==2 {gsub("%","",$5); print $5, $4}')
  report="$report $mnt=${pct}%"
  if (( pct >= DISK_CRIT_PERCENT )); then
    alert_state "disk.$mnt" bad "Disk CRITICAL $mnt ${pct}%" "$(( availk / 1024 )) MB free. Prune: docker system prune -af ; check /var/log and the backups volume."
  elif (( pct >= DISK_WARN_PERCENT )); then
    alert_state "disk.$mnt" bad "Disk warning $mnt ${pct}%" "$(( availk / 1024 )) MB free"
  else
    alert_state "disk.$mnt" ok "Disk warning $mnt" "now ${pct}%"
  fi
done

# Postgres database size
dbsize=$(pg_query "select pg_size_pretty(pg_database_size(current_database()))" || echo "n/a")
report="$report db=$dbsize"

# Docker images/volumes
if command -v docker >/dev/null; then
  dk=$(docker system df --format '{{.Type}}={{.Size}}' 2>/dev/null | tr '\n' ' ')
  report="$report docker[$dk]"
fi

# Media usage: MinIO volume on this box, or bucket size via the backup toolbox (rclone)
media_bytes=0
if [[ "${MEDIA_BACKEND:-minio}" == minio ]]; then
  media_bytes=$("$COMPOSE" exec -T minio du -sb /data 2>/dev/null | awk '{print $1}' || echo 0)
else
  media_bytes=$("$COMPOSE" run --rm -T backup media-size 2>/dev/null | tail -1 || echo 0)
fi
media_bytes=${media_bytes:-0}; [[ "$media_bytes" =~ ^[0-9]+$ ]] || media_bytes=0
media_gb=$(( media_bytes / 1024 / 1024 / 1024 ))
report="$report media=${media_gb}GB"
if (( media_gb >= MEDIA_WARN_GB )); then
  alert_state "media.size" bad "Media storage ${media_gb} GB" "exceeds MEDIA_WARN_GB=$MEDIA_WARN_GB"
else
  alert_state "media.size" ok "Media storage" "${media_gb} GB"
fi

log "usage:$report"
printf '%s\n' "$report" > "$STATE_DIR/disk.last" 2>/dev/null || true
