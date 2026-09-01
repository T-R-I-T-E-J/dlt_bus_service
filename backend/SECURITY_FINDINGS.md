# DLT — SECURITY FINDINGS REPORT

**Date:** 1 September 2026
**Scope:** authorization/IDOR review of all 62 endpoints, plus the nine findings
carried forward from the verification report (S-3–S-9, D-1, D-2).
**No code was changed during the review itself.** Remediation followed and is
recorded in `SECURITY_REMEDIATION.md`; the per-finding status column below was
updated afterwards. Nothing has been executed, so nothing is VERIFIED.
**Nothing here is VERIFIED — no endpoint has ever been executed. Every finding
is derived from reading source, so exploitability is reasoned, not demonstrated.**

---

## Method

I enumerated every route with the guard it actually carries (accounting for
multi-line declarations and `router.use(requireAuth)`), then traced each handler
into the domain to see whether an object id supplied by the client is checked
against the caller. Two routes I had previously listed as unguarded —
`/admin/bookings/:id/override-refund` and `/admin/bookings/manual` — **are
correctly guarded**; my earlier single-line grep had missed their continuation
lines. Correcting that in both directions is the point of doing this properly.

**Guard coverage:** all 24 `/admin` routes carry `requireAuth` +
`requirePermission`. All 7 boarding routes carry both. The unauthenticated set is
deliberate (`signup`, `login`, `logout`, `me`, `verify-email`, `reset-password`,
`forgot-password`, trip/seat reads, seat holds, `POST /bookings`, `webhook`) —
with **two exceptions found below**.

---

# CRITICAL

## C-1 · `POST /payments/handback` — unauthenticated booking disclosure, and the signature result is discarded

**1. Vulnerability.** The route is unauthenticated, accepts any `paymentId`, and
returns the full booking object. The Razorpay signature verification result is
computed into `ok`, logged on failure, and **then ignored** — execution proceeds
to `reconcile()` regardless, whose return value is `bookingViewById()`.

**2. Attack scenario.** An unauthenticated attacker POSTs a payment id with a
junk signature. The response contains passenger names, student IDs, seat
numbers, contact phone, fare, and amounts received/refunded. It also forces a
server-side Razorpay API call per request — an amplification vector against our
own rate limit with the provider. Exploitation requires guessing a v4 UUID
(~122 bits), which is the only thing making this hard; a payment id leaked
anywhere else (a log, a support ticket, a browser history entry, a shared
screenshot) converts it to a single request.

**3. Affected.** `bookings.routes.ts` → `POST /payments/handback`;
`payments.ts` → `reconcile()`, `providerOrderIdFor()`.

**4. Why unsafe.** A signature check whose result does not gate anything is not a
check. The comment says the handback "is not proof of payment" — correct — but
the code then treats a *failed* handback identically to a passing one, and
returns PII either way.

**5. Severity.** CRITICAL (unauthenticated PII disclosure).

**6. Definite vulnerability**, not hardening.

**7. Recommended fix.** Require a session; verify the payment belongs to the
caller; return only `{status}` — never the booking body — and refuse when
`ok === false`. The genuine design intent (the webhook is the authority) is
preserved: this route should *report*, not disclose.

**8. Business rules.** None affected. Confirmation still comes from the webhook.
The frontend must read booking state from `GET /bookings/:id` after this call —
which `PAYMENTS_MIGRATION.md` §2 already instructs.

**9. Test.** Unauthenticated POST with a valid payment id → 401, no body.
Authenticated as a non-owner → 403. Owner with a bad signature → refused, no
booking body. Owner with a good signature → `{status}` only.

---

## C-2 · `POST /payments/:id/reconcile` — any authenticated user can reconcile any payment and read the booking

**1. Vulnerability.** `requireAuth` only. No ownership check anywhere in the
route or in `reconcile()`.

**2. Attack scenario.** Any student — including one with no bookings — submits
another student's payment id and receives that booking in full: names, student
IDs, phone, seats, money. Same PII set as C-1 but behind a trivially obtained
session.

**3. Affected.** `bookings.routes.ts` → `POST /payments/:id/reconcile`;
`payments.ts` → `reconcile()`.

**4. Why unsafe.** `reconcile` was written as an operator/system tool and exposed
on a student route. It takes a payment id and trusts it.

**5. Severity.** CRITICAL (authenticated cross-user PII disclosure).

**6. Definite vulnerability.**

