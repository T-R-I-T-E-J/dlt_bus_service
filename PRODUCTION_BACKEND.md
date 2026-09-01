# DLT — production backend work required

**Status: NOT STARTED. This file exists so the boundary is never blurred again.**

Everything in the repository today runs in one browser tab. `dlt-store.js` is a
faithful implementation of the documented business rules and its API is shaped
like the documented HTTP surface (Data Model & API Spec §6), but it is not a
backend and must never be described as one. This file separates what the
prototype fixes can honestly claim from what only a real server can deliver.

---

## 1. What the prototype now does correctly (Phases 1–4, done)

These are real fixes to real logic defects. They will port to the server
unchanged, because they are rules, not infrastructure.

| Defect | Fix |
|---|---|
| F-01 | A settlement arriving after the seat hold lapsed no longer confirms the booking. The money is recorded, a refund is raised automatically, the seat is not reissued, and an operations alert is created. `finalizeBooking` now refuses any seat that is not already ours or genuinely free. |
| F-02 | A released seat is **reserved** for the offered student for the 30-minute claim window (`waitlist.claim` / `waitlist.decline`), expiry releases it and re-offers to the next student, and a paid claim converts the entry. |
| F-03 | A fare change returns a repricing decision the student can accept instead of throwing an exception that rolled its own correction back. The revalidated total and unit price are persisted and stale intents are expired. |
| F-05 | Refunds are capped by money actually received minus money already returned, and a free booking refunds nothing. |
| F-06 | Passwords are PBKDF2-SHA256 (120,000 iterations) with a per-account random salt; reset codes are never returned to the requester; the login lockout window is fixed from the first failure so it cannot be extended against a victim. |
| F-12 | A genuine Super Admin refund override: explicit amount, mandatory reason, capped by money actually held, refuses ₹0, and reports the amount it really raised. |
| F-13 | Operator screens for seat blocking, manual/complimentary bookings, booking-contact editing, and ID-change / deletion approval — all on the store methods that already existed. |
| F-14 | Vehicle create and edit (name, registration, seat configuration, status) against the existing `saveVehicle` guards. |
| F-19 | Boarding staff are assigned to a trip; the store derives the scanner's trip from the assignment and ignores whatever the client supplies. |
| F-10 | Native `BarcodeDetector` where available, jsQR everywhere else. The decoder only decodes — `DLT.boarding.scan` remains sole authority. |
| F-11 | Boarding code, booking ID and pass token all resolve **before** the validation chain, so hand-typed codes run the identical checks. Multi-passenger bookings return `CHOOSE` rather than guessing. |
| QR encoder | The reserved-area guards in `dlt-qr.js` were swapped, overwriting the dark module and leaving a format cell holding a data bit. **Every pass ever issued was undecodable.** Fixed and proved by decoding a rendered pass back to its exact token. |

## 2. What cannot be fixed in the browser (F-04)

None of the following is a code-quality problem. Each is missing infrastructure,
and each is a launch blocker in its own right.

### 2.1 Authority
Seat allocation, booking status, payment status, refund status, QR validity,
boarding status and role permissions are decided in `localStorage`, which the
student owns and can edit. Any user can grant themselves a confirmed booking, a
valid boarding pass or an admin session with the browser console.
**Required:** every rule in `dlt-store.js` re-implemented server-side, with the
client holding no authority. The module's API surface is the contract; the
screens should not need to change shape.

### 2.2 Payments — Razorpay (Payment Spec §2, §14)

**Provider decision: the payment provider is Razorpay.** The specifications
originally named Cashfree; they now carry a dated amendment recording the change
and the rules that did *not* change. Cashfree appears nowhere in the
implementation.

**Status: WRITTEN — NOT EXECUTED — NOT VERIFIED against Razorpay.**
`src/integrations/razorpay/` implements order creation, webhook
verification, refunds and checkout-handback verification behind the
provider-neutral `PaymentProvider` interface. No request has been
sent and no real webhook has been verified.

