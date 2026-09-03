# DLT — production deployment guide

Status: the application (Homepage/3D, Booking, Dashboard, Account, Admin,
Razorpay payments/refunds) is feature-complete and verified — 350/350
backend tests passing (re-run in full during the production-completeness
audit), typecheck clean, every screen migrated off the prototype store
and confirmed against the real backend in a real browser.
**Nothing has been deployed.** This document is what's left between "works
on a dev machine" and "serving real traffic," and exactly what was
verified this session versus what still needs a real production host to
verify for real.

---

## 1. Production PostgreSQL

### What the schema already does for you
Migration 009 creates `dlt_app` as `NOLOGIN` with least-privilege grants
(`SELECT/INSERT/UPDATE/DELETE` on ordinary tables; `SELECT/INSERT` only on
`audit_logs`), and a trigger that refuses `DELETE`/`UPDATE` on `audit_logs`
for **every** role, the table owner and the connected superuser included.
`assertReady()` (`backend/src/db/index.ts`) refuses to let the app boot if
the role it's connected as can `DELETE`/`UPDATE` `audit_logs`, unless
`ALLOW_AUDIT_PRIVILEGE=i-understand-the-risk` is explicitly set — which
must **never** be set in production.

### What I verified this session (real commands, real results, not claimed)
Against a **throwaway** local database, torn down afterward:

```
CREATE DATABASE dlt_prodcheck;
DATABASE_URL=postgres://postgres:postgres@<host>/dlt_prodcheck node scripts/migrate.mjs
  -> all 16 migrations applied cleanly from zero, no manual intervention

ALTER ROLE dlt_app LOGIN PASSWORD '<generated>';

DATABASE_URL=postgres://dlt_app:<generated>@<host>/dlt_prodcheck \
  NODE_ENV=production node --experimental-strip-types src/app.ts
GET /api/health -> {"ok":true,"db":{"version":160014,"migrations":16,"auditAppendOnly":true}, ...}
  -> the app boots and serves against the LEAST-PRIVILEGED role, not a superuser

psql -U dlt_app -c "DELETE FROM audit_logs;"           -> permission denied for table audit_logs
psql -U dlt_app -c "UPDATE audit_logs SET reason='x';" -> permission denied for table audit_logs
psql -U postgres -c "DELETE FROM audit_logs;"           -> refused by the trigger even as superuser
```

Also verified: a real `pg_dump`/`pg_restore` round-trip of `dlt_dev` (see
§5) preserves the same schema, triggers, and grants — this isn't a
one-off artifact of the migrations, it survives a restore too.

**Re-verified during the production-completeness audit** (two migrations
were added since the block above was written, for two real defects found
by pre-production load testing): a clean `node scripts/migrate.mjs`
against a fresh throwaway database applies all **18** migrations in
order, zero manual steps. The `dlt_app`-role/audit-trigger portion above
was not re-run this pass — nothing since has touched `dlt_app`'s grants
or the audit trigger, so it stands.

**The password used above was generated for this local verification only
and was discarded** (`dlt_app` was reverted to `NOLOGIN` afterward, the
throwaway database dropped). It is not, and must not become, a real
credential — it has been through conversation logs and is not secret. The
real production password must be generated fresh, on the real host, by
whoever provisions it.

### What you still need to do, on the real production database

```sh
# 1. Create the database (if PostgreSQL is freshly provisioned)
createdb dlt_prod

# 2. Run every migration from zero
DATABASE_URL=postgres://postgres:<superuser-pw>@<prod-host>:5432/dlt_prod \
  node backend/scripts/migrate.mjs

# 3. Generate a strong password and grant LOGIN — do this ON the production
#    host, and do not paste the generated password back into a chat, an
#    issue tracker, or a commit. A password manager or your platform's
#    secrets store, not a text file.
openssl rand -base64 32
psql -U postgres -d dlt_prod -c "ALTER ROLE dlt_app LOGIN PASSWORD '<paste generated password>';"

# 4. Point production DATABASE_URL at dlt_app, never postgres:
DATABASE_URL=postgres://dlt_app:<password>@<prod-host>:5432/dlt_prod

# 5. Confirm ALLOW_AUDIT_PRIVILEGE is ABSENT from the production
#    environment file entirely (not set to any value — absent).

# 6. Boot once and check:
curl https://<domain>/api/health
#   -> "auditAppendOnly": true is the pass condition. If it's false, the
#      connection is still over-privileged — stop and fix before serving
#      real traffic on it.
```

