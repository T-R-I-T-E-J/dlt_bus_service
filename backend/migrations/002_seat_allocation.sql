-- DLT · 002 · atomic seat allocation, hold sweep, waitlist offer
--
-- These are the operations Data Model Spec §4 calls mandatory. They live in the
-- database rather than the application because the ordering guarantees they
-- depend on are lock guarantees, and an application that forgets to take the
-- lock in the right order produces exactly the defect this audit reproduced:
-- two confirmed bookings and two valid passes on one seat.
--
-- The application still owns policy (who may hold, how long, what a fare is).
-- These functions own only the part that must be indivisible.

BEGIN;

-- ---------------------------------------------------------------- seat hold
--
-- Takes a row lock on the seat, then decides. Two devices racing for 2B
-- serialise on the FOR UPDATE; the loser reads the committed new status and
-- gets false. No application-level check-then-act window exists.
--
-- Returns the seat row on success. Raises on a seat that cannot be held, so a
-- caller inside a transaction aborts cleanly rather than continuing on a lie.

CREATE OR REPLACE FUNCTION hold_seat(
  p_trip_id     uuid,
  p_seat_number text,
  p_user_id     uuid,
  p_ttl         interval DEFAULT interval '10 minutes'
) RETURNS trip_seats AS $$
DECLARE
  s trip_seats;
  t trips;
BEGIN
  SELECT * INTO t FROM trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trip % not found', p_trip_id USING ERRCODE = 'no_data_found';
  END IF;
  IF t.status <> 'OPEN' THEN
    RAISE EXCEPTION 'trip is % — seats can only be held while booking is open', t.status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO s FROM trip_seats
    WHERE trip_id = p_trip_id AND seat_number = p_seat_number
    FOR UPDATE;                       -- the whole point of this function
  IF NOT FOUND THEN
    RAISE EXCEPTION 'seat % is not on this vehicle', p_seat_number
      USING ERRCODE = 'no_data_found';
  END IF;

  -- an expired hold is free, whoever it belonged to
  IF s.status = 'HELD' AND s.hold_expires_at <= now() THEN
    s.status := 'AVAILABLE'; s.hold_by := NULL; s.hold_expires_at := NULL;
  END IF;

  IF s.status = 'HELD' AND s.hold_by = p_user_id THEN
    UPDATE trip_seats SET hold_expires_at = now() + p_ttl, updated_at = now()
      WHERE id = s.id RETURNING * INTO s;
    RETURN s;                                    -- extending your own hold
  END IF;

  IF s.status <> 'AVAILABLE' THEN
    RAISE EXCEPTION 'seat % is %', p_seat_number, lower(s.status::text)
      USING ERRCODE = 'unique_violation';        -- the losing racer lands here
  END IF;

  UPDATE trip_seats
     SET status = 'HELD', hold_by = p_user_id,
         hold_expires_at = now() + p_ttl, booking_id = NULL, updated_at = now()
   WHERE id = s.id
  RETURNING * INTO s;
  RETURN s;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- allocation
--
-- F-01. The defect: a payment landing after the hold lapsed called finalise,
-- which wrote BOOKED over whatever the seat currently was — including a seat
-- another student had already bought. This function is the only way a seat
-- becomes BOOKED, and it refuses any seat that is not still ours.

CREATE OR REPLACE FUNCTION allocate_seat_to_booking(
  p_trip_seat_id uuid,
  p_booking_id   uuid
) RETURNS trip_seats AS $$
DECLARE
  s trip_seats;
  b bookings;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking % not found', p_booking_id USING ERRCODE = 'no_data_found';
  END IF;

  -- F-01: a booking the sweeper already abandoned must never be finalised by a
  -- late settlement. The money is recorded and refunded by the caller instead.
  IF b.status IN ('ABANDONED','CANCELLED_BY_STUDENT','CANCELLED_BY_DLT') THEN
    RAISE EXCEPTION 'booking % is % — a late settlement cannot resurrect it', b.code, b.status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO s FROM trip_seats WHERE id = p_trip_seat_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'seat row % not found', p_trip_seat_id USING ERRCODE = 'no_data_found';
  END IF;

  -- already ours and settled: idempotent re-entry, which §5 requires
  IF s.status = 'BOOKED' AND s.booking_id = p_booking_id THEN
    RETURN s;
  END IF;

  -- the seat must still be held BY THIS BOOKING'S OWNER, or genuinely free.
  -- Anything else means someone else has it, and we do not take it from them.
  IF NOT (
    (s.status = 'HELD' AND s.hold_by IS NOT DISTINCT FROM b.user_id AND s.hold_expires_at > now())
    OR s.status = 'AVAILABLE'
  ) THEN
    RAISE EXCEPTION 'seat % is no longer available to booking % (seat is %)',
      s.seat_number, b.code, lower(s.status::text)
      USING ERRCODE = 'unique_violation';
  END IF;

  UPDATE trip_seats
     SET status = 'BOOKED', booking_id = p_booking_id,
         hold_by = NULL, hold_expires_at = NULL, updated_at = now()
   WHERE id = s.id
  RETURNING * INTO s;
  RETURN s;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- sweep
