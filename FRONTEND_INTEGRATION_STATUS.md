# DLT — FRONTEND INTEGRATION STATUS

**Date:** 1 September 2026
**Phase:** 7 — frontend / backend integration

> ## Backend verification remains DEFERRED
> Tests written ~268 · **executed 0** · **verified 0**. PostgreSQL unverified,
> Razorpay never contacted, email unconfigured. **Nothing below claims the
> backend works, the API is verified, or anything is production ready.**

---

## What I did this turn, and what I deliberately did not

**Done:** the audit (`FRONTEND_MIGRATION.md`) and the complete compatibility
layer (`dlt-client.js`) — the whole API surface, 62 endpoints, in one file.

**Not done: the five screens are unchanged.** They still load `dlt-store.js`.

That was a judgement call and I want to be straight about it rather than report
a half-rewired product as integrated. Rewiring 148 call sites across 5,208 lines
of screen code is several turns of careful work, and doing it at speed — against
an API that has never returned a single real response — is how you get five
screens that are subtly wrong in ways nobody can see until the backend runs.

The layer is the part that had to be right first, and it is the part that makes
the rest cheap: because every screen already talks to `window.DLT` and nothing
else, swapping the script tag is most of the migration.

**Current state: both stores coexist.** `dlt-store.js` still runs the product;
`dlt-client.js` is complete and unmounted. Nothing is broken, and no screen is
half-migrated.

---

## 1. Frontend areas migrated

| Area | Status |
|---|---|
| API client layer | **WRITTEN, complete** — all 62 endpoints |
| Session bootstrap (`boot()` + synchronous `auth.current()`) | **WRITTEN** |
| Razorpay Checkout integration | **WRITTEN** |
| Polling to replace `DLT.subscribe` | **WRITTEN** |
| Idempotency-key management | **WRITTEN** |
| Error/state taxonomy | **WRITTEN** |
| **Homepage** | **NOT STARTED** — 5 call sites |
| **Booking** | **WRITTEN — MIGRATED.** NOT EXECUTED AGAINST REAL API. NOT VERIFIED. |
| **Dashboard** | **NOT STARTED** — 15 |
| **Account** | **NOT STARTED** — 18 |
| **Admin** | **NOT STARTED** — 62 |

---

## 2. API endpoints connected in the client

All of them — auth (10), trips/seats (6), bookings (6), payments (3), waitlist
(4), boarding (7), admin (24), plus `exportUrl` as a download URL rather than a
string built in the page.

**Connected in the client ≠ exercised.** Not one of these has been called.

---

## 3. localStorage dependencies removed

**The audit's best news: no screen touched `localStorage` at all.** All of it
lived in `dlt-store.js`. So there is nothing to unpick screen by screen — the
dependency disappears when the script tag changes.

| Prototype authority | In `dlt-client.js` |
|---|---|
| `dlt.db.v5` (all records) | gone — server |
| `dlt.session` token | gone — HttpOnly cookie the page cannot read |
| `sessionStorage['dlt.pending']` (4 sites) | gone — guest cookie + `adopt_guest_bookings` |
| client hold sweeper | gone — server sweep + `trip_seat_view` |
| `DLT.provider` sandbox | **does not exist in the file** |
| `DLT.reset()`, `DLT._debug` | **not ported** |
| `admin.resetCodeFor()` | **not ported** |

These are not flag-gated. They are absent, so there is nothing to expose.

---

## 4. `window.DLT` compatibility changes

Same object, same names, same shapes. Three deliberate differences:

1. **`auth.current()` stays synchronous** — the session resolves once in
   `boot()` into module state. All 14 `renderVals()` call sites are unchanged.
   Each screen needs one loading gate before `boot()` resolves, and that is the
   only structural change the screens require.
2. **`trips.seatMap()` returns `{rows, held}`** — one request, one consistent
   snapshot. The prototype needed two calls and could render a map and a basket
   that disagreed.
3. **`bookings.create()` takes a `scope`** for idempotency-key grouping, and
   `clearAttempt(scope)` ends an attempt.

**Added, not replacing anything:** `checkout.open()`,
`checkout.awaitConfirmation()`, `startPolling()`, `boot()`,
`setUnauthenticatedHandler()`.

---

## 5–10. Integration by area

