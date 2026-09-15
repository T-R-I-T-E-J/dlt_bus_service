-- DLT · 019 · settle seat by seat; refund only the seats that are gone
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THREE SEPARATE DEFECTS, all reached from the same production incident
-- (auto-refunds, reason "Payment arrived after the seats were released").
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. ALL-OR-NOTHING SETTLEMENT. 005's settle_booking returned REFUND_REQUIRED
--    the moment ONE seat was no longer ours, so a four-seat booking that lost
--    one seat had all four refunded. New code calls settle_booking_v2, which
--    claims every seat it still can and refunds only what it could not get.
--
-- 2. release_seat / release_all_held (004) set status='AVAILABLE' while
--    leaving booking_id set, which the constraint tightened by 003 rejects:
--
--      new row for relation "trip_seats" violates check constraint
--      "trip_seats_allocation_coherent"
--
--    Three 500s in production (seats 7A, 7B, 7B again one second later). 011
--    fixed this class for sweep_expired_holds and asserted in its own header
--    that "release_seat, release_all_held … already clear it". They do not:
--    they clear hold_guest_token, never booking_id. A seat carries booking_id
--    from the moment create_booking_from_holds runs, so every student who
--    reached the payment step and then removed a seat hit a 500.
--
-- 3. DEADLOCKS. Four in two hours on trip_seats, between holdSeat's basket-cap
--    lock and hold_seat()'s own row lock. Every path that locks more than one
--    seat row did so in an arbitrary order. This migration fixes the SQL half;
--    seats.ts fixes the application half.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- CANONICAL LOCK ORDER — the invariant this migration introduces
-- ─────────────────────────────────────────────────────────────────────────────
--
--   Any transaction locking more than one trip_seats row for a trip MUST take
--   them in ascending seat_number order.
--
-- seat_number is UNIQUE per trip (trip_seats_unique_seat), so within the one
-- trip these operations touch it is a total order, and a total order shared by
-- every path is what makes a deadlock between them impossible. Enforced here in
-- create_booking_from_holds, settle_booking_v2 and release_all_held; and in
-- seats.ts holdSeat, which is the other multi-row locker.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS DELIBERATELY *NOT* CHANGED
-- ─────────────────────────────────────────────────────────────────────────────
--
-- · AN ABANDONED BOOKING IS NEVER RESURRECTED. A lapsed hold still refunds in
--   full, exactly as before. Reclaiming one would let a Razorpay checkout left
--   open in an old tab be paid hours later and confirm a second booking the
--   student never wanted, charged twice. The fix for a hold that lapses mid-
--   payment is to stop it lapsing (the bounded extension in createCheckout),
--   not to raise the booking from the dead.
--
-- · bookings.total_amount IS NOT REWRITTEN on a partial settlement. This
--   codebase's convention, stated at the amount-mismatch branch in
--   payments.ts, is that total_amount is the figure ORDERED and the ledger
--   (payments.amount, refunds.amount) records what actually moved. booking_money
--   already reports the truth: received − returned. Rewriting total_amount
--   would also desynchronise it from the passenger COUNT that price_check and
--   accept_reprice divide by.
--
-- · F-01 IS UNTOUCHED. A seat is claimable only when it is AVAILABLE or
--   already ours. A seat BOOKED or HELD by another booking, or BLOCKED, is
--   never taken. That per-seat rule — not the booking-status check — is what
--   has always prevented two students on one seat.
--
-- · NO REPAIR UPDATE. Rows stranded by defect 2 (AVAILABLE while still
--   carrying booking_id) are NOT rewritten here. Count them first:
--
--     SELECT count(*) FROM trip_seats
--      WHERE status = 'AVAILABLE' AND booking_id IS NOT NULL;
--
--   and repair them in a separate, reviewed migration once the number is known.

BEGIN;

-- ---------------------------------------------------------------- release

