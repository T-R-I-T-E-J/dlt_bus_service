# DLT VPS validation

Verified locally and on the HTTPS VPS preview on 25 November 2026. Local
fixture results and live VPS measurements are distinguished below.

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
  updates. All 25 frontend tests passed, including the subsequent session
  expiry regressions. The dependency audit reported zero
  vulnerabilities; this is not an exhaustive security assessment.

## Live VPS preview checks

Preview: `https://dlt-187-127-177-22.sslip.io`, deployed revision `3eab74b`.

- TLS and API readiness passed: PostgreSQL 17, all 26 migrations and
  append-only audit permissions. Public trip fare is ₹320 with 44 seats;
  the operator confirmed the physical bus has 44 passenger seats.
- Booking, Account, My Trips, Admin and the coach asset returned HTTP 200.
  Anonymous admin/boarding API access returned 401. Backend environment,
  Git metadata, deployment configuration and deployment documentation paths
  returned 404.
- Short read bursts mixed the public trip list and seat-map endpoints:

| Live scenario | Result | VPS p95 |
|---|---|---:|
| 100 simultaneous read requests | 100 HTTP 200 | 433 ms |
| 200 simultaneous read requests | 200 HTTP 200 | 489 ms |

- Two isolated guest clients simultaneously requested available seat 11D.
  One received HTTP 200 and the other HTTP 409 CONFLICT. The winning client's
  test hold was released, and the seat was verified AVAILABLE afterward.
  No bookings, payments, refunds or existing account data were changed.
- The admin browser retained its old Super Admin label after a protected
  call returned UNAUTHENTICATED. Reloading showed the session was absent.
  The follow-up frontend fix clears cached identity and permissions before
  notifying the screen, stops the camera and polling, and shows sign-in.
  Invalid credentials remain distinct from an expired session. All three
  new regression tests pass. Frontend revision `073e3a6` was subsequently
  activated and its public files were checked for the fix.
- A fresh Super Admin sign-in opened the operations console. Trips, Vehicles,
  Bookings, Payments and Audit loaded without browser console errors. Boarding
  showed its trip selector, camera control, manual validation and manifest.
  One deliberately invalid code was rejected and recorded as INVALID; no
  passenger was boarded. There are no boarding-staff accounts/assignments yet.

These short read bursts do not establish sustained capacity or 200 concurrent
payments. The high-contention booking/login/scan results above used local
fixtures, not the live database. Valid-pass scanning with an assigned staff
account remains unverified on the VPS.

## Payment follow-up

- The live payment-create and checkout-handback endpoints returned 401 for
  anonymous requests. Unsigned webhook requests retain the existing HTTP 200
  acknowledgement; that response alone does not establish that an event was
  accepted. Local integration tests assert that bad signatures write no event.
- Razorpay's existing dashboard was checked in Test Mode. The correct VPS
  webhook URL is enabled, with 57 event subscriptions. There were no delivery
  logs in the selected past-three-hours range and no live DLT payment records.
- Found and fixed a reliability defect: storage errors for valid webhooks
  were caught with signature errors and acknowledged as success. A valid
  event that cannot be saved now returns 503, allowing provider retries.
  Invalid signatures retain their existing refusal path.
- The new regression injects a PostgreSQL insert failure, verifies HTTP 503
  and no event row, removes the failure, then delivers the same signed event
  twice. Both retries return 200 and exactly one event exists. This test runs
  only in the disposable local database. API image rebuild/activation is
  required to deploy this fix; no schema migration is needed.
- After this fix, typecheck and all 392 backend tests passed against a
  disposable PostgreSQL database. All 25 frontend tests also passed.
- Successful/failed payment settlement, tampered signatures, duplicate events,
  late settlement, partial allocation and refund behavior are covered by the
  local provider-simulated suite. A real Razorpay test checkout and webhook
  delivery have not yet been verified against this VPS.

## Remaining server checks

Deploy the webhook storage fix, then verify assigned staff boarding and
real phone camera behavior. Verify Razorpay test-mode checkout, webhook
delivery and refund behavior, scheduled off-server backups and a disposable
transactional load run on the VPS. Resend's temporary onboarding sender is
restricted to the account owner's email until the sending domain is verified.
Rotate provider credentials exposed in screenshots before public use.
Automatic ticket email was deferred; PNG ticket download is implemented.
Keep the main domain's DNS unchanged until the preview passes.
