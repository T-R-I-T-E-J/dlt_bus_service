# Fresh DLT application on the VPS

Use branch `codex/vps-frontend-deployment`. Nginx serves HTTPS and the static
frontend. A dedicated Docker Compose project, `dlt-vps-fresh`, runs the API
and a **new PostgreSQL database**. Existing Neon/Railway data is neither
imported nor deleted. Existing unrelated VPS sites and containers stay separate.

The current advertised fare and new-trip default are **₹320 per seat**.
Actual checkout amounts still come from each trip and the frozen booking
price on the server. Existing financial records are not repriced.

## Check the server first

From `/opt/dlt-frontend`, run `docker compose version`, `free -h`, `df -h /`
and `ss -ltnp`. This setup requires Docker Compose **2.30+**, Nginx, Certbot
and outbound HTTPS. Port **3100** must be free. The existing sports app uses
port 3000; DLT does not use that host port. PostgreSQL has **no host port**;
the API is published only on `127.0.0.1:3100`.

The Compose version requirement enables literal environment values (`format:
raw`) so `$` and quote characters inside credentials are preserved.

## Generate private settings and create the database

```sh
cd /opt/dlt-frontend
git pull --ff-only
install -d -m 700 /etc/dlt-vps
docker run --rm -v "$PWD:/src:ro" -v /etc/dlt-vps:/config node:24-alpine node /src/deploy/vps/configure.mjs /config
```

This generates separate, random database-owner and runtime passwords, with
configuration files owned by root and mode 600. It refuses to replace a
nonempty configuration directory. Do not delete the directory to rerun it:
existing database credentials and generated files must remain consistent.
No credentials are printed. No admin user or demo booking is created.

```sh
docker compose -f deploy/vps/compose.yaml config --quiet
docker build --target runtime -t dlt-api:local backend
docker build --target tools -t dlt-api-tools:local backend
docker compose -f deploy/vps/compose.yaml up -d --wait db
docker compose -f deploy/vps/compose.yaml run --rm migrate
```

The PostgreSQL init script creates a restricted `dlt_app` login. The explicit
migration command applies the existing 26 migrations using the separate owner
connection, creating schema, permissions, immutable audit triggers and required
reference data. It does **not** run `seed-dev.mjs`, create student accounts or
invent trips. Subsequent migration runs skip files already applied.

Never use `docker compose down -v` for an update: it deletes this project's
database volume. Do not run the destructive backend test suite against this
database. The load checker only accepts a disposable local test database.

## Configure email and payments, then start the API

```sh
nano /etc/dlt-vps/runtime.env
```

Fill `RESEND_API_KEY`, a verified `EMAIL_FROM`, `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` directly on the VPS. Use
matching Razorpay test credentials while testing; switch to matching live
credentials only for real payment operation. Keep values as literal
`KEY=value` lines, without `export` or wrapping quotes. Leave the generated
`DATABASE_URL` unchanged. Never share these files or paste them into chat.

The runtime account has no database-owner privileges. Never set
`ALLOW_AUDIT_PRIVILEGE` or `EMAIL_TRANSPORT=memory` in production. The generated
login transport limit is 240 requests/minute per IP for a 200-student campus
burst; database account/IP failure lockouts remain active. Automatic refund
dispatch starts disabled; review pending refunds and the intended operations
policy before enabling it.

```sh
docker compose -f deploy/vps/compose.yaml run --rm --no-deps api npm run preflight:prod
docker compose -f deploy/vps/compose.yaml up -d --no-build api
docker compose -f deploy/vps/compose.yaml ps
curl --max-time 20 -fsS http://127.0.0.1:3100/api/ready
```

Expect `ok: true`, 26 migrations and `auditAppendOnly: true`. If startup fails,
inspect `docker compose -f deploy/vps/compose.yaml logs --tail 100 api`.
Readiness runs before API startup. Docker restarts crashed processes; an
unhealthy status alone does not automatically restart a running process.

## Connect the existing frontend preview over HTTPS

