# DLT — FINAL SECURITY STATUS

**Date:** 1 September 2026
**Preceded by:** `VERIFICATION_REPORT.md` → `SECURITY_FINDINGS.md` → `SECURITY_REMEDIATION.md`

> ## SOURCE WRITTEN · TESTS WRITTEN · TESTS EXECUTED: 0 · VERIFIED: 0
>
> This environment has no PostgreSQL and no Node runtime. Nothing in `backend/`
> has ever been executed. Every fix and every test below is a **claim**, not a
> result. The single most valuable thing that can happen next is not more code —
> it is `npm run verify` producing output on a real machine.

---

## 1. Previously fixed findings (unchanged, still unexecuted)

| # | Finding | Fix |
|---|---|---|
| S-1 | Any authenticated user could read any booking | `BOOKING_SQL` selects `user_id`; read goes through `bookingFor` |
| S-2 | Any student could cancel any booking and trigger its refund | ownership-or-`booking.cancel`, row-locked |
| C-1 | Unauthenticated handback disclosed the full booking; signature result ignored | session + ownership + signature now **gates**; status-only response |
| C-2 | Any authenticated user could reconcile any payment | actor required; returns a status triple, never a booking |
| H-1 | Unprotected cancellation-quote financial read | actor required **by the signature** |
| H-2 | Unlimited guest holds → trip starvation | per-(IP,trip) budget + 40% per-trip ceiling; guests only; window never extends |
| H-3 | Audit log mutable by the table owner | owner-binding triggers + `dlt_app` least-privilege role |
| H-4 | Idempotency-key collision returned another user's response | SHA-256 canonical digest, compared on replay, bound to caller |
| M-1 | Guest-hold ownership decided by `NULL = NULL` | `bookings.guest_token`; positive match on both sides |
| L-2 | Boarding events not trip-scoped | same scope function as the manifest |
| L-1 | Boarding actions not trip-asserted | optional `tripId` assertion via `passengerFor` |
| — | `providerOrderIdFor()` — took a payment id, checked nothing | removed |

**Structural fix:** `domain/authz.ts`. Eight guards, each answering who/role/
ownership/permission in one place, each **returning the loaded row** — so a
caller cannot skip the check and still reach the object.

**H-4 stays at 409** as instructed. Not changed to 422.

---

## 2. Hardening fixes implemented this turn

### HD-3 · Lazy argon2 initialisation — **DONE (written)**

`DECOY_HASH` was a **top-level `await`** at module scope. Valid ESM, but it made
every import of `domain/auth.ts` wait on an argon2 hash, and an argon2 that
failed to build threw during *import* — a boot failure with no useful stack, on
the module every other module depends on.

Now a memoised `getDecoyHash()`: computed once, on first sign-in, not at import.
The timing-equalisation property is unchanged — a missing account still verifies
against a real hash, so it costs the same as a wrong password.

**Tests:** memoisation asserted (one hash per process); missing-account and
wrong-password asserted to return identical code *and* message. Real timing
analysis needs a benchmark, not a unit test — noted, not claimed.

### HD-6 · `no-store` on authenticated JSON + `Retry-After` on 429 — **DONE (written)**

New `http/security-headers.ts`:

- `noStoreForAuthenticated` wraps `res.json` and sets
  `Cache-Control: no-store, no-cache, must-revalidate, private`, `Pragma`, and
  `Vary: Cookie` — **only when a session is present**, so public trip reads stay
  cacheable. Booking views carry names, student IDs and phones; a shared campus
  machine or an intermediary cache must not retain them. `Vary: Cookie` is
  belt-and-braces so a cache that ignores `no-store` still cannot serve one
  student's response to another.
- `retryAfterHeader` sets `Retry-After` on any `RATE_LIMITED`. The gap was
  specific: `express-rate-limit` sets the header for *transport* limits, but the
  **domain** limits added by the remediation (login lockout, guest holds) did
  not. A 429 with no `Retry-After` makes a client guess, and a guessing client
  retries in a tight loop — indistinguishable from the abuse the limit exists to
  stop. Seconds are parsed from the domain's own "Try again in N minutes"
  message rather than inventing a second source of truth.

**Tests:** `retryAfterSeconds` for 15-minute, 1-minute and no-number cases; the
guest limiter asserted to raise `RATE_LIMITED` so the hook has something to key
on.

### H-3 layer 3 · Startup assertion — **DONE (written)**

