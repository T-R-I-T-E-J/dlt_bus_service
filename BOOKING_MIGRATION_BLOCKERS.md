# BOOKING MIGRATION — BLOCKED ON DATA MISMATCHES

> **RESOLVED, superseded — added during the production-completeness audit.**
> The mismatches below were decided and the booking screen WAS migrated
> (see git history after this file's date; `DLT Booking.dc.html` calls
> `dlt-client.js`/`DLT.boot()` like every other real screen and is covered
> by the real-HTTP integration tests). Kept as historical record of the
> decisions made, not as a current-state description — everything under
> "Outcome" and "NOT MIGRATED" below is stale.

**Date:** 1 September 2026
**Phase:** 7.2 — rewire the booking screen
**Outcome: NOT MIGRATED. Stopped at the mismatch rule, as instructed.**

> You wrote: *"If the screen expects data that dlt-client.js does not provide:
> STOP and report the exact mismatch. Do not invent a response shape. Do not
> modify backend business rules just to satisfy the screen."*
>
> This is that report. I read all 1,233 lines and mapped all 41 call sites
> before writing a line of migration code, and **three of them cannot be
> satisfied without a decision from you.** The booking screen is unchanged.

---

## Summary

| | Count |
|---|---|
| Call sites mapped | **58** (41 `DLT.*` calls + 17 helper/field references) |
| Satisfiable by `dlt-client.js` today | 43 |
| **Blockers needing your decision** | **3** |
| Safe ports (presentation only, no authority) | 6 |
| To be deleted (prototype authority) | 6 |

---

# THE THREE BLOCKERS

## B-1 · `reportingAt` and `arrivalEstimateAt` do not exist on the server

**Where the screen uses them** — lines 912–913, 1094, 1095, and the review step:

```js
report: DLT.fmt.time(t.reportingAt),      // "report 17:15"
arrive: DLT.fmt.time(t.arrivalEstimateAt) // "arrive 18:45"
```

Rendered in four places: the trip card, the summary bar, the review panel and the
sticky mobile bar.

**What the server returns.** `TripView` has `departureAt`, `price`, `status`,
`origin`, `destination`, `durationMin`, `vehicle`, seat counts — and **neither
field**.

**What the prototype did.** `dlt-store.js` derives both:
`reportingAt = departureAt − 15 min`, `arrivalEstimateAt = departureAt + durationMin`.

**Why I stopped.** The 15-minute reporting window is a **policy**, not a format.
It decides when a student is told to be at the stop, and boarding staff work to
it. Recomputing it in the browser would put an operational rule back in the place
this entire migration exists to take it out of — and if operations ever changes
it to 20 minutes, the server and five screens would disagree silently.

**Three options.** My recommendation is (a).

| | Option | Consequence |
|---|---|---|
| **a** | Add `reportingAt` and `arrivalEstimateAt` to `TripView`, derived in the `TRIP_SQL` projection from `departure_at` and `routes.duration_min`, with the 15-minute lead as a named constant | One SQL change, no new business rule — it *relocates* an existing one to where it belongs. No screen change. |
| b | Add a `reporting_lead_min` column to `routes` | More correct long-term (per-route lead times), but that is a product decision I have not been given |
| c | Compute in the client layer | **Rejected.** Puts a policy back in the browser. |

**Blocked on:** your choice. Nothing else in the trip card can render without it.

---

## B-2 · There is no endpoint for "get notified"

**Where the screen uses it** — line 1206, the sold-out / empty-state form:

```js
const rec = DLT.notifications.requestNotify({ email, tripId });
```

**What exists on the server.** `notification_requests` has a `GET_NOTIFIED` kind,
and `/admin/requests` can *read and decide* those rows. **There is no route by
which a student can create one.** I grepped all five route files: zero.

This is a gap in **my** backend work, not in the screen. Phase 6 built the
operator side of a workflow whose student side was never built — the same class
of gap as the original F-13 (capabilities in the store with no screen).

**Options.**

