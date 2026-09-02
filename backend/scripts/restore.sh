#!/usr/bin/env bash
# DLT · scripts/restore.sh — restore a backup.sh dump into a NEW database.
#
# Deliberately refuses to restore over an existing database with data in
# it: pg_restore into a live target can partially apply and leave a database
# neither the old state nor the new one. Create a fresh target, restore into
# it, verify it, THEN repoint DATABASE_URL/promote it — never restore in
# place onto the database serving traffic.
#
# VERIFIED this session: see backup.sh's header and PRODUCTION_DEPLOYMENT.md
# for the exact restore this procedure was tested against.
#
# Usage:
#   DATABASE_URL=postgres://dlt_app:***@host:5432/dlt_restore_check \
#     ./scripts/restore.sh /var/backups/dlt/dlt-20260101T000000Z.dump
#
# The target database in DATABASE_URL must already exist and be empty
# (CREATE DATABASE dlt_restore_check first, as a superuser or a role with
# CREATEDB) — this script does not create databases, on purpose: that is a
# superuser action and this script runs with only what DATABASE_URL grants.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set." >&2
  exit 1
fi

DUMP_FILE="${1:-}"
if [ -z "$DUMP_FILE" ] || [ ! -f "$DUMP_FILE" ]; then
  echo "Usage: DATABASE_URL=... ./scripts/restore.sh <path-to-dump-file>" >&2
  exit 1
fi

pg_restore "$DATABASE_URL" --no-owner --exit-on-error "$DUMP_FILE"

echo "restore complete. Verify before promoting this database:"
echo "  psql \"\$DATABASE_URL\" -c \"SELECT count(*) FROM schema_migrations;\"   # expect 16"
echo "  psql \"\$DATABASE_URL\" -c \"SELECT count(*) FROM users;\""
echo "  psql \"\$DATABASE_URL\" -c \"DELETE FROM audit_logs;\"                   # MUST error — proves the append-only trigger survived"