-- Clears booking_id (defect 2), and refuses rather than orphaning a booking
-- that is still payable — freeing that seat would leave the booking able only
-- to refund, which is the outcome this whole migration exists to reduce.
CREATE OR REPLACE FUNCTION release_seat(
  p_trip_id uuid, p_seat_number text, p_user_id uuid, p_guest_token text DEFAULT NULL
) RETURNS boolean AS $$
DECLARE s trip_seats; owner bookings;
BEGIN
  SELECT * INTO s FROM trip_seats
    WHERE trip_id = p_trip_id AND seat_number = p_seat_number FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF s.status <> 'HELD' THEN RETURN false; END IF;
  IF NOT ((p_user_id IS NOT NULL AND s.hold_by = p_user_id) OR
          (p_guest_token IS NOT NULL AND s.hold_guest_token = p_guest_token)) THEN
    RETURN false;                       -- not yours; say nothing about whose it is
  END IF;

  IF s.booking_id IS NOT NULL THEN
    SELECT * INTO owner FROM bookings WHERE id = s.booking_id;
    -- unique_violation so seats.ts mapSeatError renders it as a 409 CONFLICT,
    -- never a 500. The message names the booking so the client can offer it.
    IF FOUND AND owner.status IN ('PENDING','PAYMENT_PENDING')
       AND owner.hold_expires_at IS NOT NULL AND owner.hold_expires_at > now() THEN
      RAISE EXCEPTION 'seat % belongs to your pending booking % — cancel that booking first, then choose seats again',
        p_seat_number, owner.code
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  UPDATE trip_seats
     SET status = 'AVAILABLE', hold_by = NULL, hold_guest_token = NULL,
         hold_expires_at = NULL, booking_id = NULL, updated_at = now()
   WHERE id = s.id;
  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Set-based, so a seat owned by a live booking is SKIPPED rather than failing
-- the batch. Locks in canonical seat_number order.
CREATE OR REPLACE FUNCTION release_all_held(
  p_trip_id uuid, p_user_id uuid, p_guest_token text DEFAULT NULL
) RETURNS int AS $$
DECLARE n int;
BEGIN
  WITH target AS (
    SELECT ts.id FROM trip_seats ts
     WHERE ts.trip_id = p_trip_id AND ts.status = 'HELD'
       AND ((p_user_id IS NOT NULL AND ts.hold_by = p_user_id)
         OR (p_guest_token IS NOT NULL AND ts.hold_guest_token = p_guest_token))
       AND NOT EXISTS (
         SELECT 1 FROM bookings b
          WHERE b.id = ts.booking_id
            AND b.status IN ('PENDING','PAYMENT_PENDING')
            AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at > now())
     ORDER BY ts.seat_number
     FOR UPDATE
  ), freed AS (
    UPDATE trip_seats
       SET status = 'AVAILABLE', hold_by = NULL, hold_guest_token = NULL,
           hold_expires_at = NULL, booking_id = NULL, updated_at = now()
     WHERE id IN (SELECT id FROM target)
    RETURNING id
  ) SELECT count(*) INTO n FROM freed;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- creation

-- 018's body verbatim, with ONE change: the per-seat loop is ordered by seat
-- number, so this path takes its locks in the canonical order (defect 3).
CREATE OR REPLACE FUNCTION create_booking_from_holds(
  p_trip_id       uuid,
  p_user_id       uuid,
  p_guest_token   text,
  p_contact_phone text,
  p_passengers    jsonb,
  p_hold_ttl      interval DEFAULT interval '10 minutes'
) RETURNS bookings AS $$
DECLARE
  t trips; b bookings; p jsonb; s trip_seats; price int; existing bookings;
