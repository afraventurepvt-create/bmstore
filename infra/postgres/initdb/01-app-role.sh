#!/usr/bin/env bash
# Runs ONCE, when the Postgres data volume is first initialised (docker-entrypoint-initdb.d).
# Creates the non-owner application role so the API can start before the first deploy.
# deploy/deploy.sh re-applies the same SQL after every migration.
set -Eeuo pipefail
: "${APP_DB_USER:=bmstore_app}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_user="$APP_DB_USER" -v app_password="$APP_DB_PASSWORD" \
  -v owner="$POSTGRES_USER" -v dbname="$POSTGRES_DB" \
  -f /opt/bmstore/app-role.sql
echo "initdb: application role $APP_DB_USER ready"
