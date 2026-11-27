#!/usr/bin/env bash
set -euo pipefail
umask 077
TASK_REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TASK_BACKUP_DIR="${1:-/var/backups/dlt-vps}"
mkdir -p "$TASK_BACKUP_DIR"
TASK_BACKUP_FILE="$TASK_BACKUP_DIR/dlt-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
trap 'rm -f -- "$TASK_BACKUP_FILE.partial"' EXIT
docker compose -f "$TASK_REPO_DIR/deploy/vps/compose.yaml" exec -T db \
  pg_dump -U postgres -d dlt_prod --format=custom > "$TASK_BACKUP_FILE.partial"
mv -- "$TASK_BACKUP_FILE.partial" "$TASK_BACKUP_FILE"
sha256sum "$TASK_BACKUP_FILE" > "$TASK_BACKUP_FILE.sha256"
printf 'Backup written: %s\n' "$TASK_BACKUP_FILE"
# Retention is an operator decision. This script never prunes old backups.