BEGIN
  SELECT * INTO t FROM trips WHERE id = p_trip_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trip not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF t.status <> 'OPEN' THEN
    RAISE EXCEPTION 'that departure is no longer taking bookings' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_array_length(p_passengers) = 0 THEN
    RAISE EXCEPTION 'a booking needs at least one passenger' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_array_length(p_passengers) > 5 THEN
    RAISE EXCEPTION 'up to 5 passengers in one booking' USING ERRCODE = 'check_violation';
  END IF;
  IF (p_user_id IS NULL) = (p_guest_token IS NULL) THEN
    RAISE EXCEPTION 'a booking needs exactly one holder: a user or a guest token'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  price := t.price;

  INSERT INTO bookings (code, boarding_code, trip_id, user_id, guest_token, status, kind,
                        unit_price, total_amount, contact_phone, hold_expires_at)
  VALUES (new_booking_code(), new_boarding_code(), p_trip_id, p_user_id, p_guest_token,
          'PAYMENT_PENDING', 'ONLINE',
          price, price * jsonb_array_length(p_passengers), p_contact_phone,
          now() + p_hold_ttl)
  RETURNING * INTO b;

  -- CANONICAL LOCK ORDER (see header). The client sends passengers in whatever
  -- order the seat map produced; locking in that order let two concurrent
  -- bookings take the same two seats in opposite orders and deadlock.
  FOR p IN SELECT value FROM jsonb_array_elements(p_passengers)
            ORDER BY value->>'seatNumber'
  LOOP
    SELECT * INTO s FROM trip_seats
      WHERE trip_id = p_trip_id AND seat_number = (p->>'seatNumber')
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'seat % is not on this vehicle', (p->>'seatNumber')
        USING ERRCODE = 'no_data_found';
    END IF;
    -- positive match on both sides, same rule as allocation
    IF s.status <> 'HELD' OR s.hold_expires_at <= now()
       OR NOT ((p_user_id IS NOT NULL AND s.hold_by = p_user_id)
            OR (p_guest_token IS NOT NULL AND s.hold_guest_token IS NOT NULL
                AND s.hold_guest_token = p_guest_token)) THEN
      RAISE EXCEPTION 'your hold on seat % has gone', (p->>'seatNumber')
        USING ERRCODE = 'unique_violation';
    END IF;

    -- 018: this seat is legitimately still held by this holder, but an earlier
    -- booking of theirs may already have claimed it (a retried checkout after a
    -- refresh). Refuse rather than silently reassign it out from under that one.
    IF s.booking_id IS NOT NULL THEN
      SELECT * INTO existing FROM bookings WHERE id = s.booking_id;
      IF FOUND AND existing.status = 'PAYMENT_PENDING' AND existing.hold_expires_at > now() THEN
        RAISE EXCEPTION 'you already have a pending booking (%) for seat % — finish or cancel it first',
          existing.code, (p->>'seatNumber')
          USING ERRCODE = 'unique_violation';
      END IF;
    END IF;

    INSERT INTO booking_passengers (booking_id, trip_seat_id, name, student_id,
                                    phone, seat_number, seat_type)
    VALUES (b.id, s.id, p->>'name', p->>'studentId', p->>'phone',
            s.seat_number, s.seat_type);

    UPDATE trip_seats SET booking_id = b.id, hold_expires_at = b.hold_expires_at,
                          updated_at = now()
      WHERE id = s.id;
  END LOOP;

  RETURN b;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- manifest

-- A CONFIRMED booking could not previously contain a CANCELLED passenger:
-- release_booking_seats cancels every passenger AND moves the booking out of
-- CONFIRMED at the same time, so `b.status = 'CONFIRMED'` was sufficient on its
-- own. PARTIAL settlement breaks that assumption for the first time — the
-- booking stands, one of its passengers does not.
--
-- Boarding staff work from this list. A passenger whose seat was lost and
-- refunded must not be on it: the headcount at the door would be wrong and
-- staff would go looking for somebody who was never coming. Their pass is
-- already VOID (scan_pass step 3 refuses it), so this closes the reporting half
-- of the same fact.
CREATE OR REPLACE FUNCTION trip_manifest(p_trip_id uuid, p_role user_role)
RETURNS TABLE (
  passenger_id uuid, name text, student_id text, seat_number text,
  seat_type seat_type, boarding_status boarding_state, booking_code text,
  boarding_code text, phone text, boarded_at timestamptz
) AS $$
  SELECT bp.id, bp.name, bp.student_id, bp.seat_number, bp.seat_type,
         bp.boarding_status, b.code, b.boarding_code,
         CASE WHEN p_role = 'BOARDING_STAFF' THEN NULL ELSE bp.phone END,
         (SELECT max(occurred_at) FROM boarding_events e
           WHERE e.passenger_id = bp.id AND e.result = 'VALID')
    FROM booking_passengers bp
    JOIN bookings b ON b.id = bp.booking_id
   WHERE b.trip_id = p_trip_id
     AND b.status = 'CONFIRMED'
     AND bp.boarding_status <> 'CANCELLED'
   ORDER BY bp.seat_row_order, bp.seat_number;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------- settlement

-- The return type gains the seat counts and the amount owed back, so the caller
-- can raise a PARTIAL refund. The original settle_booking(uuid,uuid) is kept
-- intact for migration-first deploy safety and rollback compatibility: old
-- deployed code can keep calling the scalar enum function while new code calls
-- this versioned function.
DROP FUNCTION IF EXISTS settle_booking_v2(uuid, uuid);

