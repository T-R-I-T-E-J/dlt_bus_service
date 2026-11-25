#!/usr/bin/env bash
# Update the live frontend and its Nginx rules without restarting the API.
set -euo pipefail
umask 077
[[ "$EUID" -eq 0 ]] || { echo 'Run this on the VPS as root.' >&2; exit 1; }
TASK_REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$TASK_REPO_DIR"
test -s /var/www/dlt/active-main-release
test -f /etc/nginx/sites-available/dlt-main
test -L /etc/nginx/sites-enabled/dlt-main
TASK_OLD_TARGET="$(readlink /var/www/dlt/current)"
[[ "$TASK_OLD_TARGET" = /* && -d "$TASK_OLD_TARGET" ]] || { echo 'Current frontend target is invalid.' >&2; exit 1; }
TASK_STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
TASK_RELEASE="$(git rev-parse --short HEAD)-main-$TASK_STAMP"
TASK_RELEASE_DIR="/var/www/dlt/releases/$TASK_RELEASE"
TASK_CONFIG_BACKUP="/etc/nginx/sites-available/dlt-main.before-frontend-$TASK_STAMP"
TASK_LINK="/var/www/dlt/.update-main-$TASK_STAMP"

docker run --rm -v "$PWD:/src:ro" -v /var/www/dlt/releases:/releases node:24-alpine \
  node /src/deploy/frontend/prepare.mjs --api-origin http://127.0.0.1:3100 \
  --domain dltservices.tech --alias www.dltservices.tech --out "/releases/$TASK_RELEASE"
cp -p /etc/nginx/sites-available/dlt-main "$TASK_CONFIG_BACKUP"
printf 'previous_frontend=%s\nnginx_backup=%s\n' "$TASK_OLD_TARGET" "$TASK_CONFIG_BACKUP" > /var/www/dlt/main-rollback
TASK_FRONTEND_CHANGED=0
restore_on_failure() {
  local result=$?
  trap - EXIT
  if (( result != 0 && TASK_FRONTEND_CHANGED == 1 )); then
    echo 'Frontend update failed; restoring its previous release and Nginx rules.' >&2
    cp -p "$TASK_CONFIG_BACKUP" /etc/nginx/sites-available/dlt-main || true
    ln -s "$TASK_OLD_TARGET" "$TASK_LINK.rollback" && mv -Tf "$TASK_LINK.rollback" /var/www/dlt/current || true
    nginx -t && systemctl reload nginx || true
  fi
  exit "$result"
}
trap restore_on_failure EXIT
TASK_FRONTEND_CHANGED=1
install -m 644 "$TASK_RELEASE_DIR/nginx-dlt.conf" /etc/nginx/sites-available/dlt-main
nginx -t
ln -s "$TASK_RELEASE_DIR/public" "$TASK_LINK"
mv -Tf "$TASK_LINK" /var/www/dlt/current
systemctl reload nginx
TASK_CURL=(curl --noproxy '*' --max-time 20 --retry 10 --retry-delay 1 --retry-max-time 30 --retry-connrefused -fsS)
for TASK_DOMAIN in dltservices.tech www.dltservices.tech; do
  for TASK_PATH in /api/ready /booking /robots.txt /sitemap.xml; do
    "${TASK_CURL[@]}" -o /dev/null --resolve "$TASK_DOMAIN:443:127.0.0.1" "https://$TASK_DOMAIN$TASK_PATH"
  done
done
printf '%s\n' "$TASK_RELEASE" > /var/www/dlt/active-main-release
printf '%s\n' "$TASK_RELEASE" > /var/www/dlt/pending-main-release
TASK_FRONTEND_CHANGED=0
trap - EXIT
printf 'Updated frontend: %s\n' "$TASK_RELEASE"
echo 'API process, credentials and database were not changed.'
