#!/usr/bin/env bash
# Uptime check for every tenant host + platform hosts (cron: every 5 minutes).
# A host is UP when https://<host>/api/health (or /health on the api host) answers 200 within 10 s.
# tenant hosts -> API health WITH tenant context (proves TLS + Caddy + API + DB/Redis + tenant row).
# shellcheck source=infra/monitoring/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

down=0 total=0 failed_list=""
while IFS= read -r host; do
  [[ -n "$host" ]] || continue
  total=$((total + 1))
  path="/api/health"; [[ "$host" == "api.$ROOT_DOMAIN" ]] && path="/health"
  code=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' -A bmstore-uptime "https://$host$path" 2>/dev/null || echo 000)
  if [[ "$code" == 200 ]]; then
    alert_state "uptime.$host" ok "Store down: $host" "https://$host answers 200 again"
  else
    down=$((down + 1)); failed_list="$failed_list $host($code)"
    alert_state "uptime.$host" bad "Store down: $host" "https://$host$path returned HTTP $code"
  fi
done < <(all_hosts)

log "uptime: $((total - down))/$total hosts up${failed_list:+; failing:$failed_list}"
# Whole-platform outage: one extra loud alert instead of N quiet ones.
if (( total > 0 && down * 2 >= total )); then
  alert_state "uptime.platform" bad "PLATFORM OUTAGE" "$down of $total hosts failing:$failed_list"
else
  alert_state "uptime.platform" ok "PLATFORM OUTAGE" "$((total - down))/$total hosts up"
fi
