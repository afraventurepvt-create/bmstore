#!/usr/bin/env bash
# Entrypoint of the "backup" compose service.
#   nightly | weekly | predeploy      -> backup.sh
#   restore <args...>                 -> restore.sh
#   restore-test                      -> restore-test.sh
#   list [kind]                       -> list dumps in the bucket (default nightly)
#   media-size                        -> bytes used by the media bucket (used by disk-usage.sh)
#   shell                             -> bash
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cmd="${1:-help}"; shift || true
case "$cmd" in
  nightly|weekly|predeploy) exec "$HERE/backup.sh" "$cmd" ;;
  restore)       exec "$HERE/restore.sh" "$@" ;;
  restore-test)  exec "$HERE/restore-test.sh" ;;
  list)
    # shellcheck source=infra/backup/lib.sh
    source "$HERE/lib.sh"; setup_remote || die "no bucket configured"
    rclone lsl "$(remote_path "postgres/${1:-nightly}")" ;;
  media-size)
    # shellcheck source=infra/backup/lib.sh
    source "$HERE/lib.sh"; setup_media_remote || { echo 0; exit 0; }
    rclone size --json "media:$S3_BUCKET" 2>/dev/null | jq -r '.bytes // 0' ;;
  shell) exec bash ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
