# DLT — SECURITY REMEDIATION

**Date:** 1 September 2026
**Migration:** `009_security_remediation.sql`
**Regression suite:** `backend/test/security.test.ts` — 34 tests, **0 executed**

> **Every status below is WRITTEN. Nothing is VERIFIED.** This environment has no
> PostgreSQL and no Node runtime, so not one of these fixes has been executed and
> not one regression test has run. A fix that has not been executed is a claim.

---

## The structural fix, first

Five findings — S-1, S-2, C-1, C-2, H-1 — were one mistake repeated: **a domain
function took an object id, trusted it, and was exposed on a student route.**
Patching five call sites would have left the sixth to be written next week.

`src/domain/authz.ts` makes authorization a **type**. Every owned object is now
reached through a guard that answers all four questions in one place — who is
calling, what role, do they own it, does their permission allow it — and
**returns the loaded row**. That last part is the structural property: a caller
cannot skip the check and still obtain the object, because the check is on the
only path to it. A lint rule or a code review would not have that property.

| Guard | Objects |
|---|---|
| `bookingFor` | bookings — owner, guest-token owner, or `booking.read` |
| `paymentFor` | payments — owned via their booking |
| `passengerFor` | passengers, with an optional trip assertion (L-1) |
| `waitlistEntryFor` | waitlist entries |
| `refundFor` | refunds |
| `userFor` | user records |
| `boardingScopeFor` / `requireTripScope` | trip scope for boarding staff (F-19) |
| `requireOperator` | ownerless objects — vehicles, reports, audit |

---

## Findings

### C-1 · Unauthenticated booking disclosure through the checkout handback

**Root cause.** Two independent defects in one route. It was unauthenticated and
returned `bookingViewById()` — the full booking. And the signature result was
computed into `ok`, logged on failure, then **ignored**: execution continued
identically for a forged handback. A signature check that gates nothing is not a
check.

**Fix.** `requireAuth`; ownership through `paymentForActor` **before** anything
else, so an unauthorized caller learns nothing — not even whether the payment
exists; a failed signature now throws `FORBIDDEN`; the response is
`{signatureVerified, paymentStatus, bookingStatus, bookingId}` — **never a
booking object**. It remains a report, not a second confirmation path: only a
verified webhook confirms.

**Regression test.** Unauthenticated → refused. Non-owner → `FORBIDDEN`, with an
assertion that the message contains no amount or name. Owner → status only, with
`JSON.stringify` asserted free of passenger name, phone and student ID.

**Status:** FIXED (written). **Remaining risk:** the handback's *signature*
correctness still depends on Razorpay behaving as documented — unproven until a
real Test-mode transaction.

---

### C-2 · Any authenticated user could reconcile any payment

**Root cause.** `reconcile(paymentId, provider)` took an id with no ownership
check and returned the booking in full. It was written as an operator/system tool
and exposed on a student route.

**Fix.** Signature is now `reconcile(paymentId, actor, provider)`; the actor is
required, `paymentFor` enforces ownership-or-`payment.reconcile`, and the return
is a **status triple**, not a booking. A caller entitled to the booking reads it
from `GET /bookings/:id`, which has its own guard — one disclosure path, one
check.

**Regression test.** Stranger → `not yours`. Owner and ops → succeed. Nonexistent
id → `NOT_FOUND`. Return shape asserted to be exactly three keys.

**Status:** FIXED (written). **Remaining risk:** none known.

---

### H-1 · Unprotected cancellation-quote read

**Root cause.** Same pattern. `cancellationQuote(bookingId)` had no actor
argument at all, so the route could not have checked even if it had wanted to.

**Fix.** `cancellationQuote(bookingId, actor)` — the actor is now required **by
the signature**, and `bookingFor` runs first. There is no overload without it.

**Regression test.** Stranger → refused. Owner and ops → ₹259. Plus explicit
S-1/S-2 regressions in the same block, since those share the root cause.

**Status:** FIXED (written). **Remaining risk:** none known.

---

### H-2 · Unlimited guest holds → trip starvation

**Root cause.** Holds are anonymous by documented design (PRD §7, UX §4, F-09).
A guest is identified only by a cookie the server mints on demand, and the
4-seat cap was scoped **per token**. Tokens are free, so the cap counted
something the attacker chose. Eleven fresh cookies lock a 44-seat coach; a loop
sustains it, with no account, no payment and nothing to trace but an IP.

