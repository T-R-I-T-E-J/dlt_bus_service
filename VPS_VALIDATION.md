# DLT VPS preparation: validation

Verified locally on 25 November 2026. These are preparation results, not a
claim that the user's VPS has been deployed or capacity-tested.

## Boarding and login

- Reproduced four scanner regressions before fixing them: unsupported native
  QR constructor, swallowed native decode errors, overlapping scan submissions,
  and stale staff assignments. Regression tests now pass.
- A Chromium camera test used video of a downloaded ticket, deliberately
  failed the native QR constructor, and decoded through jsQR. It submitted
  the exact token once and showed no page errors. A physical phone still
  needs testing on the VPS over HTTPS.
- Existing boarding sessions now redirect from Account to staff controls.
  Rapid login/checkout clicks are guarded until the pending action completes.
- The Account email-verification form was exercised in a real browser with
  mocked email/API delivery. Actual provider delivery remains a VPS check.

## Offline ticket and fare

- Chromium downloaded a PNG after browser networking was switched off.
- The saved image retained the existing 760×1120 ticket layout. jsQR decoded
  the QR from the PNG back to the exact original token.
- Advertised prices, structured metadata, new-trip defaults and the sample
  ticket use ₹320. Actual checkout remains server-priced; historical bookings
  and payment values are unchanged.
- Downloaded tickets do not bypass the server's trip, payment, cancellation,
  refund, or already-boarded validation. The scanner needs connectivity.

## Concurrent API requests

The guarded load script runs only against a disposable local test database.
It uses real Express routing, PostgreSQL locks, Argon2 authentication,
session cookies and idempotency. Payments are synthetic local fixtures;
there are no real provider calls.

| Scenario | Result | Local p95 |
|---|---|---:|
| 100 concurrent seat-map reads | 100 successful responses | 81 ms |
| 200 concurrent seat-map reads | 200 successful responses | 98 ms |
| 200 clients contend for one seat | 1 success, 199 conflicts | 173 ms |
| 200 duplicate booking requests | Same booking returned 200 times; one DB booking | 278 ms |
| 200 legitimate logins from one campus IP | 200 successful responses | 948 ms |
| 100 simultaneous scans of one pass | 1 VALID, 99 ALREADY BOARDED | 199 ms |

All 1,000 measured requests completed without 5xx responses. The initial
campus login test admitted only 20 requests and throttled 180; the VPS setup
now configures a 240/minute shared-IP transport budget. Database failure
lockouts remain unchanged. Other deployments keep the original default of 20.

These timings came from the local test environment, not the Ubuntu VPS.
They do not establish the VPS's maximum capacity, sustained throughput,
external-provider latency or behavior while sharing resources with another app.

## Fresh database and deployment

- The production-mode Node 24 image and PostgreSQL 17 Compose services built
  and started successfully. All 26 migrations applied to a fresh database.
- API readiness passed using `dlt_app`, with append-only audit privileges.
  No accounts were seeded by initialization/migrations.
- Initial admin bootstrap rejected unverified and repeated attempts. The
  successful first-admin and boarding-role setup operations were audited.
- Custom-format backup/restore preserved migrations, test identities,
  audit records and runtime grants. Audit modification was refused.
- The generated Nginx HTTPS config successfully proxied readiness to the
  production-mode API container through loopback.
- Typecheck and all 391 existing backend tests passed after dependency
  updates. All 22 frontend tests passed. The dependency audit reported zero
  vulnerabilities; this is not an exhaustive security assessment.

## Remaining server checks

Check available RAM/CPU/disk, Compose version, certificate paths, real phone
camera behavior, email delivery, Razorpay test-mode checkout/webhook/refund
flows, scheduled off-server backups and a disposable load run on the actual
VPS. Keep the main domain's DNS unchanged until the preview passes.