Every provider-specific security detail was read from Razorpay's current
official documentation during this migration, with the source cited in the
adapter's header comment. That is a genuine improvement on the previous
position — where the scheme was reproduced from memory — but **documented is not
observed**. Two things must happen in a Razorpay TEST account before this is
trusted:

1. one real webhook arrives and verifies;
2. one webhook with a **tampered body** is rejected.

**Razorpay differences that changed the design, not merely the field names:**

| Difference | Consequence |
|---|---|
| Amounts are in **paise** | Conversion confined to two functions in the adapter; rupees everywhere above |
| Signature is **hex** HMAC-SHA256 over the raw body, with **no timestamp** | The previous 5-minute replay window is impossible. Replay protection is now entirely `UNIQUE (provider, provider_event_id)` on `x-razorpay-event-id` — Razorpay's own documented dedupe key |
| Non-2xx retried with backoff for **24h**; dashboard replay for **15 days** | Never reject an old delivery; a rotated webhook secret must be retained |
| Webhook **ordering is not guaranteed** | `payment.authorized` is mapped to IGNORED, so a booking is never confirmed before capture |
| Refunds are created on the **payment** id and settle asynchronously | `dispatchPendingRefunds` sends them; `refund.processed` settles them |
| A payment without an order id **cannot be captured** and auto-refunds | Server-side order creation is mandatory, not merely preferred |

### 2.2b DEPLOYMENT PREREQUISITE — Razorpay capture mode

**The implementation requires the Razorpay account to be set to AUTOMATIC
CAPTURE. This is a hard prerequisite, not a preference, and it has not been
verified because no account is available here.**

Confirm before any real transaction: Razorpay Dashboard → Settings → Payment
Configuration → payment capture setting. It must be automatic.

#### Why the code depends on it

A Razorpay payment reaches `authorized` first and `captured` only when captured.
Money is not ours until capture. `mapPaymentStatus` therefore maps
`authorized` → `IGNORED` and only `captured` → `PAYMENT_SUCCEEDED`,
so a booking is never confirmed on an authorisation. Under automatic capture the
capture follows immediately and the student is confirmed within seconds.

This mapping is correct under BOTH modes and was deliberately left unchanged —
it is what makes the failure mode under manual capture safe rather than silent.

#### Exactly what happens under MANUAL capture

| Stage | Behaviour |
|---|---|
| Student pays | Razorpay authorises. `payment.authorized` arrives, is verified, recorded, and mapped to IGNORED. |
| Our booking | Stays `PAYMENT_PENDING`. No seat is allocated, no boarding pass issued. |
| Student sees | "We are confirming your payment", indefinitely. Their money has left their account. |
| Hold expiry (10 min) | `sweep_expired_holds` releases the seats and marks the booking ABANDONED. |
| Seat | Resold to another student. Correct behaviour — the seat was never paid for in our terms. |
| After 3 days | Razorpay auto-refunds the uncaptured authorisation. The student is made whole, three days late. |
| Net effect | **Every online booking silently fails.** No double-selling, no lost money, no corruption — but a launch that takes payments and confirms nothing. |

The system fails **safely** but **totally**. It would be caught by the first
test transaction, which is precisely why one must be run before launch.

#### If manual capture is required for business reasons

Do not change the status mapping to treat `authorized` as success — that
would confirm bookings against money we do not hold. Instead add an explicit
capture call in the adapter (`POST /payments/:id/capture` with the exact
amount and currency) on receipt of `payment.authorized`, and only then
let the resulting `payment.captured` event confirm the booking. That is a
new adapter method plus one branch in `applyEvent` — roughly half a day,
and it must be decided before launch rather than after.

### 2.3 Concurrency (Data Model Spec §4)
Optimistic compare-and-set on a version counter is genuine across tabs of one
browser and meaningless across devices. Two students on two phones cannot be
arbitrated.
**Required:** a unique active-seat constraint in the database and allocation
inside a transaction.