**Fix — anonymous seat selection preserved.** Requiring a session before the
first hold would close this completely but contradicts the documentation and
resurrects F-09, so it was **rejected**. Two configurable limits instead:

| Limit | Default | Why this value |
|---|---|---|
| `GUEST_HOLDS_PER_IP` | **12 per 10 min, per (ip, trip)** | A real student holds at most 4; re-picking seats a few times is normal, so 12 is three full baskets. Deliberately generous because Woxsen students share campus NAT and Indian carriers use large-scale CGNAT — a tight limit would lock out a hostel. Scoped per trip so one busy departure cannot exhaust another's budget. |
| `GUEST_HOLD_CEILING_PCT` | **40% of a trip's seats** | The limit that actually *guarantees* a coach cannot be locked out, however many tokens are minted. 40% leaves ample room for genuine anonymous browsing while keeping the majority reachable. |

Two deliberate properties: **only guest holds are counted**, so a signed-in
student is never rate-limited and sustained abuse costs an account; and the IP
window is **fixed from the first attempt**, never extended — the same rule as
login lockout (F-06), so one bad actor behind a shared NAT cannot push it into a
permanent block. The counter lives in `guest_hold_attempts` (a table, not process
memory) so it survives restarts and is shared across instances — which also
resolves HD-2 for this path.

**Regression test.** A normal guest still holds 4 (documented behaviour intact).
**The attack:** 20 identities × 4 seats from one IP against 44 seats → refusals
occur, free seats remain, guest holds stay within the ceiling. The window is
asserted not to extend. **A signed-in student succeeds while the guest ceiling is
saturated.**

**Status:** FIXED (written). **Remaining risk:** a **distributed** attacker with
many IPs can still reach the 40% ceiling — by design; the ceiling caps the damage
rather than preventing the attempt. The residual is degraded anonymous browsing
on a targeted trip, never a locked-out coach. Tightening further would need
either authentication (rejected) or a CAPTCHA (not specified).

---

### H-3 · Audit log mutable by the table owner

**Root cause.** `REVOKE DELETE, TRUNCATE, UPDATE … FROM PUBLIC` does not touch
the **table owner's** rights, which are not granted through PUBLIC. If the app
connects as the migration role — the common default — it could delete and rewrite
the audit trail. **The most misleading finding in the set:** the protection
looked present in the migration, and the existing admin test passed because it
correctly tested as a non-owner role.

**Fix — three layers, deliberately redundant.**

1. **Triggers** on DELETE / UPDATE / TRUNCATE that raise unconditionally.
   Statement-level, so a mass DELETE is refused before touching a row and
   TRUNCATE is covered. **These bind the owner** — this is the layer that
   survives someone deploying with the wrong role.
2. **A `dlt_app` runtime role** granted normal DML everywhere and only
   `SELECT, INSERT` on `audit_logs`, with `ALTER DEFAULT PRIVILEGES` so future
   tables inherit the shape.
3. **A startup assertion** — recommended for `assertReady()` — that fails closed
   if the runtime role holds destructive audit privilege.

**Regression test.** The suite runs **as the owner**, which is exactly why it
asserts the *trigger*: DELETE, UPDATE and TRUNCATE all raise `append-only`, and
the record survives every attempt. Separately, `has_table_privilege('dlt_app', …)`
asserts the real runtime role holds INSERT/SELECT and not DELETE/UPDATE. The
no-cap rule (§9–§10) is re-asserted at 700 rows.

**Status:** FIXED (written). **Remaining risk:** layer 3 is *recommended* and not
yet added to `assertReady()`; a superuser can always disable a trigger, which is
inherent and is why the least-privilege grant matters alongside it.

---

### H-4 · Idempotency-key collision returned another user's response

**Root cause.** `request_hash` was `JSON.stringify(req).length + ':' + endpoint`
— a **length**, not a digest — and was never compared on replay. A caller
presenting a known key received the stored response of the original request,
which is a full booking view. Keys are client-chosen, so key quality was never
ours to assume. Records were also not bound to a caller: `user_id` existed on the
table and was never populated.

**Fix.** SHA-256 over a **canonicalised** body (keys sorted at every depth, so
property order cannot change the digest), compared on every replay. Records bound
to the caller — `user_id` for a student, `guest_token` for an anonymous checkout —
with the primary key moved to `(key, endpoint)`. A foreign key and a changed body
return the **same** message, so this cannot be used to probe which keys exist.