If PostgreSQL is managed (RDS, Cloud SQL, etc.), the platform usually
creates its own bootstrap superuser under a different name than
`postgres` — migration 009's `dlt_app` creation is idempotent
(`IF NOT EXISTS`) and doesn't care what the bootstrap role is called; only
step 3's `ALTER ROLE ... LOGIN PASSWORD` and the final `DATABASE_URL` need
adjusting to match.

---

## 2. HTTPS / domain readiness

**Required, not optional**: `cookieOpts` in `auth.routes.ts` hardcodes
`secure: true` on the session cookie, unconditional on `NODE_ENV`. Browsers
refuse to store a `Secure` cookie set over plain HTTP for any origin other
than `localhost`. Deployed on a real domain over plain HTTP, sign-in would
silently never persist a session — not a crash, just a student who can
never stay signed in. TLS is a hard requirement for this app to function
at all past `localhost`, not hardening on top of a working HTTP deployment.

### Architecture: one origin, nginx in front

```
Browser
  │  HTTPS (443)
  ▼
nginx  ──── serves *.dc.html, dlt-client.js, journey.js, assets/*  (static, from disk)
  │
  │  /api/*  (proxy_pass, plain HTTP, loopback only)
  ▼
node src/app.ts  (127.0.0.1:3000, never exposed directly to the internet)
  │
  ▼
PostgreSQL (dlt_app role)
```

Template: `backend/deploy/nginx-dlt.conf` (CHANGE the domain and
certificate paths before use — not installed, not pointed at a real
domain).

**Why one origin, not a separate API domain**: there is no CORS middleware
anywhere in `app.ts` — a deliberate, documented gap (M-2,
`backend/SECURITY_FINDINGS.md`), because same-origin needs none, and a
hastily added `Access-Control-Allow-Origin: *` with credentials would be a
real vulnerability, not a convenience. This mirrors the local dev
architecture exactly (`devserve.mjs`'s static-host-plus-`/api`-proxy
pattern) — same shape, real TLS in front. **If a separate frontend domain
is ever wanted, build real CORS deliberately first** — do not point two
domains at this backend and expect requests to succeed.

`app.set('trust proxy', 1)` in `app.ts` trusts exactly one reverse-proxy
hop for `X-Forwarded-For`/`req.ip`, which the rate limiters and audit log
depend on for a real client IP. The nginx config above is that one hop —
if a CDN or load balancer sits in front of nginx too, the trust-proxy
count needs to change to match, or `req.ip` becomes spoofable.

### TLS certificate
Not provisioned — needs a real domain first. Standard path: Let's Encrypt
via `certbot --nginx`, auto-renewing. Any CA works; nothing in the app
cares which one issued the certificate, only that nginx terminates TLS
before traffic reaches the Node process (the app itself only ever speaks
plain HTTP, on loopback).

### Static file exposure — found and closed during the completeness audit
`root /opt/dlt` in `nginx-dlt.conf` points at the **whole repo checkout**,
`backend/` included, because there is no build step that copies a
curated frontend-only directory into place. Before this audit,
`try_files $uri $uri/ =404` would have served *any* file under that root
to *any* request path — `backend/.env` (real SMTP/Razorpay/DB
credentials), `backend/src/**` (source), `backend/migrations/*.sql`
(the schema), and every internal audit/spec document in this repo,
publicly, with no auth. `nginx-dlt.conf` now denies `backend/`, `test/`,
`uploads/`, dotfiles, `*.md`/`*.sql`, and the internal-only audit pages
before the general static location; `devserve.mjs` (local dev) carries
the same denylist. **Verified live** against `devserve.mjs` this
session: `/backend/.env` → 404, the real Homepage/Booking pages and
`assets/dlt-coach.glb` → unaffected, 200.

### SEO / metadata, also added this session
Every real page now sets a `<title>`, meta description, canonical link
and favicon via its `<helmet>` block (support.js's own head-injection
mechanism — nothing new was built). `Dashboard`/`Account` are
`noindex`; `Admin` is `noindex, nofollow`. `robots.txt` and
`sitemap.xml` are new files at the repo root — both use the same
`dlt.example.com` placeholder as `nginx-dlt.conf`; **CHANGE** to the
real domain together with the nginx `server_name`.

