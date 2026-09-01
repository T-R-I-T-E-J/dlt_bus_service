# DLT — BACKEND VERIFICATION REPORT

**Date:** 1 September 2026
**Stage:** verification / integration. No new feature phase was started.
**Scope:** repository-wide consistency audit of `backend/`, plus the missing
plumbing required to run it on a real machine.

---

## THE ONE SENTENCE THAT GOVERNS THIS REPORT

**Nothing in `backend/` has ever been executed.** This environment has no
PostgreSQL, no Node runtime, no package installer and no network egress. Every
"WRITTEN" below means source exists and has been read; it does not mean it
compiles, and it certainly does not mean it works. No item in this report is
labelled VERIFIED, because nothing has run.

---

## 1. Architecture status

| Layer | Status |
|---|---|
| Migrations 001–008 | **WRITTEN** — 26 tables, 6 views, 20 enum/composite types, 33 functions |
| Domain (`src/domain/`) | **WRITTEN** — 9 modules; every business rule lives here |
| HTTP (`src/http/`) | **WRITTEN** — 5 route modules, ~70 endpoints, no business rules |
| Integrations | **WRITTEN** — `razorpay/`, `email/` |
| Runtime plumbing | **WRITTEN THIS TURN** — see §4; it did not exist |
| Test suites | **WRITTEN** — 5 files, ~220 assertions. **0 executed.** |

The layering holds: I grepped for provider names and raw payload access in
`domain/` and found none, and for business rules in `http/` and found none.

---

## 2. Migration status — **WRITTEN, NOT APPLIED**

I traced every SQL object's definition point against every reference point
across all eight files, in concatenation order.

| Check | Result |
|---|---|
| Functions referenced before creation | **none** — all 33 define before use |
| Functions called but never defined | **none** |
| Tables/views/types referenced before creation | **none** |
| Forward-only, no down-migrations | confirmed |
| `schema_migrations` recorded by every file | confirmed, 8/8 |
| Each file is one transaction | confirmed — a failure leaves the previous migration intact |

Two ordering bugs were found **and fixed during the writing of 007**, before this
audit: `log_boarding` was called by `board_by_pass` before being declared, and
the `seat_row_order` generated column was added after the function that reads it.
Both are now hoisted.

**Not proven:** that the files actually apply. Order-of-definition is a static
property I can check by reading; syntax validity, type coercions, trigger
compilation and constraint satisfaction are not. `npm run migrate --dry-run`
lists them; only `npm run migrate` against real Postgres proves them.

---

## 3. Database consistency findings

| # | Finding | Severity | Status |
|---|---|---|---|
| D-1 | `allocate_seat_to_booking` tests `s.hold_by IS NOT DISTINCT FROM b.user_id`. For a **guest** hold both sides are NULL, so the comparison passes — any guest-held seat could be allocated to any guest booking. **Latent:** `settle_booking` does its own seat check and is the only live caller; the function is otherwise reached only from tests. | **P1** | FOUND, NOT FIXED |
| D-2 | `idempotency_keys.request_hash` is `JSON.stringify(req).length + ':' + endpoint`. Two different requests of equal serialised length collide, and the second silently receives the first's response. | **P1** | FOUND, NOT FIXED |
| D-3 | `audit_logs` has DELETE/UPDATE revoked from PUBLIC — but a revoke does not bind the table **owner**. If the app connects as owner, it can prune the log. | **P1** | documented as a deployment grant requirement |
| D-4 | `bookings.hold_expires_at` is set on both the booking and its seats by `create_booking_from_holds`. Two clocks for one fact; they cannot currently drift, but nothing enforces that. | P3 | FOUND, NOT FIXED |

---

## 4. Compilation / type-check status — **BLOCKED**

`npm run typecheck` has **not been run.** But the import graph is checkable
statically, and it found the headline problem:

### Four modules were imported and did not exist

