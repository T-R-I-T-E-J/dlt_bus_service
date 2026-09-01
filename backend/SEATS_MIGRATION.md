# Trips & seats — browser behaviour → server endpoints

Companion to `AUTH_MIGRATION.md`. Same rule: *unchanged* means the screens keep
working; *changes* is scheduled client work.

**Nothing here has been executed.**

## 1. Method-by-method

| `window.DLT` today | Server | Client contract |
|---|---|---|
| `trips.listPublic(days)` | `GET /trips?days=` | **Changes:** synchronous → promise. |
| `trips.get(id)` | `GET /trips/:id` | **Changes:** synchronous → promise. Called inside `renderVals()` today. |
| `trips.seatMap(id)` | `GET /trips/:id/seats` | **Changes.** Now also returns `held` — the caller's own basket — so the client stops deriving it. |
| `trips.myHeld(id)` | included in the response above | Fold into the seat-map load; one request, one consistent snapshot. |
| `seats.hold(tripId, seat)` | `POST /trips/:id/seats/:seatNumber/hold` | *Shape unchanged.* Now **409 CONFLICT** when another device won. The client must show that, not retry silently. |
| `seats.release(tripId, seat)` | `DELETE .../hold` | Returns `reason: 'RELEASED_BY_STUDENT'` — F-20, so the UI never shows the expiry screen for a deliberate removal. |
| `seats.releaseMine(tripId)` | `DELETE /trips/:id/holds` | Same. |
| `waitlist.join(tripId)` | `POST /trips/:id/waitlist` | *Unchanged in shape.* |
| `waitlist.mine()` | `GET /waitlist/mine` | **Changes:** async. |
| `waitlist.claim(entryId)` | `POST /waitlist/:id/claim` | *Unchanged in shape.* |
| `waitlist.decline(entryId)` | `POST /waitlist/:id/decline` | *Unchanged.* |
| the in-page hold sweeper timer | server-side `sweepExpiredHolds()` + `trip_seat_view` | **Delete the client timer.** It was authority the browser should never have had. |

## 2. What moved into the database

| Rule | Where it lives now |
|---|---|
| One holder per seat | `hold_seat()` — `SELECT … FOR UPDATE` on the seat row |
| One allocation per seat | `allocate_seat_to_booking()` + `trip_seats_one_booking_per_seat` |
| A late settlement cannot resurrect an abandoned booking (F-01) | `allocate_seat_to_booking()` refuses `ABANDONED` |
| Hold expiry | `sweep_expired_holds()` + `trip_seat_view`, which reports a lapsed hold as available immediately |
| Guest holds (F-09) and adoption on sign-in (F-08) | `hold_guest_token`, adopted in `signIn` |
| Deliberate release ≠ expiry (F-20) | `release_seat()` returns a distinct reason |
| Waitlist offer reserves a real seat (F-02) | `offer_seat_to_waitlist()` + `waitlist_one_offer_per_seat` |
| Claim / decline / expire-and-re-offer | `claim_waitlist_offer()`, `decline_waitlist_offer()`, `expire_waitlist_offers()` |
| Basket cap of 4 | checked inside the hold transaction, not in the client |

## 3. Concurrency strategy, in one paragraph

Every seat is a row. Every contended operation takes `SELECT … FOR UPDATE` on
that row before it decides anything, so competing transactions serialise on the
lock rather than racing between a read and a write. The loser reads the
committed new state and raises `unique_violation`, which the domain maps to a
409 the client can act on. Two declarative backstops catch any future code path
that forgets the function: `trip_seats_unique_seat` and the partial unique index
`trip_seats_one_booking_per_seat`. The waitlist uses `FOR UPDATE SKIP LOCKED` so
parallel offer runs take different entries instead of blocking, with
`waitlist_one_offer_per_seat` as its backstop.

Nothing about this depends on there being one server, one process, or one tab.

## 4. Client work this creates

1. **Seat map polling.** The prototype re-rendered on a synchronous store
   broadcast. Poll `GET /trips/:id/seats` every ~5s while the seat step is open,
   or add SSE. Seat maps and the boarding manifest are the only two surfaces
   that genuinely need this.
2. **Handle 409 on hold.** Today a failed hold throws and the screen shows a
   toast. It should now also refresh the seat map, because a 409 means the map
   on screen is stale.
3. **Hold countdown from the server clock.** `holdExpiresAt` comes from
   Postgres; render the countdown from it rather than from a client-started
   timer, and refetch on expiry instead of mutating local state.
4. **Delete the in-page sweeper.**

## 5. Not in this phase

- `POST /bookings` and everything downstream — Phase 4.
- `convert_waitlist_entry()` is written but has no caller until booking
  confirmation exists.
- No SSE yet; polling is the assumed interim.