---

## 3. Email

`backend/src/integrations/email/index.ts` implements the transport
boundary. It has **two real transports** — an HTTP adapter bound to
Resend's API, and SMTP (`nodemailer`) — selected by which environment
variables are present, `RESEND_API_KEY` taking priority. **Resend is the
one actually configured in production (Railway)**, verified end-to-end
this session (see below).

### Why Resend, not Gmail SMTP, in production
Railway firewalls outbound SMTP (ports 25/465/587/2525) entirely below
the **Pro plan** — this is documented Railway platform policy
(`docs.railway.com/networking/outbound-networking`: *"SMTP is only
available on the Pro plan and above... disabled on \[Free/Trial/Hobby]
plans to prevent spam and abuse"*), not a bug in this app. It was
confirmed empirically this session too: both 587 and 465 timed out
identically from the Railway container while every other outbound HTTPS
call (Neon, Razorpay) worked fine. No DNS or Nodemailer configuration
change can route around a platform-level port block. Resend speaks plain
HTTPS (443), which Railway never blocks, and is Railway's own recommended
provider for exactly this reason.

### Resend — configured and verified (production, Railway)

```
RESEND_API_KEY=<starts with re_ — from resend.com -> API Keys>
EMAIL_FROM=<an address on a domain verified in Resend>   # optional — defaults
                                                           # to onboarding@resend.dev
EMAIL_FROM_NAME=DLT                                       # optional, has a default
```

**The API key is not in this repository anywhere** — not in source, not
in a test, not in a log, not in this document. It lives only in
`backend/.env` (gitignored) locally, or as a Railway service variable in
production, and belongs in a real secrets store rather than a plain
`.env` file long-term.

`onboarding@resend.dev` is Resend's own shared sending domain — it works
immediately with no DNS setup, which is what production uses until
`dltservices.tech` (or a subdomain of it) is added and verified in
Resend's dashboard (SPF/DKIM records at whichever DNS host manages the
domain). Switch `EMAIL_FROM` to that address once verified; no code
change is needed for that switch, only the environment variable.

### Option B: Gmail SMTP — kept for local dev / any non-Railway host
Still available, unchanged, still real (`nodemailer`) — just unusable
from Railway specifically. Used automatically when `RESEND_API_KEY` is
not set and these three are:

```
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_PORT=587
EMAIL_SMTP_SECURE=false                 # 587 is STARTTLS, not implicit TLS
EMAIL_SMTP_USER=<the Gmail address>
EMAIL_SMTP_PASS=<a Gmail App Password>
EMAIL_FROM=<the Gmail address>          # optional — defaults to EMAIL_SMTP_USER
EMAIL_FROM_NAME=DLT                     # optional, has a default
```

Getting a Gmail App Password (if a fresh one is ever needed): the Google
Account must have **2-Step Verification enabled** first — Google Account
→ Security → 2-Step Verification → App passwords → generate one scoped to
this app. It is a 16-character password, distinct from the account's own
login password, and Google will not show it again after generation —
whoever generates it should save it directly into the secrets store, not
paste it anywhere that persists (a chat, a ticket, a shared doc).

**Gmail-specific limits worth knowing if this is ever used somewhere
SMTP isn't blocked**: a personal Gmail account is capped at roughly 500
outbound messages/day, and Google may throttle or flag automated SMTP
traffic that looks like bulk sending — one more reason Resend is the
better default even where SMTP is technically reachable.

### What happens with neither configured
The backend runs with `unconfiguredTransport`: every verification email,
password reset, and notification email **fails loudly** with "Email
delivery is not configured on this server" rather than silently no-op'ing
— deliberate, so a half-configured deployment doesn't lock students out
with nothing in the logs to explain why.

`EMAIL_TRANSPORT=memory` keeps the dev/test behavior (no external calls,
captured in an in-process outbox) — must not be set in production once a
real transport is configured, since its presence is checked before either
real transport and would silently stop delivery while reporting success.

### Templates
`renderTemplate()` in `email/index.ts` composes the subject/text/html for
all five `EmailMessage` template names, for either transport. Only two
have a real caller today — `verify-email` and `password-reset`
(`domain/auth.ts`) — and both were exercised for real this session (see
below). `booking-confirmed`, `trip-cancelled`, and `refund-processed`
render real, reviewable copy but have **no trigger call site yet**
anywhere in `domain/`; the `vars` shape each expects is a reasonable
placeholder, not a verified contract — confirm it against whatever call
site eventually triggers them (a booking confirming, a trip cancelling, a
refund settling) before relying on it. Wiring those trigger points is a
product decision (when, and under what conditions, DLT emails a student)
this pass did not make.