**7. Fix.** Reuse the `assertBookingActor()` helper added for S-1/S-2: ownership,
or `payment.reconcile` for an operator. It already exists; this route simply does
not call it.

**8. Business rules.** None. Students legitimately need to poll their own
payment; operators keep the wider power via permission.

**9. Test.** Owner → 200. Other student → 403. Ops → 200. Unauthenticated → 401.

---

# HIGH

## H-1 (was S-3) · `GET /bookings/:id/cancellation-quote` — unprotected financial read

**1. Vulnerability.** `requireAuth`, no ownership. `cancellationQuote()` takes a
booking id and returns `{refundable, amount, hoursToDeparture, reason}`.

**2. Attack scenario.** An authenticated attacker enumerates or obtains a booking
id and learns how much a stranger paid and how much is refundable. Lower impact
than C-1/C-2 (no names), but it is financial data about another person, and it
is the natural reconnaissance step before an abuse attempt on `cancel`.

**3. Affected.** `bookings.routes.ts`; `payments.ts` → `cancellationQuote()`.

**4. Why unsafe.** It was written as a pure read and its caller assumed the UI
would only ever pass the user's own id — the same assumption that produced S-1
and S-2. The ownership fix applied to `cancel` deliberately did not extend here,
which left the pair inconsistent.

**5. Severity.** HIGH.

**6. Definite vulnerability.**

**7. Fix.** `assertBookingActor(c, bookingId, actorId)` at the top of
`cancellationQuote`. One line, same helper.

**8. Business rules.** None.

**9. Test.** Owner → quote. Other student → 403. Ops → quote.

---

## H-2 (was S-4) · Unlimited guest holds — trip starvation

**1. Vulnerability.** `POST /trips/:id/seats/:n/hold` is unauthenticated by
design (F-09, and the documentation promises seat selection without an account).
A guest is identified only by a cookie the server mints on demand. The 4-seat cap
is scoped **per guest token**, and tokens are free and unlimited.

**2. Attack scenario.** A script requests `GET /trips/:id/seats` (receives a
fresh `dlt_guest` cookie), holds 4 seats, discards the cookie, repeats. Eleven
iterations hold all 44 seats of a coach for 10 minutes; a loop sustains it
indefinitely. A trip can be made permanently unbookable at effectively zero cost
and with no account, no payment and nothing to trace but an IP. Legitimate
students see a full coach; the seats are never sold.

**3. Affected.** `trips.routes.ts` → `holderOf()`, `POST .../hold`;
`seats.ts` → `holdSeat()` (cap is per-holder); `hold_seat()` in 004.

**4. Why unsafe.** The cap assumed a holder is a person. For a signed-in student
that holds. For a guest, "holder" is a value the attacker chooses.

**5. Severity.** HIGH — availability, and it directly attacks revenue on the
launch route, which has one vehicle per departure.

**6. Definite vulnerability**, though the *fix* has a product dimension (below).

**7. Fix, in order of preference.**
   a. Rate-limit hold creation **by IP** as well as by token (e.g. 12 holds per
      IP per 10 minutes), so a single source cannot mint unlimited identities.
   b. Cap concurrent guest-held seats **per trip** to a fraction of capacity
      (e.g. 25%), so guests can never lock out a coach.
   c. Require a session before the *first* hold — this closes it completely but
      **contradicts the documented promise** of anonymous seat selection, and
      would resurrect finding F-09 from the original audit. I do not recommend
      it without a product decision.
   Options (a)+(b) together are sufficient and preserve the documented flow.

**8. Business rules.** (a) and (b) do not change documented behaviour; (b) is a
new limit worth naming in the spec. (c) **would contradict** PRD §7 / UX §4.

**9. Test.** 20 distinct guest tokens from one IP → refused after the IP budget.
Guest holds cannot exceed the per-trip ceiling. A signed-in student is unaffected
by the guest ceiling. One guest still holds up to 4.

---

## H-3 (was S-9 / D-3) · `audit_logs` REVOKE does not bind the table owner

**1. Vulnerability.** Migration 001 does `REVOKE DELETE, TRUNCATE, UPDATE ON
audit_logs FROM PUBLIC`. In PostgreSQL, the **table owner's** rights are not
granted through PUBLIC and are therefore unaffected by revoking from it. If the
application connects as the role that ran the migrations — the default in most
deployments — it can delete and rewrite audit records freely.

