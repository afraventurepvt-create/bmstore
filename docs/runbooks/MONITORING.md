# Monitoring & alerts runbook

Host-side bash scripts in `infra/monitoring/`, scheduled by `/etc/cron.d/bmstore`, state in
`/var/lib/bmstore/monitor/`, logs in `/var/log/bmstore/`. No agent, no extra services. Each check sends ONE alert
when something breaks, a reminder every `ALERT_REPEAT_MINUTES` (240) while it stays broken, and a recovery notice.

| Check | Every | Alerts when |
|-------|-------|-------------|
| `uptime-check.sh` | 5 min | `https://<host>/api/health` ≠ 200 for a tenant host (subdomain or custom domain, active tenants from the DB) or for `api./admin./console.`; one extra "PLATFORM OUTAGE" alert if ≥ 50 % fail |
| `failed-jobs.sh` | 15 min | a compose service stopped/unhealthy or restarted ≥ 3× in 15 min; nightly backup > 26 h, weekly > 8 d, restore-test > 32 d or FAIL; last deploy not OK; any `bull:*:failed` queue in Redis non-empty (future workers) |
| `disk-usage.sh` | 6 h | root (and `/var/lib/docker` if separate) ≥ `DISK_WARN_PERCENT` 80 / `DISK_CRIT_PERCENT` 90; media ≥ `MEDIA_WARN_GB`; also logs DB size and `docker system df` |
| `ssl-expiry.sh` | daily | certificate of any host expires in < `SSL_WARN_DAYS` (14) — Caddy renews at 30 days, so this means renewal is broken — or the TLS handshake fails |

Run any of them by hand to see the current status; they print a one-line summary.

## 2. The notification interface (`infra/monitoring/notify.sh`)
```bash
./infra/monitoring/notify.sh <info|warning|critical> "<title>" "<message>"
```
`NOTIFY_CHANNELS` (comma-separated) selects transports:
- `stdout` — always; ends up in the cron log.
- `webhook` — JSON `{severity,title,message,host,time,source}` POSTed to `NOTIFY_WEBHOOK_URL`. Works with Slack/Discord
  incoming webhooks (they accept unknown fields and show nothing useful; put an n8n/Make/Zapier hook in between to format),
  or with the platform's own endpoint later.
- `whatsapp-cloud` — **the owner's WhatsApp via Meta's Cloud API.** Stub in the sense that nothing is provisioned for you;
  the HTTP call is real. Setup (free tier covers alert volumes):
  1. developers.facebook.com → create a *Business* app → add **WhatsApp** → note the **Phone number ID** and create a
     permanent **System user access token** with `whatsapp_business_messaging`.
  2. Add the owner's number as a recipient (test numbers) or verify your own business number.
  3. Meta delivers free-form text only inside a 24-hour window after the recipient last messaged you. For unattended alerts
     create a **template** (e.g. name `bmstore_alert`, body `{{1}}`), get it approved, and set
     `WHATSAPP_TEMPLATE_NAME=bmstore_alert` (`WHATSAPP_TEMPLATE_LANG=en`).
  4. Env: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_OWNER_NUMBER=91XXXXXXXXXX`, `NOTIFY_CHANNELS=stdout,whatsapp-cloud`.
  5. Test: `./infra/monitoring/notify.sh info "Test" "hello"` → `whatsapp -> HTTP 200`.
  Alternatives with the same shape: Twilio WhatsApp (`webhook` + a Twilio Function), or the platform's notification
  service once it exists (`app` channel: `NOTIFY_APP_URL` + `NOTIFY_APP_TOKEN`, currently a logged stub).
- `app` — reserved for the Phase 2 notification service inside the API (per-tenant WhatsApp via the tenant's number).

Backup jobs use the same script inside the container (the `backup` service receives the `NOTIFY_*`/`WHATSAPP_*` vars).

## 3. Reading the logs
```bash
tail -f /var/log/bmstore/uptime.log /var/log/bmstore/failed-jobs.log
```
```bash
grep -h critical /var/log/bmstore/alerts.log | tail
```
```bash
./deploy/compose.sh logs --since 1h caddy | jq -r 'select(.status>=500) | [.ts,.request.host,.request.uri,.status] | @tsv'
```
Caddy access logs are JSON per request (status, duration, host, client IP) — enough for a quick error-rate look;
ship them to a log service later if needed.

## 4. Silencing / tuning
- Remove a host from uptime checks: suspend the tenant (status ≠ active) or fix it; there is no mute list on purpose.
- Add extra hosts: `UPTIME_EXTRA_HOSTS="status.bmtechx.in other.example"`.
- Reset state after maintenance: `rm /var/lib/bmstore/monitor/*` (next run re-alerts only for what is still broken).

## 5. What is deliberately not here
No metrics database, no dashboards, no paging rotation. For one VPS with cron-based checks and WhatsApp alerts this is
adequate; when there are two servers or an on-call rota, move to Uptime Kuma / Grafana Cloud and keep `notify.sh` as the
common sink.
