#!/usr/bin/env bash
# Thin wrapper so every human and every cron job runs docker compose the same way.
#   ./deploy/compose.sh ps | logs -f api | run --rm migrate | exec -T postgres psql ...
# Env file: /etc/bmstore/production.env (override with BMSTORE_ENV_FILE). Project dir: repo root.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${BMSTORE_ENV_FILE:-/etc/bmstore/production.env}"
STATE_DIR="${BMSTORE_STATE_DIR:-/var/lib/bmstore}"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "compose.sh: env file not readable: $ENV_FILE (copy deploy/.env.production.example there)" >&2
  exit 2
fi

# Pin to the image tag of the last successful deploy unless the caller sets IMAGE_TAG.
if [[ -z "${IMAGE_TAG:-}" && -r "$STATE_DIR/current_tag" ]]; then
  IMAGE_TAG="$(<"$STATE_DIR/current_tag")"
fi
export IMAGE_TAG="${IMAGE_TAG:-latest}"

exec docker compose \
  --project-directory "$ROOT_DIR" \
  --env-file "$ENV_FILE" \
  -f "$ROOT_DIR/deploy/docker-compose.prod.yml" \
  "$@"