**2. Attack scenario.** Any SQL-injection foothold, or a compromised application
credential, or an insider with app-level DB access, erases the evidence of what
they did. The audit trail is the control that makes every reason-mandatory
workflow meaningful; if it is mutable by the app, those workflows are decorative.

**3. Affected.** `001_init.sql`; every `audit()` write; the admin audit test,
which correctly tests as a *non-owner* role and would therefore **pass while
production remains vulnerable**.

**4. Why unsafe.** The migration reads as if it enforces immutability. It does
not. This is the most misleading finding in the set, because the protection
appears present in source.

**5. Severity.** HIGH (integrity of the control that underpins accountability).

**6. Definite vulnerability** in any deployment where app-user = owner. It is a
*configuration* vulnerability, which is exactly why it must be enforced rather
than documented.

**7. Fix.** Two migration-owner roles: `dlt_migrator` owns the schema,
`dlt_app` is granted only `SELECT, INSERT` on `audit_logs` and normal DML
elsewhere. Add a startup assertion in `assertReady()` that
`has_table_privilege(current_user,'audit_logs','DELETE')` is **false**, so a
misconfigured deployment fails at boot rather than silently. Optionally a
`BEFORE DELETE OR UPDATE` trigger that raises unconditionally — that *does* bind
the owner, and is the belt to the grant's braces.

**8. Business rules.** None. Admin Spec §9–§10 ("never deleted") is what this
finally enforces.

**9. Test.** Connected as `dlt_app`: DELETE and UPDATE both raise. `assertReady`
refuses to boot when the current user holds DELETE. Trigger raises even as owner.

---

## H-4 (was S-6 / D-2) · Idempotency-key collision returns another request's response

**1. Vulnerability.** `claimIdempotency()` computes
`request_hash = JSON.stringify(req).length + ':' + endpoint` — a **length**, not
a digest. The stored `request_hash` is then never compared on replay: the code
returns `existing.response_body` for a matching *key* regardless.

**2. Attack scenario.** Two failure modes, one accidental and one deliberate.
*Accidental:* a client that reuses or derives keys predictably receives a
different booking's confirmation — wrong seats, wrong passenger, wrong booking
code shown to a student. *Deliberate:* an attacker who can guess or observe
another user's `Idempotency-Key` submits any booking request with that key and
receives the **stored response body of the original booking**, which is a full
booking view (PII). The key is client-chosen, so key quality is not ours to
assume.

**3. Affected.** `payments.ts` → `claimIdempotency()`, `completeIdempotency()`;
`POST /bookings`; `idempotency_keys` table.

**4. Why unsafe.** §5 idempotency is meant to make a *repeat of the same request*
safe. Here it makes a repeat of the same *key* — with any body, from any caller —
return cached data. It is missing both a real request fingerprint and any
caller binding.

**5. Severity.** HIGH.

**6. Definite vulnerability.**

**7. Fix.** Hash the canonicalised request body with SHA-256. On replay, compare
the stored hash: equal → return the cached response; **different → 422**
("that key was used for a different request"). Additionally scope keys to the
caller — `idempotency_keys.user_id` exists and is not populated — and make the
primary key `(user_id, key)` or verify `user_id` on read, so one caller's key
can never be another's.

**8. Business rules.** None. It strengthens §5 rather than altering it.

**9. Test.** Same key + same body → one booking, same response. Same key +
different body → 422, no second booking. Same key from a different user → 422/403,
no disclosure. Concurrent identical requests → one booking.

---

# MEDIUM

## M-1 (was S-5 / D-1) · `allocate_seat_to_booking` — guest-hold seat theft (latent)

**1. Vulnerability.** The ownership test is
`s.hold_by IS NOT DISTINCT FROM b.user_id`. For a guest hold, `hold_by` is NULL;
for a guest booking, `user_id` is NULL. `NULL IS NOT DISTINCT FROM NULL` is
**true**, so the check passes for *any* guest-held seat and *any* guest booking.
`hold_guest_token` is never consulted.

**2. Attack scenario.** Guest A holds 2B. Guest B creates a booking and settles
it against 2B, which is not theirs. **Currently unreachable:**
`settle_booking()` performs its own seat check and is the only production caller;
`allocate_seat_to_booking` is otherwise reached only from tests.

**3. Affected.** `002_seat_allocation.sql` → `allocate_seat_to_booking()`.