### 2.4 Sessions and credentials
Sessions are a token in `localStorage` with no rotation, no revocation list and
no device binding. PBKDF2 in the browser is the best available here but the
derivation must happen server-side. There is no email delivery, so verification
links and password-reset codes have no channel — the Super Admin lookup added in
Phase 1 is a support-desk stand-in, not a solution.
**Required:** HTTP-only session cookies, server-side KDF, transactional email.

### 2.5 Demo affordances that must not ship
- Reference credentials are printed on the review screen (`demoHint`).
- `DLT.reset()` wipes and reseeds the database from the console.
- `DLT._debug` exposes the raw store and its storage keys.
- The audit log is capped at 600 entries (Admin Spec §9–10 says never deleted).
- Seeded demo students, trips and payment-reconciliation cases.

### 2.6 Boarding — server migration status (Phase 5)

**Status: WRITTEN — NOT EXECUTED — NOT VERIFIED.**

The eleven-check validation chain is now server-side, ported verbatim and in
order into `board_by_pass()` (migration 007), which holds a row lock on
the passenger. Identifier resolution (QR token, boarding code, booking id) and
the CHOOSE flow live in `domain/boarding.ts`. The scanner submits an
identifier and nothing else.

Unlike payments, **nothing here is provider-simulated** — boarding involves no
third party. Once the tests are run they are genuine verification of the chain.

| Requirement | Where |
|---|---|
| Server-side pass validation, order preserved | `board_by_pass()`, 007 |
| Boarding-code and booking-id resolution (F-11) | `resolveIdentifier()` — one chain, no shortcut for typed input |
| Trip-assignment enforcement (F-19) | `assigned_trip_for()`; a client trip id is discarded for staff |
| Wrong-trip / cancelled / voided / refunded / unpaid / completed | checks 1–6 of the chain |
| Already-boarded protection | check 7, under the row lock |
| Multi-passenger CHOOSE | returns a question; mutates nothing, logs nothing |
| Boarding events for every attempt, valid or not | `log_boarding()`, append-only |
| Token prefix only, never the whole token (F-28) | `log_boarding()` truncates to 12 |
| Staff never receive a phone number | nulled inside `trip_manifest()` |
| Reason mandatory + audited on manual/deny/no-show | `domain/boarding.ts` |

#### PRODUCTION POLICY — offline boarding (decided)

Every scan is a network round trip. The prototype validated inside the page and
could not fail this way, so this is a risk created by the server migration. The
agreed policy:

**PRIMARY — boarding requires live server connectivity.** The server is the sole
authority for whether a pass is valid.

**EMERGENCY FALLBACK — a pre-downloaded, READ-ONLY trip manifest.** Staff may
consult it to identify passengers when connectivity is lost. It identifies; it
does not decide.

When connectivity is unavailable:

| | Behaviour |
|---|---|
| Scanner | Shows **OFFLINE**. Live validation is unavailable and says so. |
| Staff | May consult the pre-downloaded manifest to identify a passenger. |
| Boarding confirmation | Remains **pending** until the server is reachable. |
| The manifest | **MUST NOT** confirm or complete a boarding event. |
| Client-side queue | **Not permitted to become authoritative.** |

**Why the prohibition is absolute.** An offline queue that decides validity
makes the browser the authority again. Two devices could each accept the same
pass, or accept a pass cancelled after the manifest was downloaded — which is
F-01 (the reproduced double-allocation defect) in a new place. The manifest is a
printed list that happens to be on a screen: it tells staff who is expected, and
nothing more.

A boarding that happened during an outage is entered afterwards through the
existing audited manual-boarding path (`boarding.manual`, Ops/Super only,
reason mandatory) — not by replaying a client queue.

**PRODUCTION ACCEPTANCE TEST — network loss at the door.** Not a unit test and
not satisfiable in any environment here. Required before launch: at a real stop,
on the real device, with connectivity cut mid-queue — confirm the scanner shows
OFFLINE, confirm no boarding is recorded, confirm the manifest is still readable,
and confirm the queue is worked through and reconciled afterwards without a
double boarding.