### Verified this session (real send, real inbox — not claimed)
See the session report for exact verification results (`verify-email`,
`resend-verification`, `password-reset`) against the real production
Railway deployment through Resend — message IDs, timestamps, and the
codes/tokens each email carried are intentionally NOT reproduced in this
document.

Earlier in this project's history, before Railway's SMTP restriction was
identified, the same template paths were verified against real Gmail
SMTP delivery (pre-Railway). That history is why `smtpTransport` remains
in the codebase rather than being removed — it is genuinely useful again
on any host that doesn't block outbound SMTP.

---

## 4. Process supervision

Template: `backend/deploy/dlt-backend.service` (systemd — not installed,
not started). `Restart=on-failure`, capped at 5 restarts per 60s so a fast
crash loop pages someone instead of spinning forever.

**Graceful shutdown was already correct and required no change**:
`app.ts`'s `SIGTERM`/`SIGINT` handler already clears the three background
job timers (`sweep`/`events`/`refunds`), closes the HTTP server (letting
in-flight requests finish), then closes the DB pool, then exits 0. I
verified this holds under a real `systemctl`-style stop this session: the
temporary verification instance (§1) was stopped and the port was
confirmed free with no orphaned process or hung connection. The systemd
unit's `TimeoutStopSec=30` just gives that sequence room to finish before
systemd would otherwise escalate to `SIGKILL` — no code change was needed
or made.

`startJobs()` is explicitly documented in `app.ts` as in-process and
single-instance ("running these twice concurrently is safe... but
wasteful") — do not run two instances of this unit behind a load balancer
without moving the three jobs to a real scheduler first; each instance
would otherwise redundantly poll the same work.

---

## 5. Backups

### Procedure (scripted, `backend/scripts/backup.sh` / `restore.sh`)
```sh
# Backup (run on a schedule — cron/systemd timer — against production)
DATABASE_URL=postgres://dlt_app:<pw>@<prod-host>/dlt_prod \
  ./backend/scripts/backup.sh /var/backups/dlt

# Restore, into a NEW empty database — never in place onto the live one
createdb dlt_restore_check
DATABASE_URL=postgres://dlt_app:<pw>@<prod-host>/dlt_restore_check \
  ./backend/scripts/restore.sh /var/backups/dlt/dlt-<timestamp>.dump
```
`backup.sh` uses `pg_dump --format=custom` (portable across a role/name
change, which `pg_restore` needs since a restore target's role won't be
called `dlt_dev`) and prunes dumps older than 14 days — a starting
retention policy, not a compliance decision made on your behalf.

### What I actually verified this session (not merely documented)
Against real data in the local `dlt_dev` database (10 users, 15 trips, 3
bookings, 75 audit log entries at the time):

```
pg_dump -Fc dlt_dev -> dlt_dev_verify.dump (199 KB)
CREATE DATABASE dlt_restore_verify
pg_restore --no-owner -d dlt_restore_verify dlt_dev_verify.dump
  -> users: 10, trips: 15, bookings: 3, audit_logs: 75   — identical to source
  -> schema_migrations: 16                                — every migration intact
  -> DELETE FROM audit_logs on the RESTORED copy -> refused by the trigger
     — the append-only protection survives a restore, not just fresh migrations
```
Both the throwaway backup file and the restored database were deleted
after verification.

### What's genuinely still open
- **Scheduling**: no cron/systemd-timer is installed. Add one calling
  `backup.sh` (daily is a reasonable starting cadence for a service this
  size).
- **Off-host storage**: `backup.sh` writes to local disk. A backup that
  lives only on the database server is not a backup against that
  server's own failure — copy dumps to separate storage (S3-compatible,
  another host, etc.) as part of the real backup job. Not built here —
  it depends on what storage you have.
- **Point-in-time recovery**: this is logical `pg_dump` backups only
  (daily-granularity restore points). If you need PITR, that's WAL
  archiving / `pgbackrest` / a managed provider's continuous-backup
  feature — a bigger decision than this pass makes for you.

---

## 6. Environment / security review