`assertReady()` now queries `has_table_privilege(current_user, 'audit_logs', …)`
and **refuses to boot** if the connected role holds DELETE or UPDATE.

This is the layer no migration can provide, because the failure being guarded
against *is* a deployment connecting as the migration owner by mistake. Refusing
to start is deliberate: an audit trail that can be rewritten is worse than an
outage, because every reason-mandatory workflow depends on it.

Also asserts the role *can* INSERT — an over-restricted role would otherwise
fail on the first audited action instead of at boot. Migration count raised to 9.

`ALLOW_AUDIT_PRIVILEGE=i-understand-the-risk` downgrades the refusal to a loud
warning for local development, where the test suite legitimately runs as owner.

**Tests:** without the escape hatch, an owner-privileged role is asserted to be
**refused**; with it, boot succeeds and reports `auditAppendOnly`. Separately,
`dlt_app` is asserted to hold INSERT/SELECT and not DELETE/UPDATE.

---

## 3. Newly discovered finding — introduced by the remediation itself

### N-1 · `actorRole` was an accepted argument — **FOUND AND FIXED**

**This one was mine, created while fixing the others.** To gate `overrideRefund`
and `createManualBooking` in the domain, I added
`role: input.actorRole ?? await roleOf(input.actorId)`.

The fallback was correct and `admin.routes.ts` never passed a role — but **the
parameter existed**. Any future caller, or a route wired by habit from a request
body, could have passed `actorRole: 'SUPER_ADMIN'` and obtained the policy
override and manual bookings. That is precisely the privilege escalation the
whole remediation was about, reintroduced by the fix.

**Fix:** the parameter is gone. The role is *always* read from the database for
the given actor id. There is no argument through which to supply one.

**Tests:** `overrideRefund` and `createManualBooking` called as OPS **with**
`actorRole: 'SUPER_ADMIN'` — both must still be refused; Super Admin still
succeeds through the normal path.

**How it was caught:** a grep for identity read from request-shaped objects
across all domain modules, which returned exactly these two lines. Worth keeping
in the audit routine — the finding was invisible to endpoint enumeration.

---

## 4. Final static audit results

**Endpoint guards — 62 routes.** 47 carry `requireAuth` and/or
`requirePermission`. The 15 without are each intentionally public and were
individually re-confirmed:

| Public route | Why |
|---|---|
| `/auth/signup`, `/login`, `/logout`, `/me`, `/verify-email`, `/forgot-password`, `/reset-password` | pre-authentication by definition; each throttled or self-limiting |
| `GET /trips`, `/trips/:id`, `/trips/:id/seats` | public timetable; seat map never reveals *who* holds a seat, only whether it is yours |
| `POST`/`DELETE /trips/:id/seats/:n/hold`, `DELETE /trips/:id/holds` | anonymous seat selection is documented (PRD §7, UX §4, F-09). `release_seat` frees only a seat the caller actually holds — enforced in SQL, so an unauthenticated caller cannot release a stranger's seat |
| `POST /bookings` | guest checkout; authorization *is* the hold |
| `POST /payments/webhook` | signature-authenticated, no session possible |

**Domain functions taking object ids.** 36 guarded. 14 flagged, of which 13 are
safe by construction and individually documented in `SECURITY_REMEDIATION.md`
(they take a holder rather than an id, filter by the caller's own id, or enforce
ownership in SQL — `claim_waitlist_offer` raises `insufficient_privilege` when
`e.user_id <> p_user_id`). The one genuinely unguarded function was removed.

**authz model coverage.** `payments` uses `bookingFor`/`paymentFor`/
`requireOperator`; `boarding` uses `boardingScopeFor`/`requireTripScope`/
`passengerFor`. `admin` and `seats` use no authz guards — **checked, and correct**:
admin objects (vehicles, trips, reports, audit) are ownerless and gated by
`requirePermission` at the top of every function; seats functions take a
**holder**, not an id, and ownership is enforced inside the SQL functions.

**No newly introduced bypass other than N-1.** Specifically re-checked: no route
lost a guard during remediation; no domain function reads identity from a
request-shaped object (after N-1); the guest-token path cannot be combined with
an authenticated identity, because `bookingFor` requires a positive token match
and never grants an operator permission to a guest.

---

## 5. Remaining accepted risks