Confirm that Certbot has issued the certificate for
`dlt-187-127-177-22.sslip.io` before installing the TLS configuration below.
Use `certbot certificates` to check the actual certificate name/path. If it
has a suffix, adjust the two generated certificate paths to that existing
certificate before `nginx -t`.

```sh
DLT_RELEASE=$(git rev-parse --short HEAD)
install -d -m 755 /var/www/dlt/releases
docker run --rm -v "$PWD:/src:ro" -v /var/www/dlt/releases:/releases node:24-alpine node /src/deploy/frontend/prepare.mjs --api-origin http://127.0.0.1:3100 --domain dlt-187-127-177-22.sslip.io --out "/releases/$DLT_RELEASE"
readlink /var/www/dlt/current
cp -a /etc/nginx/sites-available/dlt-preview /etc/nginx/sites-available/dlt-preview.before-api
ln -s "/var/www/dlt/releases/$DLT_RELEASE/public" /var/www/dlt/current-next
mv -Tf /var/www/dlt/current-next /var/www/dlt/current
install -m 644 "/var/www/dlt/releases/$DLT_RELEASE/nginx-dlt.conf" /etc/nginx/sites-available/dlt-preview
nginx -t && systemctl reload nginx
```

The public frontend now calls `/api` through the same HTTPS origin; Nginx
forwards it to the VPS API. This preserves secure, HttpOnly login cookies and
requires no cross-origin credentials. No public Railway API URL is involved.
Keep one API instance: the background jobs currently run in-process.

## First admin, staff and boarding

1. Create an account through the normal Account page and verify the emailed
   code using the verification form. No seeded passwords exist.
2. Promote that verified account once, from the VPS, using:

```sh
docker compose -f deploy/vps/compose.yaml run --rm migrate node scripts/bootstrap-admin.mjs YOUR_VERIFIED_EMAIL "Initial administrator for the fresh DLT VPS application"
```

The bootstrap refuses an inactive/unverified account or any database where a
Super Admin already exists. It records the operator action and reason in the
audit log and revokes existing sessions. Sign in again after promotion.

For each initial boarding staff member, have them register and verify normally,
then provision their role from the VPS:

```sh
docker compose -f deploy/vps/compose.yaml run --rm migrate node scripts/configure-boarding-staff.mjs VERIFIED_STAFF_EMAIL "Initial boarding staff for DLT VPS operations"
```

This operator-only tool accepts an active verified ordinary account, records a
reason in the audit log, and revokes its prior sessions. It does not create a
password or expose a public role-changing endpoint. The staff member signs in
again. Use the Super Admin console to configure vehicles/trips and assign that
staff member to a trip. Boarding staff retain scan/read permissions only and
can scan only their assigned trip. The trip must be in its allowed boarding
window/state. Test a real phone's camera on HTTPS before admitting users.
Downloaded PNG tickets retain the original QR and existing 760×1120 format;
students can display them offline. The scanner still needs server access to
reject cancelled, refunded, wrong-trip and previously boarded passes.

## Backups and release checks

```sh
bash deploy/vps/backup.sh /var/backups/dlt-vps
```

Backups are private custom-format dumps with SHA-256 checksums. The script
does not prune old backups. Schedule it through root cron/systemd and copy
backups to separate storage; a file only on this VPS does not cover VPS loss.
Test restores in a separate database, preserving roles and audit privileges.

Before enabling student traffic, verify sign-in, email verification, staff
assignment, camera scanning, offline ticket download and rejection of an
already boarded/cancelled pass. Verify payment/webhook and refund behavior
using Razorpay test mode; no real payment was made by the local checks.

Local load checks exercise 100/200 seat-map readers, 200 contenders for one
seat, 200 duplicate booking submissions, 200 logins sharing one IP and 100
scans of one pass. These checks validate application behavior; VPS capacity
still needs a separate measurement using a disposable test database, including
its CPU/RAM and the other site's workload. Never run load fixtures against
real customer data.

For rollback, retain the previous static symlink target, Nginx file and API
image before updating. Restore the static/config copies and prior image if
login or booking fails. Preserve the database volume and financial/audit
records. Switch the main DLT domain only after the HTTPS preview passes.