#### Still requires real-device testing

Unchanged from the prototype audit, and untestable in any environment here:

- **Handset camera decode** — evening light, glare on a student’s screen,
  arm’s length, a moving queue. The decoder is proved in software; optics are
  not.
- **Physical/hardware scanner** — no third-party reader has been put in front of
  a DLT symbol.
- **Vendor jsQR rather than the CDN**, and the SRI gap that vendoring closes.
  Boarding must not depend on the public internet from a bus stop.
- **Network behaviour at both stops**, per the risk above.

### 2.7 Admin and operations — server migration status (Phase 6)

**Status: WRITTEN — NOT EXECUTED — NOT VERIFIED.**

Phase 3 built these workflows in the prototype store; this moves the authority
to the server. Nothing here is provider-simulated, so once the tests run they
are genuine verification.

Two rules shaped the implementation:

1. **No duplicated business rules.** The refund override (F-12) and manual /
   complimentary bookings live in `domain/payments.ts`, already correct
   and covered by the payment tests, and are **re-exported** by
   `domain/admin.ts` rather than reimplemented. Seat blocking, the vehicle
   guard and trip status live in SQL (008) because their rules are relational
   and need row locks.
2. **Authority is the stored role.** Every domain function begins with
   `requirePermission`, and every route builds its actor from the
   **session only**. A client that posts `{"role":"SUPER_ADMIN"}` changes
   nothing, because nothing reads it.

| Requirement | Where |
|---|---|
| Permissions and roles | `role_permissions` as data; 008 adds four rows the 003 seed was missing (`boarding.deny`, `boarding.noshow`, `trip.publish`, `trip.status`) that Phase 5–6 code already called |
| Trip management, publish, cancel-with-refunds | `saveTrip`, `publishTrip`, `cancelTrip` |
| Trip status, pinning ONE transition (F-23) | `set_trip_status()` — the pin lapses at the next boundary |
| Seat blocking / unblocking (F-13) | `block_seat()`, `unblock_seat()` — refuses a booked seat, displaces a live hold, re-offers to the waitlist |
| Manual / complimentary bookings (F-13) | re-exported from `payments.ts` |
| Booking contact editing (F-13) | `updateBookingContact` |
| ID-change approval (F-13) | `decideRequest` — approving **actually changes the ID** |
| Deletion approval (F-13, F-15) | `decideRequest` — anonymises, drops credentials, revokes sessions; refuses while upcoming bookings exist |
| Vehicle management (F-14) | `save_vehicle()` — create, registration, status, and the seat-configuration guard |
| Boarding staff assignment (F-19) | `assignStaff` — also revokes the staff member’s sessions so an open scanner cannot keep the old scope |
| Refund override (F-12) | re-exported from `payments.ts`, Super Admin only |
| Reports, totals computed server-side (F-22) | `report_trip_summary`, `report_revenue`; filters applied in the SQL that produces the numbers |
| Affected-passenger export scoped to one trip (F-22) | `affectedPassengers` |
| Audit log, persistent, uncapped (§9–§10) | `domain/audit.ts`; **no cap, no retention job**, DELETE and UPDATE revoked in 001 |
| Waitlist operations | `listWaitlist`, `moveWaitlistToTop` |
| Operational alerts | `operational_alerts` view — derived, so it cannot go stale |

#### Notes worth carrying forward

- `domain/audit.ts` **did not exist before this phase** although every
  earlier phase imported `audit()`. Had the earlier layers been executed,
  they would have failed at import. This is exactly the class of defect that
  only running the code finds, and it is an argument for standing up the
  database before writing any more layers.
- Actor name and role are **denormalised** into each audit row, so a later
  rename or demotion cannot rewrite what the log says about what somebody did
  at the time.
