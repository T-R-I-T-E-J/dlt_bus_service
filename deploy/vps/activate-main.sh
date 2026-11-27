#!/usr/bin/env bash
# Activate the prepared main-domain release after the Live webhook is enabled.
set -euo pipefail
umask 077

if [[ "$EUID" -ne 0 ]]; then
  echo 'Run this on the VPS as root.' >&2
  exit 1
fi
TASK_REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$TASK_REPO_DIR"
TASK_COMPOSE=(docker compose -f deploy/vps/compose.yaml)
TASK_RELEASE="$(cat /var/www/dlt/pending-main-release)"
[[ "$TASK_RELEASE" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo 'Invalid pending release.' >&2; exit 1; }
TASK_RELEASE_DIR="/var/www/dlt/releases/$TASK_RELEASE"
test -d "$TASK_RELEASE_DIR/public"
test -s "$TASK_RELEASE_DIR/nginx-dlt.conf"
test -s /etc/letsencrypt/live/dltservices.tech/fullchain.pem
test -s /etc/letsencrypt/live/dltservices.tech/privkey.pem
test -f /etc/nginx/sites-available/dlt-main
test -L /etc/nginx/sites-enabled/dlt-main
TASK_OLD_TARGET="$(readlink /var/www/dlt/current)"
[[ "$TASK_OLD_TARGET" = /* && -d "$TASK_OLD_TARGET" ]] || { echo 'Current frontend target is invalid.' >&2; exit 1; }

# Read the new environment without printing credentials or provider records.
# This GET authenticates the key pair without creating an order or payment.
"${TASK_COMPOSE[@]}" run --rm -T --no-deps api node --input-type=module <<'NODE'
const env = process.env;
if (!env.RAZORPAY_KEY_ID?.startsWith('rzp_live_')) throw new Error('Live Razorpay key ID is required.');
if (!env.RAZORPAY_KEY_SECRET) throw new Error('Razorpay key secret is missing.');
if (!env.RAZORPAY_WEBHOOK_SECRET || env.RAZORPAY_WEBHOOK_SECRET.length < 32)
  throw new Error('Save the generated webhook secret in runtime.env first.');
if (env.RAZORPAY_BASE_URL && env.RAZORPAY_BASE_URL.replace(/\/$/, '') !== 'https://api.razorpay.com/v1')
  throw new Error('Production must use the official Razorpay API.');
const response = await fetch('https://api.razorpay.com/v1/orders?count=1', {
  headers: { Authorization: 'Basic ' + Buffer.from(env.RAZORPAY_KEY_ID + ':' + env.RAZORPAY_KEY_SECRET).toString('base64') },
  signal: AbortSignal.timeout(15000),
});
await response.body?.cancel();
if (!response.ok) throw new Error('Live Razorpay credentials were rejected (HTTP ' + response.status + ').');
console.log('Live Razorpay key pair verified. No payment was created.');
NODE
"${TASK_COMPOSE[@]}" run --rm -T --no-deps api npm run preflight:prod
bash deploy/vps/backup.sh /var/backups/dlt-vps
"${TASK_COMPOSE[@]}" up -d --no-deps --force-recreate --wait api

TASK_STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
TASK_CONFIG_BACKUP="/etc/nginx/sites-available/dlt-main.before-live-$TASK_STAMP"
TASK_LINK="/var/www/dlt/.activate-main-$TASK_STAMP"
cp -p /etc/nginx/sites-available/dlt-main "$TASK_CONFIG_BACKUP"
printf 'previous_frontend=%s\nnginx_backup=%s\n' "$TASK_OLD_TARGET" "$TASK_CONFIG_BACKUP" > /var/www/dlt/main-rollback
TASK_FRONTEND_CHANGED=0
restore_on_failure() {
  local result=$?
  trap - EXIT
  if (( result != 0 && TASK_FRONTEND_CHANGED == 1 )); then
    echo 'Readiness diagnostics before rollback (no credentials):' >&2
    curl --noproxy '*' --max-time 5 -sS http://127.0.0.1:3100/api/ready >&2 || true
    printf '\n' >&2
    curl --noproxy '*' --max-time 5 -sS -i --resolve 'dltservices.tech:443:127.0.0.1' https://dltservices.tech/api/ready >&2 || true
    echo 'Activation failed; restoring the previous frontend and Nginx configuration.' >&2
    cp -p "$TASK_CONFIG_BACKUP" /etc/nginx/sites-available/dlt-main || true
    ln -s "$TASK_OLD_TARGET" "$TASK_LINK.rollback" && mv -Tf "$TASK_LINK.rollback" /var/www/dlt/current || true
    nginx -t && systemctl reload nginx || true
    echo 'API credentials and database were retained; review the error before retrying.' >&2
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
# systemctl returns after signalling Nginx; old setup workers can briefly
# answer 503 while the new configuration takes over. Retry transient failures,
# but retain rollback if the new site never becomes ready.
TASK_CURL=(curl --noproxy '*' --max-time 20 --retry 10 --retry-delay 1 --retry-max-time 30 --retry-connrefused -fsS)
for TASK_DOMAIN in dltservices.tech www.dltservices.tech; do
  "${TASK_CURL[@]}" --resolve "$TASK_DOMAIN:443:127.0.0.1" "https://$TASK_DOMAIN/api/ready"
  printf '\n'
  "${TASK_CURL[@]}" -o /dev/null --resolve "$TASK_DOMAIN:443:127.0.0.1" "https://$TASK_DOMAIN/booking"
done
printf '%s\n' "$TASK_RELEASE" > /var/www/dlt/active-main-release
TASK_FRONTEND_CHANGED=0
trap - EXIT
printf 'Activated %s at https://dltservices.tech\n' "$TASK_RELEASE"
echo 'Confirm the first successful payment, webhook delivery and QR pass before announcing bookings.'
