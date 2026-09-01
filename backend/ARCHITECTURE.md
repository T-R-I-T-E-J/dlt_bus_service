# DLT Backend — Architecture Decisions

**Status: design + database foundation. Nothing in this directory has been executed.**

This environment runs a browser. It has no Postgres, no Node runtime, no package
installer and no network egress to the payment provider. Every file here is real, reviewable
source intended to be run by a developer on a real machine — but *none of it has
been run*, no migration has been applied, and no backend test has passed. That
boundary is stated once here and repeated in the report; it is not softened
anywhere.

---

## 1. Current stack, as it actually exists

| Layer | Today |
|---|---|
| UI | Four browser pages (`DLT Homepage`, `Booking`, `Dashboard`, `Admin`, `Account`) — plain DOM, no framework build step |
| Business rules | `dlt-store.js`, ~2,400 lines, a faithful implementation of the documented rules |
| Persistence | One `localStorage` key, JSON, optimistic compare-and-set on a version counter |
| Payments | `DLT.provider`, a labelled sandbox object in the page |
| Tests | `store-tests.html`, 222 assertions, in-browser |

The important property: **every screen talks to `window.DLT` and nothing else.**
No screen reaches into storage, computes a fare, or decides a status. That was
deliberate and it is what makes this migration a replacement of one object
rather than a rewrite of five pages.

## 2. Recommended backend structure

```
backend/
  migrations/           numbered, forward-only SQL — the schema is the contract
  src/
    db/                 pool, transaction helper, row mappers
    domain/             the business rules, ported from dlt-store.js one module
                        per aggregate: seats, bookings, payments, refunds,
                        boarding, waitlist, admin
    http/               thin route handlers — parse, authorize, call domain, serialize
    integrations/       razorpay/, email/ — the only modules that talk outward
    jobs/               hold sweeper, trip status advance, reconciliation poll
  test/                 integration tests against a real throwaway database
```

**Rule: the `domain/` layer holds every business rule and the `http/` layer holds
none.** The defects this audit found — a late settlement resurrecting an
abandoned booking, a refund computed from a falsy zero, an override that
re-ran the policy it was overriding — were all rule defects. They must live in
one place that tests can reach without HTTP.

### Language and runtime
**Node.js + TypeScript.** Not because it is fashionable, but because
`dlt-store.js` is 2,400 lines of already-correct JavaScript business logic that
has 222 passing assertions against it. Porting it to Node is a mechanical
transliteration with types added; porting it to Go or Python is a rewrite, and a
rewrite is where correct rules go to die. Use `node:test` or Vitest, `pg`
directly (no ORM — see §4), and `zod` for input validation at the HTTP boundary.

## 3. Database choice: PostgreSQL

The specification (§4) makes *atomic seat allocation and unique active seat
constraints* mandatory. That single sentence decides the database.

- **Postgres, not MySQL:** partial unique indexes (`WHERE status <> 'AVAILABLE'`)
  express the active-seat constraint declaratively. MySQL has no partial index
  and would need a nullable-column trick that hides the intent.
- **Postgres, not Mongo:** the money path needs multi-row transactions
  (seat + booking + passenger + pass + payment + audit, all or nothing).
- **Postgres, not SQLite:** two students on two phones is the whole point; a
  single-writer file database cannot arbitrate them under real load.
- `SELECT … FOR UPDATE` on the seat rows gives the allocation ordering, and the
  partial unique index is the backstop that catches any path that forgets.

Version: **PostgreSQL 15+** (needed for `MERGE` if used, and for the
`gen_random_uuid()` built-in without the pgcrypto extension).

## 4. No ORM

Deliberate. The rules that matter here are expressed as constraints and
`FOR UPDATE` ordering, and every ORM makes those harder to see and easier to
lose behind lazy loading. Use `pg` with hand-written SQL in `db/` and keep the
statements readable. The schema is the contract; an ORM would put a second,
weaker contract in front of it.

## 5. Migration strategy

Forward-only, numbered, checked into the repository, applied by a runner that
records applied filenames in `schema_migrations`. No down-migrations: a mistake
in production is fixed by a new forward migration, never by reversing one. Each
file is a single transaction.

The prototype's seeded demo data is **not** a migration. It is a separate
`seed/dev.sql` that only runs against a database whose name ends in `_dev`, so
that seeded students, trips and reconciliation cases cannot reach production —
one of the removals PRODUCTION_BACKEND.md §2.5 requires.

## 6. API structure

Follow Data Model Spec §6 exactly for the documented endpoints, extended with
the operator and boarding routes the console already needs:

```
Auth      POST /auth/signup · /login · /logout · /verify-email
                /forgot-password · /reset-password
Trips     GET  /trips · /trips/:id · /trips/:id/seats
Seats     POST /trips/:id/seats/:seatNumber/hold · DELETE (release)
Bookings  POST /bookings · GET /bookings/:id · PATCH /bookings/:id
          POST /bookings/:id/cancel · /passengers/:pid/cancel · /seat-change
Payments  POST /payments/create · /payments/webhook · /payments/:id/reconcile
Boarding  POST /boarding/scan · /boarding/manual · GET /trips/:id/manifest
Waitlist  POST /waitlist · /waitlist/:id/claim · /waitlist/:id/decline
Admin     the Phase 3 workflows, all under /admin, all permission-checked
```

Every mutating endpoint accepts an `Idempotency-Key` header. Booking creation,
payment intent creation, refunds and boarding events are required to be
idempotent (§5) and the `idempotency_keys` table below implements that once,
centrally, rather than per-endpoint.