| | Option | Consequence |
|---|---|---|
| **a** | Add `POST /trips/:id/notify` (and an unauthenticated variant taking an email), writing a `GET_NOTIFIED` request with the trip id | Small, closes the gap properly. **Also fixes F-28's "notify requests never carry the trip they were made from"** — the prototype accepted a `tripId` that no caller passed. |
| b | Remove the notify form from the empty state | Loses a documented feature and a real signal about demand |
| c | Leave the button inert | **Rejected** — a no-op control is exactly what the first audit called out. |

**Blocked on:** your approval to add one endpoint. I did not add it unasked,
because you said not to start another feature phase.

---

## B-3 · `DLT.FARE` — a hardcoded fare in the browser

**Where** — line 900:

```js
const unitPrice = trip ? trip.price : DLT.FARE;   // ₹259 constant
```

**Why I stopped.** `dlt-client.js` deliberately contains no fare. A constant in
the page is precisely the "browser is the authority for what things cost" problem
the migration removes, and a stale one would show a student a price the server
will not honour.

**The fallback only fires when `trip` is null** — i.e. before the trip loads, or
when none is selected. So this is not really a missing value; it is **a missing
loading state** being papered over by a constant.

**Recommendation:** render the price as `—` (or skeleton) while `trip` is null,
and never show a fare the server did not send. That is a small UX addition — a
loading state, which you authorised — not a redesign. **I need you to confirm**,
because it changes what the student sees for a fraction of a second and you asked
me not to alter the booking UX unprompted.

---

# SAFE PORTS — no authority, awaiting no decision

These six are pure presentation or trivially derivable, carry no business rule,
and I will add them to `dlt-client.js` once you unblock the above. Listing them
so nothing is added silently:

| Screen expects | Nature | Plan |
|---|---|---|
| `DLT.fmt.time/date/when/countdown` | pure formatting of an ISO string | port verbatim from the store |
| `DLT.seatType(seat)` | `'A'/'D' → WINDOW` | port; the server also returns `seatType` per seat, so prefer the server value where present |
| `DLT.roleLabel(role)` | enum → display string | port |
| `DLT.bookings.validatePassenger(pax)` | field-level form validation | port **as UX only**. The server validates authoritatively in `validatePassengers()`; this exists so the Continue button can disable before a round trip. Same rules, and the server still refuses. |
| `DLT.ready` | prototype's readiness promise | → `boot()` |
| `DLT.payments.confirmReprice(id)` | | → `bookings.acceptPrice(id)` |

**Field renames** (server is authoritative; the screen adapts):
`claimExpiresAt` → `offerExpiresAt`, `reservedSeat` → `seatNumber`.

---

# TO BE DELETED — prototype authority

Confirmed present in the booking screen, all to go when it is rewired:

| Line(s) | Item |
|---|---|
| 846, 871 | `DLT.provider.createOrder` / `DLT.provider.settle` — the sandbox acquirer and its settle buttons |
| 367, 1128 | `demoHint` — "Reference account for review: … / dlt1234" printed under the pay button |
| 639 | `setInterval` client hold sweeper |
| 650, 685, 689, 1224 | `sessionStorage` flow persistence — replaced by the guest cookie and `adopt_guest_bookings` |
| 49 | `<script src="./dlt-store.js">` |
| 707, 776, 792 | client-side `myHeld` recomputation — the server returns `held` in the seat-map response |

---

# What I did NOT do

- **The booking screen is byte-for-byte unchanged.** No partial migration, no
  invented shapes, no stubbed values.
- `dlt-store.js` untouched.
- No backend business rule altered to suit the screen.
- No UI, layout, typography, colour, spacing, animation, step order or seat-map
  design changed.
- `journey.js` untouched.

---

# What I need from you

Three one-line answers and I can migrate the whole screen in the next turn:

1. **B-1** — add `reportingAt`/`arrivalEstimateAt` to `TripView` in SQL? *(a, b, or c)*
2. **B-2** — add `POST /trips/:id/notify`? *(yes / remove the form / leave for later)*
3. **B-3** — show `—` for the fare while the trip is loading? *(yes / keep a constant / other)*

If you would rather I proceed on my recommendations — **a, yes, yes** — say so and
I will treat that as approval and complete the migration in one pass.

---

## Status, unchanged

**BOOKING: NOT MIGRATED — BLOCKED.**
Backend: ~268 tests written, **0 executed, 0 verified.** Razorpay never
contacted. Nothing here claims otherwise.
