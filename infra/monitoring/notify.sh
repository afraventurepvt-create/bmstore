#!/usr/bin/env bash
# =============================================================================
# BMStore notification interface (STUB with working transports).
#   notify.sh <severity: info|warning|critical> <title> <message>
#
# Channels (NOTIFY_CHANNELS, comma-separated):
#   stdout          always safe; cron mails/logs it
#   webhook         POST JSON to NOTIFY_WEBHOOK_URL (Slack/Discord/n8n/Make/your own endpoint)
#   whatsapp-cloud  Meta WhatsApp Cloud API -> owner's number (WHATSAPP_* vars).
#                   NOTE: Meta only delivers free-form text inside a 24 h service window; outside it
#                   you MUST use an approved template: set WHATSAPP_TEMPLATE_NAME (one {{1}} body param).
#   app             Reserved for the platform's own notification service (Phase 2):
#                   POSTs to NOTIFY_APP_URL with NOTIFY_APP_TOKEN. Logs "not configured" until then.
# Never exits non-zero because of a delivery problem (callers are backup/monitoring jobs).
# =============================================================================
set -u
SEV="${1:-info}"; TITLE="${2:-BMStore}"; MSG="${3:-}"
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || hostname)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CHANNELS="${NOTIFY_CHANNELS:-stdout}"
LOG_DIR="${BMSTORE_LOG_DIR:-/var/log/bmstore}"


line="[$NOW] [$SEV] $TITLE — $MSG"
printf '%s\n' "$line"
if [[ -d "$LOG_DIR" && -w "$LOG_DIR" ]]; then printf '%s\n' "$line" >> "$LOG_DIR/alerts.log" 2>/dev/null || true; fi

payload=$(jq -cn --arg s "$SEV" --arg t "$TITLE" --arg m "$MSG" --arg h "$HOSTNAME_SHORT" --arg ts "$NOW" \
  '{severity:$s,title:$t,message:$m,host:$h,time:$ts,source:"bmstore-monitoring"}')

IFS=',' read -ra chans <<< "$CHANNELS"
for ch in "${chans[@]}"; do
  case "$(echo "$ch" | tr -d ' ')" in
    stdout|"") ;;
    webhook)
      if [[ -n "${NOTIFY_WEBHOOK_URL:-}" ]]; then
        curl -sS -m 10 -o /dev/null -w 'webhook -> HTTP %{http_code}\n' -H 'Content-Type: application/json' \
          -X POST --data "$payload" "$NOTIFY_WEBHOOK_URL" || echo "webhook delivery failed" >&2
      else
        echo "notify: channel webhook selected but NOTIFY_WEBHOOK_URL is empty" >&2
      fi ;;
    whatsapp-cloud)
      if [[ -n "${WHATSAPP_PHONE_NUMBER_ID:-}" && -n "${WHATSAPP_ACCESS_TOKEN:-}" && -n "${WHATSAPP_OWNER_NUMBER:-}" ]]; then
        text="[$SEV] $TITLE: $MSG ($HOSTNAME_SHORT $NOW)"
        if [[ -n "${WHATSAPP_TEMPLATE_NAME:-}" ]]; then
          body=$(jq -cn --arg to "$WHATSAPP_OWNER_NUMBER" --arg tpl "$WHATSAPP_TEMPLATE_NAME" --arg lang "${WHATSAPP_TEMPLATE_LANG:-en}" --arg text "$text" \
            '{messaging_product:"whatsapp",to:$to,type:"template",template:{name:$tpl,language:{code:$lang},components:[{type:"body",parameters:[{type:"text",text:$text}]}]}}')
        else
          body=$(jq -cn --arg to "$WHATSAPP_OWNER_NUMBER" --arg text "$text" \
            '{messaging_product:"whatsapp",to:$to,type:"text",text:{preview_url:false,body:$text}}')
        fi
        curl -sS -m 15 -o /dev/null -w 'whatsapp -> HTTP %{http_code}\n' \
          -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN" -H 'Content-Type: application/json' \
          -X POST --data "$body" "https://graph.facebook.com/${WHATSAPP_API_VERSION:-v21.0}/${WHATSAPP_PHONE_NUMBER_ID}/messages" \
          || echo "whatsapp delivery failed" >&2
      else
        echo "notify: channel whatsapp-cloud selected but WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN / WHATSAPP_OWNER_NUMBER missing" >&2
      fi ;;
    app)
      if [[ -n "${NOTIFY_APP_URL:-}" ]]; then
        curl -sS -m 10 -o /dev/null -w 'app -> HTTP %{http_code}\n' -H 'Content-Type: application/json' \
          ${NOTIFY_APP_TOKEN:+-H "Authorization: Bearer $NOTIFY_APP_TOKEN"} -X POST --data "$payload" "$NOTIFY_APP_URL" \
          || echo "app notification failed" >&2
      else
        echo "notify: channel app is a stub until the platform notification service exists (NOTIFY_APP_URL)" >&2
      fi ;;
    *) echo "notify: unknown channel '$ch'" >&2 ;;
  esac
done
exit 0
