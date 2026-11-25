# Move the Vercel frontend to a personal VPS

> For the current fresh VPS backend/database plan, use
> [VPS_FRESH.md](VPS_FRESH.md). The preview instructions here remain useful;
> the Railway connection instructions describe the earlier external-API option.

## Static preview before connecting the backend

For frontend-first testing, package without an API connection:

```sh
node deploy/frontend/prepare.mjs --preview --domain dlt-preview.local --out /tmp/dlt-preview-release
```

This creates `public/` and `nginx-preview.conf`. Publish `public/` through
`/var/www/dlt/current` and add the preview configuration as its own Nginx
site. Test locally with `curl -H 'Host: dlt-preview.local' http://127.0.0.1/`.
The preview serves the pages and assets, returns an explicit 503 for API
requests and marks responses as non-indexable. It makes no backend or
database connection. Login, bookings and payments require the backend and
HTTPS and are not functional in this static preview. Existing production
DNS and other Nginx sites need no changes for these local checks.

The remainder of this guide covers connecting the API and enabling HTTPS.

## Production frontend

Use branch `codex/vps-frontend-deployment`, based on `master` commit
`f15c446`. This moves **only the frontend** to the VPS and routes API
requests to your **new Railway backend public URL**. To retain existing
users, bookings and payments, connect that backend to the existing database.
Do not run database migrations, seed scripts, or the backend systemd template
as part of this frontend move.

The browser continues to use `/api` on the DLT domain. Nginx proxies those
requests to the supplied Railway origin over verified HTTPS. The VPS does not
use the old upstream in `vercel.json`. Sessions use secure cookies, so HTTPS is required. Keep the
existing domain, including whichever of the apex and `www` names customers
use; the examples below cover both `dltservices.tech` and
`www.dltservices.tech`.

## Confirm the backend before cutover

Deploy the compatible DLT API on Railway and obtain its public HTTPS origin
(for example, `https://your-new-api.up.railway.app`, without `/api`). Configure
its runtime database connection to use the existing database and restricted
role, and carry over the required email/payment configuration through
Railway's environment settings. Keep those credentials off the frontend VPS.
Do not provision or seed an empty replacement database for this hosting move.
Confirm the new API can read existing records before switching DNS. A new
API URL alone does not transfer data from an old database.

The packager requires `--api-origin` and has no default upstream. Every release
must explicitly name the new backend; it never falls back to the old URL.

## Prepare on the VPS

Assumes Ubuntu/Debian with Nginx, Certbot, CA certificates, Git and Node.js
22+ available. Node runs the packaging script only; no Node service,
PostgreSQL, Redis, SMTP or Razorpay credentials belong on this frontend VPS.
If a hosting control panel already manages Nginx, install the generated
server configuration through that panel instead of creating a competing site.

```sh
git clone --branch codex/vps-frontend-deployment https://github.com/T-R-I-T-E-J/dlt_bus_service.git
cd dlt_bus_service
RELEASE_ID=$(git rev-parse --short HEAD)
read -r -p 'New Railway public API origin (https://...): ' RAILWAY_API_ORIGIN
curl --max-time 20 -fsS "$RAILWAY_API_ORIGIN/api/healthz"
curl --max-time 20 -fsS "$RAILWAY_API_ORIGIN/api/ready"
node deploy/frontend/prepare.mjs --api-origin "$RAILWAY_API_ORIGIN" --domain dltservices.tech --alias www.dltservices.tech --out /tmp/dlt-$RELEASE_ID
sudo install -d -m 755 /var/www/dlt/releases /var/www/letsencrypt
sudo cp -a /tmp/dlt-$RELEASE_ID/public /var/www/dlt/releases/$RELEASE_ID
sudo chown -R root:root /var/www/dlt/releases/$RELEASE_ID
sudo chmod -R a+rX /var/www/dlt/releases/$RELEASE_ID
sudo ln -s /var/www/dlt/releases/$RELEASE_ID /var/www/dlt/current-next
sudo mv -Tf /var/www/dlt/current-next /var/www/dlt/current
```