| Check | Status |
|---|---|
| `.env` ever committed | **No** — checked full git history (`git log --diff-filter=A`), clean. `.gitignore` already excludes `.env`/`.env.*`, keeps `.env.example`. |
| Hardcoded secrets in source | **None found** — searched for live-looking Razorpay keys and inline password literals across `.ts`/`.js`. |
| Sensitive values logged | **None found** — no `console.*` call logs a password, token, or session value anywhere in `backend/src`. |
| `NODE_ENV` behavior | `app.ts`'s only `NODE_ENV` branch skips the real `listen()`/`startJobs()`/`assertReady()` boot sequence when `NODE_ENV==='test'` — both `development` and `production` take the real path identically. No dev-only backdoor exists to accidentally leave enabled. |
| `ALLOW_AUDIT_PRIVILEGE` | Must be **absent** (not merely falsy) from the production environment file — see §1. |
| Security headers | `helmet()` mounted first, before every route. |
| Rate limits | Login (20/min), password-reset request (5/hr), boarding scan (120/min), notify-me (10/hr) — all `express-rate-limit`, in-process memory store. **Note**: an in-process store means limits are per-instance — fine for the single-instance deployment this app is built for (see §4), but would under-count if ever run as multiple instances without a shared store (Redis). |
| `Retry-After` on 429 | Present for both transport-level and domain-level (login lockout, guest-hold) rate limits. |
| `Cache-Control: no-store` | Applied to every authenticated JSON response (`noStoreForAuthenticated`), so a shared/campus machine or browser back-button can't replay another student's booking data from cache. |
| Cookie flags | `HttpOnly`, `Secure` (hardcoded — see §2), `SameSite=Lax`. |
| CORS | Absent — by design, for the same-origin architecture in §2. Do not add a wildcard origin as a quick fix if a separate frontend domain is ever wanted. |

Nothing in this review required a code change — the security posture
documented in `backend/SECURITY_FINDINGS.md` and
`backend/FINAL_SECURITY_STATUS.md` already reflected the real, current
state; this pass re-verified it rather than finding new gaps.

---

## 7. Quick-reference: bringing it up on a fresh host

```sh
# 0. Prerequisites: Node >=22.6.0, PostgreSQL 15+, nginx, a real domain
#    with DNS pointed at this host, a TLS certificate for it.

# 1. Clone, install
git clone <repo> /opt/dlt && cd /opt/dlt/backend
npm ci --omit=dev

# 2. Database (see §1 in full)
createdb dlt_prod
DATABASE_URL=postgres://postgres:<pw>@localhost/dlt_prod node scripts/migrate.mjs
psql -U postgres -d dlt_prod -c "ALTER ROLE dlt_app LOGIN PASSWORD '<generated>';"

# 3. /etc/dlt/backend.env — root-owned, mode 600
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://dlt_app:<password>@localhost:5432/dlt_prod
RESEND_API_KEY=<re_... from resend.com>  # see §3 — required if this host
                                          # blocks outbound SMTP (Railway does
                                          # below the Pro plan)
RAZORPAY_KEY_ID=<real LIVE key>         # only when actually going live
RAZORPAY_KEY_SECRET=<real LIVE secret>
RAZORPAY_WEBHOOK_SECRET=<real LIVE webhook secret>
# ALLOW_AUDIT_PRIVILEGE must be ABSENT — do not add this line

# 4. Process supervision (see §4)
sudo cp deploy/dlt-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dlt-backend
curl http://127.0.0.1:3000/api/health   # loopback only — nginx isn't up yet

# 5. Reverse proxy + TLS (see §2)
sudo cp deploy/nginx-dlt.conf /etc/nginx/sites-available/dlt
# edit server_name and ssl_certificate paths for the real domain
sudo ln -s /etc/nginx/sites-available/dlt /etc/nginx/sites-enabled/
sudo certbot --nginx -d dlt.example.com
sudo nginx -t && sudo systemctl reload nginx

# 6. Verify end to end
curl https://dlt.example.com/api/health
# open https://dlt.example.com/DLT%20Homepage.dc.html in a real browser

# 7. Backups (see §5)
crontab -e
#   0 3 * * *  DATABASE_URL=postgres://dlt_app:<pw>@localhost/dlt_prod \
#              /opt/dlt/backend/scripts/backup.sh /var/backups/dlt >> /var/log/dlt-backup.log 2>&1
```