CREATE FUNCTION settle_booking_v2(p_booking_id uuid, p_payment_id uuid)
RETURNS TABLE (outcome text, seats_claimed int, seats_lost int, refund_amount int) AS $$
DECLARE
  b bookings; pax booking_passengers; s trip_seats; tok text;
  found_seat boolean; claimable boolean;
  n_claimed int := 0; n_lost int := 0;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- §5 idempotency: the same webhook twice is a no-op, not a second confirmation
  IF b.status = 'CONFIRMED' THEN
    RETURN QUERY SELECT 'ALREADY_CONFIRMED'::text, 0, 0, 0; RETURN;
  END IF;

  -- F-01, UNCHANGED. A booking that is dead stays dead: a lapsed hold refunds
  -- in full and is never reclaimed, so an old checkout paid later cannot
  -- confirm a duplicate booking the student did not want.
  IF b.status IN ('ABANDONED','CANCELLED_BY_STUDENT','CANCELLED_BY_DLT') THEN
    RETURN QUERY SELECT 'REFUND_REQUIRED'::text, 0, 0, 0; RETURN;
  END IF;

  -- CANONICAL LOCK ORDER (see header).
  FOR pax IN
    SELECT * FROM booking_passengers
     WHERE booking_id = b.id ORDER BY seat_number
  LOOP
    found_seat := false;
    IF pax.trip_seat_id IS NOT NULL THEN
      SELECT * INTO s FROM trip_seats WHERE id = pax.trip_seat_id FOR UPDATE;
      found_seat := FOUND;
    END IF;

    -- F-01: free, or already ours. Never anybody else's, never BLOCKED.
    claimable := found_seat AND (
         s.status = 'AVAILABLE'
      OR (s.status = 'HELD'   AND s.booking_id IS NOT DISTINCT FROM b.id)
      OR (s.status = 'BOOKED' AND s.booking_id = b.id));

    IF claimable THEN
      UPDATE trip_seats
         SET status = 'BOOKED', booking_id = b.id, hold_by = NULL,
             hold_guest_token = NULL, hold_expires_at = NULL, updated_at = now()
       WHERE id = s.id;

      -- one pass per passenger, ever (boarding_passes.passenger_id is UNIQUE)
      tok := 'dlt.' || encode(gen_random_bytes(14), 'hex');
      INSERT INTO boarding_passes (passenger_id, booking_id, trip_id, qr_token)
      VALUES (pax.id, b.id, b.trip_id, tok)
      ON CONFLICT (passenger_id) DO NOTHING;

      n_claimed := n_claimed + 1;
    ELSE
      -- Somebody else holds it. Cancel THIS passenger only; the rest stand.
      -- trip_seat_id is nulled so no view can present a seat that is not ours,
      -- and the pass is voided so it cannot scan at the door.
      UPDATE boarding_passes SET status = 'VOID', voided_at = now()
       WHERE passenger_id = pax.id AND status = 'VALID';
      UPDATE booking_passengers
         SET boarding_status = 'CANCELLED', trip_seat_id = NULL
       WHERE id = pax.id;
      n_lost := n_lost + 1;
    END IF;
  END LOOP;

  -- Nothing left to honour: full refund, booking is not confirmed.
  IF n_claimed = 0 THEN
    RETURN QUERY SELECT 'REFUND_REQUIRED'::text, 0, n_lost, 0; RETURN;
  END IF;

  -- At least one seat is genuinely theirs, so the booking stands on what it got.
  -- total_amount is deliberately left alone (see header).
  UPDATE bookings SET status = 'CONFIRMED', hold_expires_at = NULL, updated_at = now()
   WHERE id = b.id;
  PERFORM convert_waitlist_entry(b.user_id, b.trip_id, b.id);

  IF n_lost = 0 THEN
    RETURN QUERY SELECT 'CONFIRMED'::text, n_claimed, 0, 0;
  ELSE
    RETURN QUERY SELECT 'PARTIAL'::text, n_claimed, n_lost, b.unit_price * n_lost;
  END IF;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (filename) VALUES ('019_partial_settlement.sql');

COMMIT;
