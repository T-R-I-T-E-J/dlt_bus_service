#!/usr/bin/env bash
set -euo pipefail
TASK_REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$TASK_REPO_DIR"
test -z "$(git status --porcelain --untracked-files=no)" || { echo 'Tracked files have local changes; release stopped.' >&2; exit 1; }
TASK_COMMIT="$(git rev-parse HEAD)"
docker run --rm -v "$TASK_REPO_DIR:/src:ro" node:24-alpine node /src/deploy/vps/check-ci.mjs "$TASK_COMMIT"
