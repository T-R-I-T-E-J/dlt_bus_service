#!/usr/bin/env bash
# Update the API and frontend after CI; preserve the previous image for rollback.
set -euo pipefail
[[ "$EUID" -eq 0 ]] || { echo 'Run this on the VPS as root.' >&2; exit 1; }
TASK_REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$TASK_REPO_DIR"
bash deploy/vps/check-release.sh
TASK_COMPOSE=(docker compose -f deploy/vps/compose.yaml)
TASK_CONTAINER="$("${TASK_COMPOSE[@]}" ps -q api)"
test -n "$TASK_CONTAINER" || { echo 'No running API to preserve; use the initial setup guide.' >&2; exit 1; }
TASK_OLD_IMAGE="$(docker inspect --format '{{.Image}}' "$TASK_CONTAINER")"
TASK_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
docker image tag "$TASK_OLD_IMAGE" "dlt-api:before-$TASK_STAMP"
TASK_API_TAG="${DLT_IMAGE_TAG:-local}"
TASK_BACKEND_CHANGED=0
rollback_api() {
  local result=$?
  trap - EXIT
  if (( result != 0 )); then
    echo 'Release failed; restoring the previous API image tag.' >&2
    docker image tag "$TASK_OLD_IMAGE" "dlt-api:$TASK_API_TAG"
    if (( TASK_BACKEND_CHANGED == 1 )); then
      "${TASK_COMPOSE[@]}" up -d --no-deps --wait --wait-timeout 120 api || true
    fi
  fi
  exit "$result"
}
trap rollback_api EXIT
"${TASK_COMPOSE[@]}" build api
# This release does not apply database migrations or alter payment credentials.
"${TASK_COMPOSE[@]}" run --rm --no-deps api npm run preflight:prod
bash deploy/vps/backup.sh
TASK_BACKEND_CHANGED=1
"${TASK_COMPOSE[@]}" up -d --no-deps --wait --wait-timeout 120 api
bash deploy/vps/update-main-frontend.sh
TASK_BACKEND_CHANGED=0
trap - EXIT
printf 'Updated API and frontend at commit %s. Previous API: dlt-api:before-%s\n' "$(git rev-parse --short HEAD)" "$TASK_STAMP"