**Requirements met exactly as specified:** same user + same key + same request →
same result. Same key + different request → refused. Different user + same key →
never another user's response.

**Regression test.** All three requirements. Plus: the stored hash is asserted to
be 64 hex chars and bound to its caller; property reordering yields the same
booking; concurrent duplicates produce exactly one booking.

**Status:** FIXED (written). **Remaining risk:** the refusal is `CONFLICT` (409)
rather than 422 as requested — 409 is what the existing error map already
translates and what the client's retry logic understands. Say if you want 422 and
it is a one-line change to `STATUS`.

---

### M-1 · Guest-hold seat ownership decided by `NULL = NULL`

**Root cause.** `allocate_seat_to_booking` tested
`s.hold_by IS NOT DISTINCT FROM b.user_id`. For a guest hold `hold_by` is NULL;
for a guest booking `user_id` is NULL; `NULL IS NOT DISTINCT FROM NULL` is
**true**. So any guest-held seat matched any guest booking, and
`hold_guest_token` was never consulted. Written in Phase 3, before guest holds
existed in Phase 4 — the column was added around it and the predicate was never
revisited.

**Fix.** `bookings.guest_token` persists the token the seats were held with, so
ownership is a **positive match on both sides**:
`(hold_by IS NOT NULL AND = user_id) OR (hold_guest_token IS NOT NULL AND = guest_token)`.
A NULL on either side can no longer satisfy anything. `create_booking_from_holds`
now stores the token it validated against, and the AVAILABLE branch was also
tightened — it previously accepted *any* free seat, and now requires the seat to
already carry this booking's id. `adopt_guest_bookings()` carries the booking to
the account on sign-in, completing F-08.

**Regression test.** Guest B cannot allocate guest A's seat (the exact defect).
The booking persists its token. A guest reads their own booking and no other. An
authenticated hold cannot be taken by a guest booking. Sign-in adoption
transfers ownership.

**Status:** FIXED (written). **Remaining risk:** none known. Note the fix was
latent-only before — `settle_booking` did its own check — but the function's
stated job was to refuse a seat that is not ours, and it did not.

---

### L-2 · Boarding events not trip-scoped

**Root cause.** `manifest()` correctly forced staff to their assigned trip;
`boardingEvents()` took a `tripId` and did not. Two functions, one rule,
implemented once.

**Fix.** Both now derive scope from `boardingScopeFor` in `authz.ts`, and
`boardingEvents` calls `requireTripScope`. One source, so the scanner, the
manifest and the event log cannot disagree again.

**Regression test.** Staff refused another trip's log; allowed their own; ops
allowed any; the F-19 manifest rule re-asserted.

**Status:** FIXED (written). **Remaining risk:** none known.

---

### L-3 · Guest token possession — decision recorded

**Threat model reviewed. Decision: keep the token as-is; add no binding.**

The token is 24 bytes of CSPRNG in an `HttpOnly; Secure; SameSite=Lax` cookie, so
no script can read it and it cannot be guessed. The residual risk is *physical or
proxy* possession — a shared campus machine, a logged proxy.

**Binding to IP or user-agent was considered and rejected.** Woxsen students move
between campus wifi and mobile data mid-checkout, and Indian carriers rotate
CGNAT addresses; an IP binding would break legitimate sessions far more often
than it would stop an attacker who already has the cookie.

**What was hardened instead, which is the part that actually mattered:**
possession of a guest token can no longer be combined with an authenticated
identity to bypass ownership. `bookingFor` requires a **positive** guest-token
match and returns `_access: 'GUEST'`; an authenticated actor is never granted
access via a guest token, and a guest is never granted an operator permission.
Before M-1, a NULL user_id on both sides was treated as ownership — that was the
real bypass, and it is closed.

**Status:** ACCEPTED RISK, documented. **Remaining risk:** shared-device token
reuse. Mitigation available if wanted: rotate the guest cookie on booking
completion (HD-7).

---

## Second-pass authorization audit

I re-scanned every exported domain function taking `bookingId`, `paymentId`,
`passengerId`, `userId`, `tripId`, `entryId`, `refundId` or `vehicleId`.

