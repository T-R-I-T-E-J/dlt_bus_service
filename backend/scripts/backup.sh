#!/usr/bin/env bash
# DLT · scripts/backup.sh — logical backup, pg_dump custom format.
#
# One file per run, timestamped, that pg_restore can apply to a fresh
# database of any name — this is what --format=custom buys over a plain
# SQL dump, and it's why restore.sh doesn't need to know what the backup's
# original database was called.
#
# VERIFIED this session against dlt_dev: dump -> restore into a fresh
# database -> row counts identical (users/trips/bookings/audit_logs) ->
# audit_logs' append-only trigger still refuses DELETE on the restored
# copy -> schema_migrations still reads 16. See PRODUCTION_DEPLOYMENT.md
# for the exact commands that verification ran.
#
# Usage:
#   DATABASE_URL=postgres://dlt_app:***@host:5432/dlt_prod \
#     ./scripts/backup.sh /var/backups/dlt
#
# Needs pg_dump on PATH (or run via `docker exec <pg-container> pg_dump ...`
# if PostgreSQL is containerized — see PRODUCTION_DEPLOYMENT.md).

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set." >&2
  exit 1
fi

OUT_DIR="${1:-.}"
mkdir -p "$OUT_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/dlt-$STAMP.dump"

pg_dump "$DATABASE_URL" --format=custom --file="$FILE"

echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"

# Retention: keep the last 14 daily backups, delete anything older. Adjust
# to whatever the real retention policy turns out to be — this is a
# starting point, not a compliance decision made on your behalf.
find "$OUT_DIR" -maxdepth 1 -name 'dlt-*.dump' -mtime +14 -print -delete