| Area | What the client does | Status |
|---|---|---|
| **Authentication** | 10 endpoints. Cookie session. `signUp` no longer returns a verify token (F-06) — copy must change. `changePassword` clears the cached session because every session died. | WRITTEN |
| **Seats / holds** | `hold()` throws `ApiError.isConflict` on a lost race; callers must refetch. Countdown from the server's `holdExpiresAt`. No client locking, no sweeper. | WRITTEN |
| **Booking** | `Idempotency-Key` per attempt, reused on retry. **No fare arithmetic anywhere in the file.** A 409 carries `{repriced, oldTotal, newTotal}` as data, so F-03 finally has a control to build against. | WRITTEN |
| **Razorpay** | `checkout.open()` uses the **server-created** order id and `keyId`. The success handler posts to `/payments/handback` and resolves to a *status*. `awaitConfirmation()` polls until the webhook lands. **No fake-success control exists in the file.** | WRITTEN, **never contacted Razorpay** |
| **Boarding** | Submits an identifier only — never a result, never a status, and for staff never a trip. `manifest('assigned')` asks the server which trip. | WRITTEN |
| **Admin** | 24 endpoints. **Reports return server-computed totals; nothing aggregates in the browser** (closes F-21's per-render recomputation). Export is a URL. | WRITTEN |

---

## 11. Loading / error / conflict states

`ApiError` carries `status`, `code`, `body`, `retryAfter`, with predicates so
screens branch as they did on the prototype's messages:

| Predicate / code | Meaning for a screen |
|---|---|
| `isConflict` (409) | seat lost, price stale, duplicate — **refresh and say what happened** |
| `isAuth` (401) | one central handler, not a redirect per call site |
| `isForbidden` (403) | not yours / role cannot |
| `isRateLimited` (429) | with `retryAfter` seconds from the server |
| **`isOffline`** | **network failed — deliberately distinct from a refusal.** A refusal is information; an outage is not, and a screen that shows the sign-in panel on a flaky network is worse than one that says the network is down |
| `repriced` in body | F-03 accept-the-new-total step |
| `CHECKOUT_DISMISSED` | "your seats are still held" — not a failure |
| `PAYMENT_FAILED` | "nothing was charged" |
| `pendingTimeout` | webhook slow — say "confirming", never "failed" |

`boot()` treats an outage differently from a signed-out session, which is the
distinction the prototype could not make.

---

## 12. Remaining prototype dependencies

**All five screens still load `dlt-store.js` and run on localStorage.** Until
the script tags change, the product is exactly the prototype — which is the
honest state, not a regression.

Still to remove **in the screens** when they are rewired: the `DLT.provider`
sandbox panel and its settle buttons; `demoHint` credentials on the pay screen;
the in-page hold sweeper; the client-side report computation in Admin.

`dlt-store.js` is **kept in the repo** deliberately: it is the executable
specification of the API contract, and the 268-assertion prototype suite still
runs against it.

---

## 13. Backend verification still pending

Unchanged and gating: PostgreSQL never run · 268 tests never executed ·
typecheck never run · Razorpay never contacted (including whether the signature
scheme is right) · email unconfigured, so no student can verify or reset ·
`dlt_app` unprovisioned · concurrency procedures unrun.

---

## 14. Known limitations

1. **The client has never made a request.** Every response shape in it is read
   from the server source, not observed. Shape mismatches are likely and are
   why the surface is one file.
2. **Screens not migrated** — see above.
3. **Razorpay Checkout script** must be added to the booking screen
   (`checkout.js`), with SRI. Not added; that is a screen change.
4. **Polling, not SSE.** Interim by design; pauses on tab-hide.
5. **`awaitConfirmation` gives up after ~24s** and reports pending. Correct
   behaviour, but the copy for that state is a screen change.
6. **No CORS on the server yet** (M-2). Same-origin deployment needs none; a
   cross-origin one needs an explicit allowlist with credentials — never `*`.
7. **No CSRF token** (M-3). `SameSite=Lax` is the primary control.

---

## 15. Files changed

| File | Change |
|---|---|
| `FRONTEND_MIGRATION.md` | **new** — audit, dependency map, priorities |
| `dlt-client.js` | **new** — the complete compatibility layer |
| `FRONTEND_INTEGRATION_STATUS.md` | **new** — this file |
| `dlt-store.js` | unchanged, retained as the contract reference |
| The 5 `.dc.html` screens | **unchanged** |
| `journey.js`, `dlt-qr.js` | **unchanged** — as instructed |

Nothing was redesigned. The homepage, 3D journey, bus, camera, environment,
typography, visual identity, booking UX, admin layout and responsive behaviour
are all untouched.

---

## Phase 7.2 — BOOKING: WRITTEN — MIGRATED · NOT EXECUTED · NOT VERIFIED

The booking screen no longer loads `dlt-store.js`. It is a client of the
API and holds no authority.

### Blockers resolved (approved decisions)

| | Fix |
|---|---|
| **B-1** | `reportingAt` / `arrivalEstimateAt` now derived in `TRIP_SQL` from `departure_at` + `routes.duration_min`, with `REPORTING_LEAD_MIN` as a named server constant. The policy has one home. **Caught while implementing:** binding the lead as `$4` would have left `$3` unreferenced, which Postgres rejects outright — it is interpolated from a `Number()`-coerced constant instead, so there is no injection surface. |
| **B-2** | `POST /trips/:id/notify` + `POST /notify`, throttled, deliberately unauthenticated (the sold-out state is shown to signed-out students). Stores the `tripId`, closing F-28. |
| **B-3** | No fare constant exists in the screen. While a trip is loading the price renders em-dash; a figure the server did not send is never shown. |

### Call sites: all 58 accounted for

| Disposition | Count | Detail |
|---|---|---|
| Migrated to the API | 34 | trips, seats, bookings, payments, waitlist, auth, notify |
| Presentation helpers | 12 | `fmt.*`, `seatType`, `roleLabel` — ported, no authority |
| **Deleted (prototype authority)** | **12** | store tag, `DLT.provider` ×2, 4 settle controls, `demoHint`, client sweeper, `sessionStorage` ×2 + `FLOW_KEY`, `myHeld` ×3, `DLT.subscribe`, `DLT.FARE` |

### What changed structurally

- **`boot()` once, then `auth.current()` stays synchronous** — all 14
  `renderVals()` call sites unchanged. One loading gate, already present.
- **`_load()`** performs every server read into `state.data`.
  `renderVals()` now makes **no requests** — it cannot render a stale guess.
- **`_watchSeats()`** polls the seat map every 5s while the seat step is
  open (pauses on tab-hide, in the client layer). Another device taking a seat
  is visible before the student hits a 409.
- **The 1s interval survives as presentation only** — it redraws the countdown
  from the server's `holdExpiresAt` and polls a settling payment. It sweeps
  nothing.
- **Payment:** `checkout.open()` on a **server-created order**, then
  `awaitConfirmation()`. The return from Checkout is never treated as
  success. The four sandbox buttons are gone from template **and** logic.
- **Repricing (F-03)** finally has a control: the 409 carries old and new totals,
  the student accepts, `bookings.acceptPrice()` commits. Never silent.
- **409 on hold** refreshes the map and says the seat was taken.
- **Offline ≠ signed out.** `boot()` and `fail()` keep them distinct.

### Notify: two paths, deliberately different

The earlier mismatch (a WhatsApp option against an email-only table) is resolved
**without touching the database**:

| Path | Behaviour |
|---|---|
| **Email** | Student enters an email → `POST /trips/:id/notify` → a `GET_NOTIFIED` request carrying the `tripId`. This is the only backend notification mechanism. |
| **WhatsApp** | A plain external link to the DLT WhatsApp Business chat (`wa.me/message/SIRNC3QVOEFLO1`), `target="_blank"` + `rel="noopener noreferrer"`, with an `↗` affordance and a screen-reader note. **No phone field, no stored request, no API integration, no schema change.** The conversation is handled by a person. |

The channel `<select>` is gone: two paths that behave differently should not sit
behind one dropdown that implies they are the same. The copy states the
difference plainly — "Email requests are logged for operations. WhatsApp opens a
conversation — we reply there, and nothing is recorded automatically." Nothing
claims an automatic WhatsApp alert.

### UI/UX preserved

No layout, typography, colour, spacing, animation, step order or seat-map design
changed. The one template edit is the checkout step, which had to change: it
described a Cashfree sandbox and carried four fake-payment buttons. Same borders,
same ink, same `dl` grid, same type scale — honest copy about Razorpay.

### Files changed

`DLT Booking.dc.html` · `dlt-client.js` (ports + `notifications`) ·
`backend/src/domain/seats.ts` (B-1, B-2) · `backend/src/http/trips.routes.ts` (notify).
`dlt-store.js` **untouched**. `journey.js` untouched.

### Status

**SOURCE WRITTEN.** TESTS WRITTEN ~268 · **EXECUTED 0** · **VERIFIED 0**.
The screen has never made a request. Razorpay has never been contacted. No
response shape in it has been observed — only read from the server source.

---

## Earlier Phase 7 outcome — booking screen (superseded)

**NOT MIGRATED. Stopped at the mismatch rule.** All 1,233 lines read and all 58
call sites mapped before any edit. Three cannot be satisfied without a decision:

1. **B-1** `reportingAt`/`arrivalEstimateAt` are not on the server's `TripView`.
   The 15-minute reporting lead is a policy, not a format — recomputing it in the
   browser would put an operational rule back in the browser.
2. **B-2** **No endpoint exists for "get notified."** A gap in my Phase 6 work:
   the operator side reads and decides `GET_NOTIFIED` rows; nothing lets a
   student create one.
3. **B-3** `DLT.FARE` — a hardcoded fare in the page. It only fires while the
   trip is loading, so it is a missing loading state, not a missing value.

Six safe ports (formatters, `seatType`, `roleLabel`, UX-only validation,
`ready`→`boot`, `confirmReprice`→`acceptPrice`) and six deletions
(`DLT.provider`, `demoHint`, client sweeper, `sessionStorage`, the store tag,
client `myHeld`) are identified and ready. The screen is byte-for-byte unchanged.

## Recommended next step

Two options, and I would take the first:

**A. Run the backend before rewiring the screens.** One evening on a real
machine converts 268 assertions from written to executed and settles the response
shapes. Then the screens get rewired once, against known behaviour.

**B. Rewire the screens now**, in the audit's priority order — Booking first
(41 sites, all the P0s), then Dashboard, Account, Admin, Homepage — accepting
that some will need a second pass once the API actually runs.

Say which and I will continue. Stopping here for review.
