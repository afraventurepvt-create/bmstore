#!/usr/bin/env bash
# Certificate expiry for every public host (cron: daily). Caddy renews ~30 days before expiry,
# so anything under SSL_WARN_DAYS (14) means renewal is broken (DNS changed, rate-limited, ask denied).
# A failed handshake is also reported (host not pointing here, or on-demand issuance refused).
# shellcheck source=infra/monitoring/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
: "${SSL_WARN_DAYS:=14}"

now=$(date +%s); checked=0; problems=0
while IFS= read -r host; do
  [[ -n "$host" ]] || continue
  checked=$((checked + 1))
  enddate=$(timeout 15 openssl s_client -servername "$host" -connect "$host:443" </dev/null 2>/dev/null \
            | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)
  if [[ -z "$enddate" ]]; then
    problems=$((problems + 1))
    alert_state "ssl.$host" bad "TLS handshake failed: $host" "No certificate served for $host (DNS not pointing here, or on-demand issuance denied/failed — check caddy logs)"
    continue
  fi
  exp=$(date -d "$enddate" +%s 2>/dev/null || echo 0)
  days=$(( (exp - now) / 86400 ))
  if (( days < SSL_WARN_DAYS )); then
    problems=$((problems + 1))
    alert_state "ssl.$host" bad "Certificate expires in ${days}d: $host" "Expires $enddate. Caddy should have renewed; see: ./deploy/compose.sh logs caddy | grep -i $host"
  else
    alert_state "ssl.$host" ok "Certificate expires soon: $host" "valid for ${days} more days"
  fi
done < <(all_hosts)
log "ssl: checked $checked hosts, $problems problem(s)"