--
-- Releases lapsed holds and abandons the bookings behind them. Runs as a job on
-- a short interval AND opportunistically before a seat map read, so a student
-- never sees a seat that is actually free shown as taken.

CREATE OR REPLACE FUNCTION sweep_expired_holds() RETURNS TABLE (
  seats_released int, bookings_abandoned int
) AS $$
DECLARE
  n_seats int; n_bookings int;
BEGIN
  WITH lapsed AS (
    UPDATE trip_seats
       SET status = 'AVAILABLE', hold_by = NULL, hold_expires_at = NULL,
           booking_id = NULL, updated_at = now()
     WHERE status = 'HELD' AND hold_expires_at <= now()
    RETURNING id
  ) SELECT count(*) INTO n_seats FROM lapsed;

  WITH gone AS (
    UPDATE bookings
       SET status = 'ABANDONED', updated_at = now()
     WHERE status IN ('PENDING','PAYMENT_PENDING')
       AND hold_expires_at IS NOT NULL AND hold_expires_at <= now()
    RETURNING id
  ) SELECT count(*) INTO n_bookings FROM gone;

  RETURN QUERY SELECT n_seats, n_bookings;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- waitlist
--
-- F-02. A released seat is RESERVED for the offered student for the claim
-- window — not merely announced. waitlist_one_offer_per_seat guarantees two
-- students are never offered the same seat.

CREATE OR REPLACE FUNCTION offer_seat_to_waitlist(p_trip_id uuid)
RETURNS waitlist_entries AS $$
DECLARE
  e waitlist_entries;
  s trip_seats;
BEGIN
  SELECT * INTO e FROM waitlist_entries
    WHERE trip_id = p_trip_id AND status = 'WAITING'
    ORDER BY position, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO s FROM trip_seats
    WHERE trip_id = p_trip_id AND status = 'AVAILABLE'
    ORDER BY seat_row, seat_number
    FOR UPDATE SKIP LOCKED
    LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- the seat leaves the sale for the duration of the offer
  UPDATE trip_seats
     SET status = 'HELD', hold_by = e.user_id,
         hold_expires_at = now() + interval '30 minutes', updated_at = now()
   WHERE id = s.id;

  UPDATE waitlist_entries
     SET status = 'CLAIM_OFFERED', reserved_seat_id = s.id,
         offered_at = now(), offer_expires_at = now() + interval '30 minutes',
         updated_at = now()
   WHERE id = e.id
  RETURNING * INTO e;
  RETURN e;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION expire_waitlist_offers() RETURNS int AS $$
DECLARE
  n int := 0;
  e waitlist_entries;
BEGIN
  FOR e IN
    SELECT * FROM waitlist_entries
     WHERE status = 'CLAIM_OFFERED' AND offer_expires_at <= now()
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE trip_seats
       SET status = 'AVAILABLE', hold_by = NULL, hold_expires_at = NULL, updated_at = now()
     WHERE id = e.reserved_seat_id;
    UPDATE waitlist_entries
       SET status = 'EXPIRED', reserved_seat_id = NULL, updated_at = now()
     WHERE id = e.id;
    PERFORM offer_seat_to_waitlist(e.trip_id);   -- pass it to the next in line
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- seat map
--
-- Materialises a trip's seats from its vehicle. Called when a trip is created
-- or its vehicle changes; refuses to renumber seats that are already sold.

CREATE OR REPLACE FUNCTION materialise_trip_seats(p_trip_id uuid) RETURNS int AS $$
DECLARE
  v vehicles; r int; c text; n int := 0; sold int;
BEGIN
  SELECT vh.* INTO v FROM trips t JOIN vehicles vh ON vh.id = t.vehicle_id
    WHERE t.id = p_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trip % has no vehicle', p_trip_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT count(*) INTO sold FROM trip_seats
    WHERE trip_id = p_trip_id AND status IN ('BOOKED','HELD');
  IF sold > 0 THEN
    RAISE EXCEPTION 'cannot rebuild the seat map: % seats are already held or booked', sold
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM trip_seats WHERE trip_id = p_trip_id;
  FOR r IN 1..v.row_count LOOP
    FOREACH c IN ARRAY ARRAY['A','B','C','D'] LOOP
      INSERT INTO trip_seats (trip_id, seat_number, seat_row, seat_type)
      VALUES (p_trip_id, r::text || c, r,
              CASE WHEN c IN ('A','D') THEN 'WINDOW'::seat_type ELSE 'AISLE'::seat_type END);
      n := n + 1;
    END LOOP;
  END LOOP;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (filename) VALUES ('002_seat_allocation.sql');

COMMIT;
