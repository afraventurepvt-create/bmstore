#!/usr/bin/env bash
# Forced command for the GitHub Actions deploy key. In ~deploy/.ssh/authorized_keys:
#   command="/opt/bmstore/deploy/ci-entry.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... github-deploy
# The CI key can then ONLY run the deploy script (with a ref and the whitelisted flags), nothing else.
set -Eeuo pipefail
APP_DIR="${BMSTORE_APP_DIR:-/opt/bmstore}"
orig="${SSH_ORIGINAL_COMMAND:-deploy}"
# Accept both "deploy <ref> <flags>" and the plain-key form "cd /opt/bmstore && ./deploy/deploy.sh <ref> <flags>".
orig="${orig#cd * && }"
read -r -a words <<< "$orig"
cmd="${words[0]:-deploy}"; args=("${words[@]:1}")
[[ "$cmd" == */deploy/deploy.sh ]] && cmd=deploy
[[ "$cmd" == */deploy/compose.sh && "${args[0]:-}" == ps ]] && { cmd=status; args=(); }
case "$cmd" in
  deploy)
    for a in "${args[@]}"; do
      case "$a" in
        --no-backup|--skip-migrate|--rollback|--dry-run) ;;
        --*) echo "flag not allowed over CI: $a" >&2; exit 2 ;;
        *) [[ "$a" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || { echo "invalid ref" >&2; exit 2; } ;;
      esac
    done
    exec "$APP_DIR/deploy/deploy.sh" "${args[@]}" ;;
  status)  exec "$APP_DIR/deploy/compose.sh" ps ;;
  *) echo "command not allowed: $cmd" >&2; exit 2 ;;
esac