| # | Risk | Rationale |
|---|---|---|
| **L-3** | Guest-token possession on a shared device | Token is CSPRNG + `HttpOnly`. IP/user-agent binding **rejected**: students move between campus wifi and mobile data mid-checkout and carriers rotate CGNAT, so it would break legitimate sessions far more often than stop an attacker who already has the cookie. The real bypass (NULL-ownership) is closed by M-1. Mitigation available: HD-7 cookie rotation. |
| **H-2 residual** | A distributed attacker with many IPs can reach the 40% guest ceiling | By design. The ceiling caps damage rather than preventing attempts; a coach can never be fully locked out. Tightening needs authentication (rejected — contradicts documentation) or a CAPTCHA (not specified). |
| **M-2** | No CORS configuration | Open. Same-origin deployment needs none; the danger is a hasty later fix using `*` with credentials. Decide before the frontend migration. |
| **M-3** | No CSRF token | `SameSite=Lax` is the primary control and is correctly set. A token only matters given an XSS on the origin. Hardening. |
| **L-4** | Two clocks for one hold expiry | Cannot drift today; nothing enforces that. Correctness, not security. |
| **Superuser** | A superuser can disable the audit triggers | Inherent to PostgreSQL. Why the least-privilege grant exists alongside them. |

**Hardening still outstanding:** HD-1, HD-2 (partly done), HD-4, HD-5 → *fix
before production*. HD-7, HD-8 → *post-launch*. Triage and reasoning in
`SECURITY_REMEDIATION.md`.

---

## 6. Tests

| | Count |
|---|---|
| **TESTS WRITTEN** | **~268** across 8 files |
| **TESTS EXECUTED** | **0** |
| **VERIFIED** | **0** |

`security.test.ts` alone is **48** tests, each written to fail against the
pre-fix code — a security test that passes both before and after proves nothing.
No existing test was deleted.

    seats.concurrency.test.ts   33      admin.test.ts     66
    payments.test.ts            43      security.test.ts  48
    boarding.test.ts            44      001_schema.sql    30 (psql)
    auth.test.ts                33      concurrency.md     5 (manual, two sessions)

---

## 7. Infrastructure still required

| Needed | Blocks |
|---|---|
| **PostgreSQL 15+** | everything — the single gating dependency |
| **Node 22.6+** | `--experimental-strip-types` |
| Transactional email provider | verification + password reset (students cannot verify or reset today) |
| Razorpay Test credentials | the entire payment path, including whether the signature scheme is right |
| Public HTTPS webhook endpoint | webhook signature work (Razorpay blacklists ngrok/webhook.site; docs suggest zrok) |
| TLS in every environment | `Secure` cookies |
| `dlt_app` role provisioned with LOGIN + password | H-3 layer 2, and `assertReady` will refuse to boot without it |
| Boarding device + connectivity decision | the §2.6 offline policy |

---

## 8. The exact next step

    cd backend
    createdb dlt_dev
    export DATABASE_URL=postgres://localhost/dlt_dev
    export NODE_ENV=test
    export ALLOW_AUDIT_PRIVILEGE=i-understand-the-risk   # local only: the suite runs as owner

    npm ci
    npm run migrate          # applies 001 → 009; expect the first real errors here
    npm run typecheck        # first compile ever; expect type errors around untyped pg rows
    npm test                 # ~268 assertions

Then, in order:

1. **Fix migration errors.** They will be shallow — syntax, a type coercion, a
   trigger definition. Definition ordering is already verified statically.
2. **Fix type errors until clean.** Do not proceed on a red typecheck.
3. **Run the suite.** This converts ~268 WRITTEN assertions into EXECUTED in one
   step and is the highest-value hour remaining in the project. Expect failures;
   they are information, not setbacks.
4. **Run `test/concurrency.md` by hand** — five two-session procedures. The
   evidence is that the loser **blocks**, which no automated test asserts as
   reliably.
5. **Provision `dlt_app`**, drop `ALLOW_AUDIT_PRIVILEGE`, and confirm the app
   boots with `auditAppendOnly: true`.
6. **Bind email**, then prove signup → verify → reset end to end — the first
   genuine cross-module journey.
7. **Razorpay Test mode:** confirm the **capture setting** first, then order →
   checkout → webhook verifies → *tampered* webhook rejected → refund →
   `refund.processed`.

Only after step 3 does any of this stop being a claim. Only after step 7 is the
payment path defensible.

**Nothing is VERIFIED. Stopping here.**
