# Move the Vercel frontend to a personal VPS

Use branch `codex/vps-frontend-deployment`, based on `master` commit
`f15c446`. This moves **only the frontend**. The API continues at
`https://dlt-api-production.up.railway.app`, using its existing database,
users, bookings, payments and environment variables. Do not run database
migrations, seed scripts, or the backend systemd template for this move.

The browser continues to use `/api` on the DLT domain. Nginx proxies those
requests to Railway over verified HTTPS, replacing the rewrite in
`vercel.json`. Sessions use secure cookies, so HTTPS is required. Keep the
existing domain, including whichever of the apex and `www` names customers
use; the examples below cover both `dltservices.tech` and
`www.dltservices.tech`.

## Confirm the backend before cutover

On 25 November 2026 the repository's Railway hostname returned HTTP 404
`Application not found`, and the current DLT domain returned Vercel HTTP 402
`DEPLOYMENT_DISABLED`. These responses do not prove that database records
have been lost. Before DNS cutover, open the existing Railway project and
confirm its service, database/volume and environment variables still exist.
Restore service availability or obtain its current public URL. Do not create
a replacement database or seed a fresh one to work around the hostname error.
Verify existing records through the running application before switching DNS.

The packager defaults to the URL in `vercel.json`. If that service now uses
a different address, add `--api-origin https://CURRENT-SERVICE.up.railway.app`
to the packaging command. Use the API service backed by the existing data.

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
node deploy/frontend/prepare.mjs --domain dltservices.tech --alias www.dltservices.tech --out /tmp/dlt-$RELEASE_ID
sudo install -d -m 755 /var/www/dlt/releases /var/www/letsencrypt
sudo cp -a /tmp/dlt-$RELEASE_ID/public /var/www/dlt/releases/$RELEASE_ID
sudo chown -R root:root /var/www/dlt/releases/$RELEASE_ID
sudo chmod -R a+rX /var/www/dlt/releases/$RELEASE_ID
sudo ln -s /var/www/dlt/releases/$RELEASE_ID /var/www/dlt/current-next
sudo mv -Tf /var/www/dlt/current-next /var/www/dlt/current
```

The output directory must be new; the packager refuses to overwrite an
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

Existing data stays intact because every request reaches the **same running
Railway service and database**; this package does not copy or recreate data.
Keep the current Razorpay webhook URL and Railway environment unchanged.
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