- An action and its audit entry commit in **one transaction**: a rolled-back
  mutation leaves no log of something that did not happen.
- The audit REVOKE can only be *proven* under the application role. A superuser
  test connection cannot see the refusal, and the test says so rather than
  passing silently.


### 2.7 Admin and operations (Phase 6)

**Status: WRITTEN — NOT EXECUTED — NOT VERIFIED.** Nothing here is
provider-simulated; admin operations involve no third party, so once the suite
runs it is genuine verification.

Every domain function begins with `requirePermission` against the role
stored in the DATABASE, read from the session. The HTTP layer builds its actor
from the session alone and never consults `req.body` for identity, so a
request claiming `{"role":"SUPER_ADMIN"}` changes nothing.

| Workflow | Where | Note |
|---|---|---|
| Seat blocking (F-13) | `block_seat()` / `unblock_seat()`, 008 | refuses a BOOKED seat; displaces a live hold; unblocking offers to the waitlist |
| Vehicle create/edit (F-14) | `save_vehicle()`, 008 | name/registration/status always editable; row count refused while seats are held or booked |
| Trip create, publish, status, cancel | `domain/admin.ts` + `set_trip_status()` | F-23: a manual status change pins ONE transition with an expiry, not the trip forever |
| Manual/complimentary bookings | `domain/payments.ts` | **re-exported, not reimplemented** |
| Refund override (F-12) | `domain/payments.ts` | **re-exported, not reimplemented**; Super only, explicit amount, capped by money held |
| Booking contact editing (F-13) | `updateBookingContact()` | reason mandatory, before/after audited |
| ID-change approval (F-13) | `decideRequest()` | approving **actually changes the student ID**, and refuses one already in use |
| Deletion approval (F-13) | `decideRequest()` | anonymises and revokes sessions; the row is retained because financial records reference it; refused while an upcoming confirmed booking exists |
| Staff assignment (F-19) | `assignStaff()` | revokes the staff member’s sessions so an open scanner cannot keep the old scope |
| Waitlist read + reorder | `listWaitlist()` / `moveWaitlistToTop()` | reason mandatory; an entry already holding an offer cannot be reordered |
| Reports | `report_trip_summary`, `report_revenue`, 008 | **every total computed in SQL from authoritative rows.** F-22: filters applied in the same query that produces the numbers |
| CSV export | `exportReport()` | separate permission from reading, and itself audited |
| Operational alerts | `operational_alerts` view, 008 | derived, never stored, so they cannot go stale |
| Audit log | `domain/audit.ts` | see below |

#### Permission gaps found while auditing Phase 5 against the role seed

`boarding.ts` already called `boarding.deny` and
`boarding.noshow`, and `admin.ts` needs `trip.publish` and
`trip.status` — none of which existed in the 003 seed. A missing permission
row makes `has_permission()` return false for every role, so the operation
is silently impossible rather than loudly broken. Added in 008, with a test that
asserts each one is seeded.

#### The audit log

- **No cap, no retention trigger, no cleanup job.** The prototype truncated to
  600 entries, so on a busy day the oldest evidence rolled off first. Admin Spec
  §9–§10: operational records are never deleted. Archive by partition if the
  table grows.
- Migration 001 **revokes DELETE and UPDATE** on `audit_logs` from PUBLIC,
  and there is deliberately no delete endpoint. **Deployment requirement:** the
  application role must be granted only SELECT and INSERT on that table — as the
  table owner the revoke does not apply, so the grant is what enforces it in
  production.
- `actor_name` and `actor_role` are denormalised on purpose: a later
  rename or demotion must not retroactively change what the log says.
- The entry commits in the same transaction as the mutation it describes, so a
  rollback loses both rather than recording something that never happened.

#### Frontend migration requirements (Phase 6 surface)

The admin console currently calls the prototype store synchronously. The
endpoints are a direct swap in shape, with three real changes:

1. **Reports move server-side entirely.** Delete the client-side aggregation and
   the per-render report recomputation (F-21) — the console recomputed every
   report on every render, on a six-second timer.