| Missing module | Imported by |
|---|---|
| `src/db/index.ts` | `admin.ts`, `audit.ts`, `auth.ts`, `boarding.ts`, `payments.ts`, `seats.ts`, `auth.test.ts` |
| `src/integrations/email/index.ts` | `auth.ts`, `auth.test.ts` |

`domain/audit.ts` was **also missing entirely** while being imported by five
modules — the audit log existed only as call sites.

**The backend could not have compiled or started.** Written this turn, with no
business behaviour added:

- `src/db/index.ts` — pool, `query`, `tx`, and an `assertReady()` that refuses to
  boot against an unmigrated or pre-15 database.
- `src/integrations/email/index.ts` — transport interface, `outbox` test
  transport, HTTP provider adapter, and an **unconfigured transport that throws
  loudly**. A silent no-op would mean students unable to verify or reset with
  nothing in the logs.
- `src/app.ts` — **route registration did not exist.** Five route modules, none
  mounted. Critically, the webhook is mounted **before** `express.json()`, or
  every Razorpay signature would fail against a consumed raw body.
- `src/types/express.d.ts` — `req.session` augmentation. Without it every route
  file errors on every `req.session` read.
- `package.json`, `tsconfig.json` — pinned to `--experimental-strip-types`, so
  `erasableSyntaxOnly` is set: no enums, namespaces or decorators.
- `scripts/migrate.mjs` — runner that refuses a rebased history (a pending
  migration sorting before an applied one).
- `scripts/seed-dev.mjs` — demo data that **refuses to run** unless the database
  name ends `_dev`/`_test` and `NODE_ENV` is not production. Seeds no
  credentials at all.

**Expect real type errors on first run.** Likely candidates: `pg` row types are
`any`, so mismatches are invisible to my reading; `zod` `.nullish()` unions
against parameter types; the `scan_verdict` composite mapping.

---

## 5. Test status

| | Count |
|---|---|
| **TESTS WRITTEN** | ~220 assertions across 5 files |
| **TESTS EXECUTED** | **0** |
| **TESTS NOT EXECUTED** | **all of them** |

    cd backend
    createdb dlt_test
    export DATABASE_URL=postgres://localhost/dlt_test
    export NODE_ENV=test
    npm ci
    npm run verify          # typecheck, then migrate, then the full suite

`npm run verify` is the single documented command.

Breakdown: `seats.concurrency.test.ts` 33 · `payments.test.ts` 43 ·
`boarding.test.ts` 44 · `admin.test.ts` 66 · `auth.test.ts` 33 ·
`test/001_schema.test.sql` 30 (psql) · `test/concurrency.md` 5 manual two-session
procedures.

Only `payments.test.ts` carries the provider-simulated caveat. The rest test our
own rules and real row locks, so once run they are genuine verification.

---

## 6. Integration findings — modules written separately, never proven together

This is where the real risk sits, and I want to be direct: the six areas were
each written in isolation and **no request has ever traversed more than one of
them.**

| Seam | Status | Concern |
|---|---|---|
| DB ↔ all domain | **now connected** (§4) | was entirely absent |
| Auth ↔ HTTP | WRITTEN | `attachSession` runs before routes in `app.ts`; unproven |
| Auth ↔ Seats (guest adoption) | WRITTEN | `signIn` adopts `hold_guest_token`; the cookie is set by `trips.routes.ts`. **Two files must agree on one cookie name** — they do, via the exported `GUEST_COOKIE`, but no test crosses this seam |
| Seats ↔ Bookings | WRITTEN | `create_booking_from_holds` consumes what `hold_seat` produced; covered by tests, unexecuted |
| Bookings ↔ Razorpay | WRITTEN | rupees→paise at one boundary; **only the fake adapter has ever been called** |
| Payments ↔ Boarding | WRITTEN | the chain's payment check reads `payments.status`; consistent by inspection |
| Admin ↔ Payments | WRITTEN | override and manual bookings **re-exported, not duplicated** — verified by grep |
| Jobs ↔ domain | **WRITTEN THIS TURN** | `sweepExpiredHolds`, `processPendingEvents`, `dispatchPendingRefunds` had **no scheduler at all** until `app.ts`. Holds would never have expired and refunds would never have dispatched |