## 7. Authentication and sessions

- **KDF:** argon2id server-side (`argon2` npm), per-user salt. The prototype's
  browser PBKDF2 was the best available in a page and is not what should ship.
- **Sessions:** opaque random token in an `HttpOnly; Secure; SameSite=Lax`
  cookie, hashed at rest in `sessions`, with `expires_at`, `revoked_at`, and
  last-seen IP/user-agent for the revocation list. Never a JWT: boarding staff
  assignments and role changes must take effect immediately, and a stateless
  token cannot be un-issued.
- **Reset codes** are written to `password_resets` hashed, delivered only by
  email, single-use, 30-minute expiry, and **never returned in a response** —
  the prototype's F-06 defect.
- **Role enforcement** happens in a middleware that reads the session's role and
  the route's required permission from the same permission table the prototype
  already defines. The client's copy of the role is presentation only.

## 8. Payment provider boundary (Razorpay)

The domain depends on `domain/payment-provider.ts` — a `PaymentProvider`
interface — and never on an acquirer. `integrations/razorpay/` is the only code
that knows Razorpay exists.

Two rules keep that boundary real, and both were breached by the earlier
Cashfree code:

1. **No provider payload shape crosses it.** The adapter returns a
   `NormalizedEvent`, and `provider_events` stores those normalised fields in
   columns. `applyEvent` reads columns, never `raw_body`.
2. **No provider money unit crosses it.** Everything above the adapter is in
   whole rupees, matching the schema. Razorpay speaks paise; that conversion
   lives in two functions in the adapter and nowhere else.

- Orders are created **server-side** with the amount read from the frozen
  booking — never accepted from a client. Razorpay: a payment made without an
  order id cannot be captured and is auto-refunded, so the order is mandatory.
- The webhook endpoint verifies the **hex HMAC-SHA256 over the raw bytes**
  (`X-Razorpay-Signature`) before parsing intent, records the event, and
  returns 200 immediately. Processing runs from `provider_events`.
- **There is no timestamp in a Razorpay webhook signature.** Staleness cannot be
  detected and must not be faked — rejecting old deliveries would break their
  24-hour retry policy and their 15-day dashboard replay. Replay protection is
  `UNIQUE (provider, provider_event_id)` on `x-razorpay-event-id`, which is
  Razorpay's own documented dedupe key.
- Webhook **ordering is not guaranteed**; `payment.authorized` may follow
  `payment.captured`. Authorisation is mapped to `IGNORED` so a booking is
  never confirmed before funds are captured.
- Refunds are created against the **payment** id, carry our refund row id as the
  merchant reference (making them idempotent from our side), and settle
  asynchronously — `refund.processed` is the definitive status.
- Secrets (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
  `RAZORPAY_WEBHOOK_SECRET`) live in the server environment. Only `KEY_ID` is
  ever sent to a browser. A rotated webhook secret must be retained as
  `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` so replayed events still verify.

## 9. How `window.DLT` maps to the server

The client keeps the same object; only its body changes. `dlt-store.js` becomes
`dlt-client.js` — the same method names, the same return shapes, each one a
`fetch`. Screens are untouched.

| `window.DLT` today | Becomes |
|---|---|
| `auth.signIn/signUp/signOut` | `POST /auth/login · /signup · /logout` |
| `auth.current()` | session-backed `GET /auth/me`, cached in memory for the page |
| `trips.listPublic/get/seatMap` | `GET /trips · /trips/:id · /trips/:id/seats` |
| `seats.hold/release` | `POST/DELETE /trips/:id/seats/:n/hold` |
| `bookings.create/get/cancel` | `POST /bookings`, `GET`, `POST …/cancel` |
| `payments.createIntent/reconcile` | `POST /payments/create · /:id/reconcile` |
| `provider.*` (sandbox) | **deleted** — replaced by Razorpay Checkout |
| `boarding.scan/manual/manifest` | `POST /boarding/scan · /manual`, `GET …/manifest` |
| `admin.*` | `/admin/*`, permission-checked server-side |
| `_debug`, `reset()` | **deleted** — not hidden, deleted |

Two consequences worth stating now, because they change screen behaviour and
will need UI work in a later phase:

1. **Every call becomes asynchronous.** The screens already `await` some calls,
   but many read synchronously (`DLT.trips.get(id)` inside `renderVals`). Those
   become loads with pending states. This is the single largest client-side task
   in the migration and it is not free.
2. **The store's synchronous broadcast** (`DLT.subscribe`) becomes polling or
   SSE. Seat maps and the boarding manifest are the two surfaces that genuinely
   need live updates; the rest can refetch on action.

## 10. What the database must enforce, not merely store

Each of these corresponds to a defect this audit reproduced. They are written as
constraints so that no future code path can reintroduce them:

| Defect | Constraint |
|---|---|
| F-01 double allocation | partial unique index on `(trip_id, seat_number)` for non-available seats, plus `FOR UPDATE` allocation ordering |
| F-01 late settlement | `provider_events.provider_event_id` unique; booking status re-checked inside the settling transaction |
| F-03 fare change | `bookings.unit_price` persisted at creation; repricing writes a row, never throws mid-transaction |
| F-05 free-booking refund | `CHECK (amount > 0)` on refunds, and a refund total that cannot exceed payments received |
| F-06 auth | password hashes and reset codes in their own tables, never selected into a client-facing view |
| F-19 staff scope | `trip_staff` join table is the only source of a staff member's trip |
| Audit cap | `audit_logs` has no retention trigger — Admin Spec §9–10 says never deleted |