**4. Why unsafe.** A function whose stated purpose is "refuse any seat that is
not still ours" does not do that for the guest case. It was written in Phase 3,
before guest holds existed in Phase 4 — the guest column was added around it and
the predicate was never revisited. Any future caller inherits the hole silently.

**5. Severity.** MEDIUM (would be CRITICAL if wired; it guards the exact
double-allocation defect F-01 was about).

**6. Definite defect**, currently latent.

**7. Fix.** Require a positive identity match:
`(s.hold_by IS NOT NULL AND s.hold_by = b.user_id) OR (s.hold_guest_token IS NOT NULL AND s.hold_guest_token = <booking's guest token>)`.
This needs the booking's guest token, which `bookings` does not store — so either
persist it at creation or pass it as a parameter. Persisting is cleaner and also
lets sign-in adoption reconcile a guest booking to an account.

**8. Business rules.** None.

**9. Test.** Guest A holds 2B; a guest booking with a *different* token is
refused. Same token → allowed. Authenticated cases unchanged. Add to the F-01
regression set.

---

## M-2 (was S-7) · No CORS configuration

**1. Vulnerability.** `app.ts` mounts `helmet()` but no CORS middleware. With
cookie auth, this is a fork: either the browser blocks the frontend outright
(if served from another origin), or a permissive config is added hastily under
deadline pressure and `*` + credentials gets attempted.

**2. Attack scenario.** The dangerous outcome is the *fix* being done wrong later:
reflecting `Origin` or allowing `*` with `credentials: true` turns every
authenticated endpoint into a cross-origin read for any site the student visits.

**3. Affected.** `app.ts`.

**4. Why unsafe.** Not currently exploitable — it is an omission whose default
remedy is dangerous. Better decided deliberately now.

**5. Severity.** MEDIUM.

**6. Hardening / correctness**, not a live vulnerability today.

**7. Fix.** Explicit allowlist from `ALLOWED_ORIGINS`, `credentials: true`,
never `*`, never origin reflection. Same-origin deployment needs no CORS at all —
the simplest safe answer.

**8. Business rules.** None.

**9. Test.** Allowed origin → CORS headers with credentials. Any other origin →
no CORS headers. Assert `*` never appears with credentials.

---

## M-3 (was S-8) · No CSRF token on state-changing routes

**1. Vulnerability.** Session cookies are `HttpOnly; Secure; SameSite=Lax`.
`Lax` blocks cross-site POSTs, which covers classic CSRF. It does not cover a
same-site script (an XSS anywhere on the origin), and `Lax` still permits
top-level GET navigation.

**2. Attack scenario.** Given any XSS on the DLT origin, an attacker performs
authenticated actions — cancel a booking, change a contact — with the victim's
cookie, which the script cannot read but the browser still sends.

**3. Affected.** All authenticated POST/PATCH/DELETE routes.

**4. Why unsafe.** Defence in depth. `SameSite=Lax` is the primary control and is
correctly configured; a token means an XSS must also read the token.

**5. Severity.** MEDIUM.

**6. Hardening recommendation.**

**7. Fix.** Double-submit cookie or synchroniser token on state-changing routes.
Exempt `/payments/webhook` (no session, signature-authenticated).

**8. Business rules.** None. The client must send the header — one change in the
compatibility layer.

**9. Test.** Missing/incorrect token → 403. Correct → 200. Webhook unaffected.

---

# LOW

## L-1 · `POST /boarding/passengers/:id/*` — permission-gated but not trip-scoped

Ops and Super may manually board, deny, or no-show **any** passenger on any trip
by id. Correct for a global operations role and consistent with the prototype, so
not a defect — but there is no second factor: a mistyped passenger id silently
acts on a stranger on another departure. Every action is reason-mandatory and
audited, which is the mitigation. **Recommendation:** require the trip id in the
path and verify the passenger belongs to it, so a wrong id fails instead of
succeeding on the wrong person. LOW.

## L-2 · `GET /trips/:tripId/boarding-events` accepts any trip for `boarding.read`

Boarding staff hold `boarding.read` and are correctly forced to their assigned
trip for the *manifest* — but `boardingEvents()` takes `tripId` and does not
apply the same scoping. A staff member can read the scan log of any trip.
Contains passenger names and seat numbers, not phones. Inconsistent with the
manifest's own rule, which is why it is worth closing. LOW.

## L-3 · `POST /bookings` accepts a guest token the caller may not own