Proceed only if both backend checks return `ok: true`. The output directory must be new; the packager refuses to overwrite an
existing one. Only the six customer pages, public scripts and static assets
are copied. Backend code, environment files, uploads, tests, prototypes and
internal audit documents are excluded. Vercel analytics script tags are
removed from the generated pages. The source pages and Vercel configuration
are preserved so the existing Vercel deployment remains available for rollback.

## Domain and HTTPS

Before changing DNS, save the existing DNS records and keep the current
Vercel project running. Prepare the files above first. Only change the web
records: point the apex A record to the VPS public IPv4 address; point `www`
to the apex or the VPS. Remove old conflicting Vercel web records. Update or
remove old AAAA records if this VPS will not serve IPv6. Preserve MX, TXT,
email verification and other unrelated records. Allow inbound ports 80/443
in the VPS firewall. Keep DNS in direct/DNS-only mode for this configuration.

**For the first certificate**, install the temporary HTTP-only configuration
below, then point DNS at the VPS and request the certificate. It returns 503
to visitors until HTTPS is activated, so schedule this short cutover. For a
cutover without that interval, obtain the certificate using your DNS provider's
DNS challenge before changing the web records instead.

```sh
sudo cp /tmp/dlt-$RELEASE_ID/nginx-bootstrap.conf /etc/nginx/sites-available/dlt
sudo ln -s /etc/nginx/sites-available/dlt /etc/nginx/sites-enabled/dlt
sudo nginx -t
sudo systemctl reload nginx
# Now point web DNS records to the VPS and wait until both resolve there.
sudo certbot certonly --webroot -w /var/www/letsencrypt -d dltservices.tech -d www.dltservices.tech
sudo cp /tmp/dlt-$RELEASE_ID/nginx-dlt.conf /etc/nginx/sites-available/dlt
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

If the `dlt` site already exists, update its existing file/link instead of
creating a duplicate. Do not replace other sites on the VPS. Confirm the
certificate includes every configured domain and that automatic certificate
renewal is enabled. Add a Certbot deploy hook to reload Nginx after renewal:

```sh
sudo install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nnginx -t && systemctl reload nginx\n' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx >/dev/null
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
```

The generated configuration expects the standard Debian/Ubuntu CA bundle.
Its HTTPS upstream options follow the [Nginx proxy module documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).
Nginx resolves the Railway hostname when it loads the configuration; reload
Nginx if Railway changes its upstream IP addresses.

## Verify existing data before considering the move finished

```sh
curl -fsS https://dltservices.tech/api/healthz
curl -fsS https://dltservices.tech/api/ready
curl -I https://dltservices.tech/booking
curl -I https://dltservices.tech/account
curl -I https://dltservices.tech/backend/.env
```

Health/readiness should return `ok: true`; pages should return 200 and the
backend file probe must return 404. Also check `/my-trips`, `/admin`,
`/policies`, the 3D model, and redirects `/book`, `/terms`, `/privacy`.
In a browser, sign in with an existing account and confirm its existing
bookings/passes and admin records match the current site. Check that API
requests go through the DLT domain and retain secure cookies. Do not create
real payments or refunds merely to smoke-test hosting.

This package does not copy or recreate data. Existing records remain available
when the new Railway backend uses the **existing database**. Confirm that
connection and the existing records before cutover.
If Razorpay sends webhooks directly to the old Railway hostname, update the
provider's webhook destination to the new backend's existing webhook route,
retaining its configured signing secret and event subscriptions.
If a webhook already uses the DLT domain, its `/api/` path is forwarded to
Railway with the original request body and signature headers. Verify delivery
status through the existing provider tooling after cutover.

## Updates and rollback

For updates, pull this branch, package into a new directory, copy to a new
`/var/www/dlt/releases/<commit>` directory and switch the `current` symlink
using the same `current-next` + `mv -Tf` commands. Record the prior target
with `readlink /var/www/dlt/current` before switching. If login, existing
bookings, API access or payment callbacks fail, restore that prior target
and investigate Nginx's error log. To roll back the initial hosting move,
restore the saved Vercel DNS records; DNS propagation can delay recovery.
Neither rollback requires changing the database.

VPS execution, DNS cutover, TLS issuance and browser verification must be
performed on the actual host. Preparing this branch does not mean it is live.
