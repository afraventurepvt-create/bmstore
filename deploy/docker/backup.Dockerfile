# syntax=docker/dockerfile:1.7
# Backup/restore toolbox: pg_dump/pg_restore 16 + rclone (S3/R2/MinIO) + age (optional encryption) + curl.
FROM postgres:16-alpine
RUN apk add --no-cache bash curl rclone age coreutils jq tzdata
# Scripts are bind-mounted read-only at /opt/bmstore/backup and /opt/bmstore/monitoring.
WORKDIR /opt/bmstore/backup
ENTRYPOINT ["/opt/bmstore/backup/entrypoint.sh"]