**36 guarded. 14 flagged. 13 safe by construction. 1 genuinely unguarded — removed.**

| Function | Why it is safe without a guard |
|---|---|
| `auth.resendVerification(userId)`, `signOutEverywhere(userId)` | route passes `req.session.userId` only; no client id path |
| `payments.myBookings(userId)`, `seats.myWaitlist(userId)` | filter *by* the caller's own id; that is the authorization |
| `seats.seatMap`, `myHeld`, `holdSeat`, `releaseSeat`, `releaseAll` | take a **holder**, not an id. `release_seat` refuses a seat not held by that holder, in SQL |
| `seats.joinWaitlist(tripId, userId)` | route passes the session id; trips are public |
| `seats.claimOffer`, `declineOffer` | `claim_waitlist_offer` raises `insufficient_privilege` when `e.user_id <> p_user_id`; ownership enforced in SQL |
| `payments.createBooking` | authorization *is* the hold: the seats must be held by this holder |
| `payments.priceCheck` | called only from `createCheckout`, after its guard |

**Removed:** `payments.providerOrderIdFor(paymentId)` — took a payment id,
returned provider data, checked nothing. It became dead when the handback moved
to `paymentForActor`, and dead unguarded code is how a vulnerability returns.

---

## Hardening triage

| # | Item | Classification | Why |
|---|---|---|---|
| HD-1 | Rate limits on `/bookings`, `/payments/create`, holds | **FIX BEFORE PRODUCTION** | Holds are now limited (H-2). Booking and checkout creation still hit the DB hard and create real Razorpay orders. Needs the real endpoints running first to pick sane numbers. |
| HD-2 | Distributed rate limits | **PARTLY FIXED NOW** | The H-2 guest limiter and the login lockout are already DB-backed and shared. The remaining `express-rate-limit` counters are per-process — **FIX BEFORE PRODUCTION**, only if deploying more than one instance. |
| HD-3 | Lazy argon2 init | **FIX NOW — one line** | Top-level `await argon2.hash()` delays module load and throws at *import* time if argon2 is misbuilt, producing a confusing boot failure. Cheap and removes a first-run trap. |
| HD-4 | Request/correlation ids | **FIX BEFORE PRODUCTION** | Not a vulnerability, but the first production payment incident will be very hard to trace without it. Cheap; do it before real money moves. |
| HD-5 | Shorter `statement_timeout` on hold/booking transactions | **FIX BEFORE PRODUCTION** | 10s is generous for a path holding seat row locks. Needs real timings to choose a number — after execution, not before. |
| HD-6 | `Retry-After` + `Cache-Control: no-store` | **FIX NOW — trivial** | `no-store` on authenticated JSON is a genuine (small) disclosure control; `Retry-After` makes the new 429s actionable by the client. |
| HD-7 | Guest-cookie rotation | **POST-LAUNCH** | Mitigates only the shared-device residual of L-3, and adds a state transition mid-checkout — the riskier change of the two. |
| HD-8 | Audit-log partition strategy | **POST-LAUNCH** | Correct today and deliberately uncapped. A partition plan is needed when the table is large, which is months of real traffic away. |

**Nothing in this triage was implemented.** Three items are marked FIX NOW
(HD-3, HD-6, and layer 3 of H-3) and are waiting on your decision, as instructed.

---

## Status summary

| | Count | Items |
|---|---|---|
| **FIXED (written, not executed)** | 8 | C-1, C-2, H-1, H-2, H-3, H-4, M-1, L-2 |
| **ACCEPTED RISK (documented)** | 1 | L-3 |
| **ALSO FIXED** | 2 | L-1 trip assertion on boarding actions; dead unguarded function removed |
| **HARDENING — FIX NOW** | 3 | HD-3, HD-6, H-3 startup assertion |
| **HARDENING — BEFORE PRODUCTION** | 4 | HD-1, HD-2, HD-4, HD-5 |
| **HARDENING — POST-LAUNCH** | 2 | HD-7, HD-8 |
| **TESTS WRITTEN** | 34 | `test/security.test.ts` |
| **TESTS EXECUTED** | **0** | — |
| **VERIFIED** | **0** | **nothing has run** |

No existing test was deleted. Total suite is now ~254 assertions across 7 files,
all unexecuted.

**The gating dependency is unchanged: a real PostgreSQL.** Every fix above is a
claim until `npm run verify` produces output.