**Unproven interface, flagged:** `boarding.ts` reads `bp.seat_row_order`
(migration 007) and `payments.ts` reads `booking_money` (005). Both exist, but a
column rename in either would fail only at runtime — there is no compile-time
link between SQL and TypeScript anywhere in this codebase. That is inherent to
the no-ORM decision and is the price paid for the explicit constraints.

---

## 7. Security findings

### Found and FIXED this turn (both critical, both mine)

| # | Finding |
|---|---|
| **S-1** | **IDOR — any authenticated user could read any booking.** `GET /bookings/:id` compared `b.userId` against the session, but `BOOKING_SQL` never selected `user_id`. The comparison was `undefined !== id` → always false → the ownership branch never ran. Fixed: `BOOKING_SQL` now selects it, and the route calls a new `bookingForActor()` that enforces ownership-or-`booking.read` **in the domain**, so no route can forget it. |
| **S-2** | **IDOR — any authenticated student could cancel any booking and trigger its refund.** `cancelBooking(bookingId, actorId)` used `actorId` only to choose the status label. `acceptReprice` had the same gap. Fixed: new `assertBookingActor()` requires ownership, or `booking.cancel` for an operator acting on a student's behalf. |

I fixed exactly these two and nothing else. They were indefensible to leave in
the tree between turns.

### Found, NOT fixed — awaiting your review

| # | Finding | Severity |
|---|---|---|
| S-3 | `GET /bookings/:id/cancellation-quote` still has no ownership check. It leaks amounts paid and refundable for an arbitrary booking id. | **P1** |
| S-4 | Guest holds have no rate limit. A script can hold 4 seats per fresh cookie indefinitely and starve a trip. Cookies are free. | **P1** |
| S-5 | D-1 above: guest-hold seat theft via `allocate_seat_to_booking`. | **P1** |
| S-6 | D-2 above: idempotency-key collision could return another request's response body. | **P1** |
| S-7 | No CORS configuration. Cookies are `SameSite=Lax`, which blunts CSRF, but the API needs an explicit allowed origin with credentials — never `*`. | **P1** |
| S-8 | No CSRF token on state-changing routes. `SameSite=Lax` covers cross-site POSTs from forms; it does not cover a same-site XSS. | P2 |
| S-9 | `audit_logs` owner-privilege gap (D-3). | **P1** |

### Verified clean by inspection (not by execution)

- **No secret reaches a client.** Only `RAZORPAY_KEY_ID` is sent; key secret,
  webhook secret, DB URL and email key are read from `process.env` inside
  server-only modules. Grepped.
- **No localStorage authority.** Sessions are `HttpOnly` cookies; the token is
  never in a response body.
- **Forged roles are inert.** `actorOf()` builds the actor from `req.session`
  only; `req.body` is never consulted for identity. Admin tests assert a forged
  role argument changes nothing.
- **Every `/admin` route carries `requirePermission`.** I checked all 24.
- **Webhook handling:** signature verified over raw bytes before any parse;
  unsigned or event-id-less deliveries refused; bad signatures recorded with
  `signature_ok = false` and never processed.
- **Replay:** `UNIQUE (provider, provider_event_id)`. Razorpay has no timestamp
  in its signature, so this index is the *entire* defence — correctly, no fake
  staleness check was added.
- **Duplicate payment:** a second success becomes `DUPLICATE` and is refunded;
  `payments_one_success_per_booking` enforces it.
- **Refunds:** capped by `booking_money.refundable` and the
  `refunds_within_receipts` trigger; `CHECK (amount > 0)`.
- **Session invalidation:** password change/reset, role change, and staff
  reassignment all revoke sessions.

---

## 8. Razorpay verification status — **BLOCKED**

