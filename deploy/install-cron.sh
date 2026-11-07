#!/usr/bin/env bash
# Installs /etc/cron.d/bmstore and /etc/logrotate.d/bmstore for this checkout. Run with sudo:
#   sudo ./deploy/install-cron.sh [deploy-user]
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="${1:-${SUDO_USER:-deploy}}"
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
id "$USER_NAME" >/dev/null
install -d -m 755 -o "$USER_NAME" -g "$USER_NAME" /var/log/bmstore /var/lib/bmstore
sed -e "s|__USER__|$USER_NAME|g" -e "s|__APP_DIR__|$ROOT_DIR|g" "$ROOT_DIR/infra/cron/bmstore.cron" > /etc/cron.d/bmstore
chmod 644 /etc/cron.d/bmstore
sed -e "s|__USER__|$USER_NAME|g" "$ROOT_DIR/infra/cron/logrotate-bmstore" > /etc/logrotate.d/bmstore
chmod 644 /etc/logrotate.d/bmstore
systemctl reload cron 2>/dev/null || systemctl restart cron
echo "installed /etc/cron.d/bmstore for user $USER_NAME in $ROOT_DIR"
crontab -l -u "$USER_NAME" >/dev/null 2>&1 && echo "note: $USER_NAME also has a personal crontab; check for duplicates with: crontab -l -u $USER_NAME" || true