2. **Every admin call becomes async**, including the ones inside
   `renderVals()`. Same pattern as the student screens: load once into
   state, render from state.
3. **CSV export becomes a download from `/admin/reports/:kind/export`**
   rather than a string built in the page.


## 3. Porting order

**Steps 1–6 are drafted — see `backend/`.** Database foundation, authentication,
trips + seats, bookings + payments, boarding, and admin + operations: schema,
domain rules, HTTP routes and test suites are written. **None of it has been
executed**, because this environment has no PostgreSQL, no Node and no network
egress. Every server-side layer the specification calls for now exists as
source; nothing exists as a running system.

1. Database schema from the entities in Data Model Spec §1, with the unique
   active-seat constraint (§4).
2. Auth service: signup, login, verify-email, forgot/reset — server-side KDF,
   real email.
3. Trips and seats: read endpoints plus the atomic hold.
4. Bookings and payments: creation, Razorpay order, webhook, reconciliation,
   refunds — all idempotent (§5).
5. Boarding: scan, manual, manifest — chain lifted as-is into 007. **Drafted.**
6. Admin: permissions, audit, reports. **Drafted.** **Drafted** — migration 008,
   `domain/admin.ts`, `domain/audit.ts`, `http/admin.routes.ts`.

## 3a. Environment variables

Server-side only. Only `RAZORPAY_KEY_ID` may ever reach a browser.

    DATABASE_URL=postgres://user:pass@host:5432/dlt

    RAZORPAY_KEY_ID=rzp_test_xxxxxxxx        # public: sent to Razorpay Checkout
    RAZORPAY_KEY_SECRET=xxxxxxxx             # SECRET: API auth + handback signature
    RAZORPAY_WEBHOOK_SECRET=xxxxxxxx         # SECRET: webhook signature
    RAZORPAY_WEBHOOK_SECRET_PREVIOUS=        # keep after rotation, for replays
    RAZORPAY_BASE_URL=https://api.razorpay.com/v1

    SESSION_COOKIE_DOMAIN=...
    EMAIL_PROVIDER_API_KEY=...               # verification + password reset

Deployment requirements: HTTPS everywhere (Secure cookies), a publicly
reachable `POST /payments/webhook` on a non-blacklisted domain, a
raw-body parser on that route only, and scheduled jobs for
`sweepExpiredHolds`, `processPendingEvents` and `dispatchPendingRefunds`.

## 4. Services and credentials the developer must supply

None of these can be created, tested or even reached from this environment. Each
is a hard dependency for the phase named.

| Needed | For | Notes |
|---|---|---|
| PostgreSQL 15+ instance | step 1, immediately | one throwaway `dlt_test` database is enough to run the schema tests |
| Razorpay account (Test mode first) | step 4 | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` from Dashboard → Settings → API Keys |
| Razorpay webhook secret + a public HTTPS endpoint | step 4 | `RAZORPAY_WEBHOOK_SECRET`. Razorpay refuses localhost and blacklists common tunnels (ngrok.io, webhook.site, beeceptor.com…); their docs suggest zrok. Test-mode webhook setup uses OTP 754081. |
| `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` (after any rotation) | step 4 | replayed events verify against the secret in force when they occurred |
| Transactional email provider | step 2 | verification and password reset have no channel without it; the prototype's Super Admin lookup is a stand-in, not a solution |
| A hosting target and TLS | all | `HttpOnly; Secure` cookies require HTTPS in every environment, including staging |
| A decision on the boarding device | before launch | handset + hardware scanner need real-world testing; and see the connectivity risk in §2.6 |

Secrets go in the server environment only. If any of them ever appears in a
client bundle, a log line or an error response, treat it as disclosed and rotate.

The four screens talk to `window.DLT` only. Replacing that object with a thin
`fetch` client against the endpoints in Data Model Spec §6 is the whole
client-side migration.