**Not production-ready, and no claim is made otherwise.** Every item below
requires a real Razorpay Test account:

order creation · checkout `order_id` flow · payment verification · **webhook
signature** · duplicate webhook · **capture behaviour** · refund creation ·
refund webhook · failure/retry.

The signature scheme is implemented from Razorpay's current published
documentation, not from memory — but the tests sign with that same assumed
scheme, so **if the assumption is wrong they all pass and production fails.**
Two acceptance criteria: one real webhook verifies; one tampered webhook is
rejected.

**Automatic capture remains a deployment prerequisite** (PRODUCTION_BACKEND.md
§2.2b). Under manual capture every online booking silently fails — safely, but
totally. Not changed, not hidden.

---

## 9. Email status — **BLOCKED**

Boundary written; no provider bound. `EMAIL_API_URL`, `EMAIL_API_KEY`,
`EMAIL_FROM`, `EMAIL_FROM_NAME`. Without them the transport **throws** rather
than pretending. Consequence today: **no student can verify an address or reset a
password.** Templates: `verify-email`, `password-reset`, and three
transactional ones not yet called.

---

## 10. Remaining infrastructure requirements

| Needed | For | Status |
|---|---|---|
| PostgreSQL 15+ | everything | **BLOCKED — the single gating dependency** |
| Node 22.6+ | `--experimental-strip-types` | BLOCKED |
| Transactional email provider | verification, reset | BLOCKED |
| Razorpay Test credentials | payments | BLOCKED |
| Public HTTPS webhook endpoint | signature work (Razorpay blacklists ngrok/webhook.site; their docs suggest zrok) | BLOCKED |
| TLS everywhere | `Secure` cookies | BLOCKED |
| DB role granted only SELECT/INSERT on `audit_logs` | S-9 | deployment task |
| Boarding device + connectivity decision | §2.6 policy | open |

---

## 11. Critical blockers

1. **No PostgreSQL.** Everything else is downstream. ~220 assertions cannot run.
2. **First compile has never happened.** Expect type errors, especially around
   untyped `pg` rows.
3. **Razorpay entirely unproven.** Including the signature scheme.
4. **Email unconfigured** → account verification and password reset are dead.
5. **Six areas never proven together.** Every seam in §6 is inspection-only.

---

## 12. Recommended order for fixing

1. **Stand up Postgres and run `npm run migrate`.** Everything is blocked on
   this. Expect SQL errors on first application; they will be shallow.
2. **`npm run typecheck`.** Fix mechanically until clean. Do not proceed on a
   red typecheck.
3. **Run the suite.** ~220 assertions. This converts a large amount of WRITTEN
   into EXECUTED in one step and is the highest-value hour in the project.
4. **Close S-3 through S-7** — small, contained, and each has an obvious test.
5. **Bind email**, then prove signup → verify → reset end to end. The first
   genuine cross-module journey.
6. **Razorpay Test mode:** order → checkout → webhook verifies → tampered
   webhook rejected → refund → `refund.processed`. **Confirm the capture
   setting first.**
7. **Two-session concurrency procedures** in `test/concurrency.md` by hand —
   confirm the loser *blocks*, which no automated test can assert as reliably.
8. **Grant `audit_logs` correctly** (S-9) and re-run its permission test as a
   non-owner role.
9. Only then: the frontend migration.

---

## Label summary

| Label | Items |
|---|---|
| **VERIFIED** | **none. Nothing has been executed.** |
| **EXECUTED** | none |
| **WRITTEN** | migrations 001–008, 9 domain modules, 5 route modules, 2 integrations, runtime plumbing, ~220 assertions |
| **BLOCKED** | Postgres, Node, typecheck, all tests, Razorpay, email, HTTPS, boarding hardware |
| **FIXED THIS TURN** | S-1, S-2 (both critical IDORs) |
| **FOUND, NOT FIXED** | D-1, D-2, D-4, S-3–S-9 |
