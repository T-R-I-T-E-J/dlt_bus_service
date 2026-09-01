# Concurrency test — two sessions, one seat

The defect this audit reproduced (F-01) was two confirmed bookings and two valid
passes on seat 2B. A single-session SQL file cannot prove that is now impossible,
because the whole question is what happens when two transactions overlap. This
needs two real connections.

**NOT YET EXECUTED — this environment has no PostgreSQL.** Run it before
believing the constraint works.

## Setup

```
createdb dlt_test
psql dlt_test -f migrations/001_init.sql -f migrations/002_seat_allocation.sql
psql dlt_test -f test/fixtures.sql          # users A and B, one OPEN trip, 44 seats
```

Open two terminals, both `psql dlt_test`. Call them **A** and **B**.

## Test 1 — two devices reach for the same seat

| Step | Session A | Session B | Expected |
|---|---|---|---|
| 1 | `BEGIN;` | | |
| 2 | `SELECT hold_seat(:trip,'2B',:userA);` | | returns HELD |
| 3 | | `BEGIN;` | |
| 4 | | `SELECT hold_seat(:trip,'2B',:userB);` | **blocks** on A's row lock |
| 5 | `COMMIT;` | | |
| 6 | | *(unblocks)* | **raises** `seat 2B is held` |

The point of step 4 is that B waits rather than reading a stale value. If B
returned immediately with a successful hold, the `FOR UPDATE` is missing.

Then the reverse, to prove no deadlock and no leak:

| Step | Session A | Session B | Expected |
|---|---|---|---|
| 1 | `BEGIN; SELECT hold_seat(:trip,'3A',:userA);` | `BEGIN; SELECT hold_seat(:trip,'3B',:userB);` | both succeed — different rows, no contention |
| 2 | `ROLLBACK;` | `COMMIT;` | 3A free again, 3B held by B |

## Test 2 — the late settlement (F-01, the reproduced defect)

This is the exact sequence that produced two valid passes.

1. **A** holds 2B, creates booking `DLT-A`, status `PAYMENT_PENDING`.
2. Force the hold to lapse: `UPDATE bookings SET hold_expires_at = now() - interval '1 min' WHERE code='DLT-A'; UPDATE trip_seats SET hold_expires_at = now() - interval '1 min' WHERE seat_number='2B' AND trip_id=:trip;`
3. `SELECT * FROM sweep_expired_holds();` → 2B is `AVAILABLE`, `DLT-A` is `ABANDONED`.
4. **B** holds 2B, creates booking `DLT-B`, pays, and `allocate_seat_to_booking` succeeds. 2B is `BOOKED` by `DLT-B`.
5. **A's webhook finally lands.** Call `allocate_seat_to_booking(2B, DLT-A)`.

**Expected:** step 5 raises `booking DLT-A is ABANDONED — a late settlement
cannot resurrect it`. The seat still belongs to `DLT-B`.

**What the application must then do** (not the database's job): record A's
payment as `SUCCESS`, raise a refund for it, and create an operations alert. The
money arrived and must be given back; what must not happen is A getting a seat.

## Test 3 — the unique index is a real backstop

Bypass the function entirely and try to write the bad state directly:

```sql
-- with 2B already BOOKED by DLT-B
INSERT INTO trip_seats (trip_id, seat_number, seat_row, seat_type, status, booking_id)
VALUES (:trip, '2B', 2, 'AISLE', 'BOOKED', :bookingA);
```

**Expected:** `duplicate key value violates unique constraint
"trip_seats_unique_seat"`. This matters because it means a future code path that
forgets to call `allocate_seat_to_booking` still cannot double-allocate.

## Test 4 — waitlist offers do not collide

With one seat free and two students waiting:

| Session A | Session B | Expected |
|---|---|---|
| `BEGIN; SELECT offer_seat_to_waitlist(:trip);` | `BEGIN; SELECT offer_seat_to_waitlist(:trip);` | A gets the entry + seat; B returns `NULL` (SKIP LOCKED found no free seat) |

Never two students offered the same seat. `waitlist_one_offer_per_seat` is the
backstop if the `SKIP LOCKED` ordering is ever changed.

## Test 5 — duplicate webhook under concurrency

Both sessions insert the same `provider_event_id` simultaneously:

| Session A | Session B | Expected |
|---|---|---|
| `BEGIN; INSERT INTO provider_events (provider_event_id,kind,raw_body,signature_ok) VALUES ('cf_evt_9','PAYMENT_SUCCESS','{}',true);` | same statement | B blocks, then fails on `provider_events_unique` after A commits |

The webhook handler must treat that failure as success — the event is already
recorded — and return 200. A 500 here makes Cashfree retry forever.

## What to record

For each test, note whether the second session **blocked** (correct) or
**returned immediately** (the lock is missing). Blocking is the evidence; an
error message alone can also come from a check-then-act race that happened to
lose, which is not the same guarantee.