`holderOf()` reads `dlt_guest` from the cookie. The cookie is `HttpOnly`, so a
script cannot steal it, and it is 24 bytes of CSPRNG — but there is no binding
between token and IP/user-agent. Anyone who obtains a token (shared device,
proxy log) can book that guest's held seats. LOW, given `HttpOnly` and entropy.

## L-4 · `D-4` — two clocks for one hold expiry

`create_booking_from_holds` writes `hold_expires_at` onto both the booking and
its seats. They cannot currently drift, but nothing enforces agreement; a future
edit to one path produces a booking whose seats expire at a different moment
than the booking does. LOW / correctness.

---

# HARDENING

| # | Item |
|---|---|
| HD-1 | **No rate limit on `POST /bookings`, `/payments/create`, or seat holds.** Only `login`, `forgot-password`, `resend-verification` and `boarding/scan` are throttled. Booking creation hits the database hard and creates Razorpay orders. |
| HD-2 | **`express-rate-limit` is per-process.** Behind more than one instance the limits multiply. The DB-backed login lockout is the real control; the transport limiters are not shared. |
| HD-3 | **Top-level `await argon2.hash()` in `domain/auth.ts`** (the timing decoy). It is valid ESM but delays module load and will throw at import time if argon2 is misbuilt — a confusing boot failure. Make it lazy. |
| HD-4 | **No request-id / correlation id.** Every log line is unattributable to a request, which will make the first production payment incident hard to trace. |
| HD-5 | **`statement_timeout` 10s is generous** for a path that holds seat row locks. Consider a shorter timeout on the hold/booking transactions specifically. |
| HD-6 | **No `Retry-After` on 429s**, and no explicit `Cache-Control: no-store` on authenticated JSON. |
| HD-7 | **Guest cookie TTL 24h** with no rotation. Rotate on booking completion. |
| HD-8 | **`audit_logs` has no partition strategy** while being uncapped by design. Correct today; needs a plan before it is large. |

---

## Summary

| Severity | Finding | Status |
|---|---|---|
| **CRITICAL** | C-1 unauthenticated handback disclosure (+ ignored signature) | **FIXED** (written) |
| **CRITICAL** | C-2 cross-user reconcile | **FIXED** (written) |
| **HIGH** | H-1 unprotected cancellation quote | **FIXED** (written) |
| **HIGH** | H-2 unlimited guest holds | **FIXED** (written) — IP budget + 40% per-trip ceiling |
| **HIGH** | H-3 audit log mutable by owner | **FIXED** (written) — triggers + `dlt_app` role |
| **HIGH** | H-4 idempotency collision | **FIXED** (written) — SHA-256 + caller binding |
| **MEDIUM** | M-1 guest-hold seat theft (latent) | **FIXED** (written) — positive match both sides |
| **MEDIUM** | M-2 no CORS | open — hardening |
| **MEDIUM** | M-3 no CSRF | open — hardening |
| **LOW** | L-1 boarding actions not trip-scoped | **FIXED** (written) — optional trip assertion |
| **LOW** | L-2 boarding events unscoped | **FIXED** (written) |
| **LOW** | L-3 guest token unbound | **ACCEPTED RISK** — decision documented |
| **LOW** | L-4 duplicate expiry clocks | open — correctness |
| **HARDENING** | HD-1 … HD-8 | triaged in `SECURITY_REMEDIATION.md` |

**Also fixed:** `providerOrderIdFor()` removed — it took a payment id, returned
provider data and checked nothing.

**Structural fix:** `src/domain/authz.ts`. Five of these findings were one
repeated mistake; authorization is now a type, and every guard returns the row so
a caller cannot skip the check and still reach the object.

**8 fixed · 1 accepted · 34 regression tests written · 0 executed · 0 VERIFIED.**

**Definite vulnerabilities:** C-1, C-2, H-1, H-2, H-3, H-4, M-1 (latent), L-2, L-3.
**Hardening recommendations:** M-2, M-3, L-1, L-4, HD-1 … HD-8.

**Two findings I want to draw attention to specifically.** C-1 and C-2 are the
same mistake as S-1 and S-2 from the last review — a domain function that takes
an object id and trusts it, exposed on a student route. That pattern has now
produced four findings, which suggests the fix is structural: **no domain
function that accepts a booking or payment id should compile without an actor
argument.** H-3 is the most misleading, because the protection looks present in
the migration and its test passes while production stays exposed.

**Nothing above has been executed or proven. Nothing is VERIFIED.**
