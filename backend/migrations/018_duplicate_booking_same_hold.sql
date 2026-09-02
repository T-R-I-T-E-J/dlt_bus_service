-- DLT · 018 · a second booking on an already-booked-pending held seat
--
-- THE DEFECT, found under real failure-mode testing (simulating a browser
-- refresh mid-checkout: the client's in-memory idempotency key is lost on
-- refresh, so a retried POST /bookings carries a NEW key against seats the
-- SAME holder still legitimately holds):
--
--   1. POST /bookings (key A) -> booking #1 PAYMENT_PENDING, seat 4A HELD,
--      trip_seats.booking_id = #1
--   2. refresh
--   3. POST /bookings (key B), same holder, same still-held seat 4A
--      -> create_booking_from_holds's per-seat check only verified the seat
--         was HELD BY THIS HOLDER — never that it was already claimed by an
--         earlier booking of theirs. #2 is created, and trip_seats.booking_id
--         is silently overwritten to #2. #1 still exists, PAYMENT_PENDING,
--         referencing a seat it no longer actually owns.
--
-- Reproduced live against dlt_load_test: two distinct booking codes, one
-- seat, confirmed via trip_seats/booking_passengers inspection.
--
-- NOT a money-safety or seat-safety defect: settle_booking (005) already
-- refuses to confirm booking #1 if it is ever paid — REFUND_REQUIRED, since
-- trip_seats.booking_id no longer matches — the exact same guard F-01's fix
-- added for late settlement, just triggered by a different cause here. A
-- student can only ever be refunded, never end up on a seat a stranger also
-- holds. #1 also self-resolves to ABANDONED once its own hold_expires_at
-- lapses (independent of the seat's current owner), so nothing leaks
-- forever. What was real: a needless duplicate PAYMENT_PENDING row, a
-- second Razorpay checkout the student could confusingly still have open in
-- an old tab, and a #1 that would refund rather than pay if used.
--
-- Fix: refuse the second attempt with a clear, actionable CONFLICT instead
-- of silently orphaning the first booking. The client already has a real
-- path forward on CONFLICT — GET /bookings/mine finds the original pending
-- booking to resume, rather than the student paying into one that can only
-- ever refund.
--
-- SELF-CAUGHT REGRESSION, fixed before this migration was ever committed:
-- the first draft of this function body was copied from 009's version,
-- which predates 012 ("the booking cap is 5 passengers, not 4") — it would
-- have silently reverted the passenger cap from 5 back to 4. Caught by
-- running the full suite after this change, exactly as required before
-- calling any fix done; test/payments.test.ts's and
-- test/seats.concurrency.test.ts's §12 cap tests failed immediately and
-- pointed straight at it. The body below is 012's, with only this
-- migration's one addition (the booking_id check) layered on.

BEGIN;

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

  FOR p IN SELECT * FROM jsonb_array_elements(p_passengers) LOOP
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

    -- THE FIX: this seat is legitimately still held by this holder, but an
    -- earlier booking of theirs may already have claimed it (a retried
    -- checkout after a refresh, most commonly). Refuse rather than silently
    -- reassign it out from under that booking.
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

INSERT INTO schema_migrations (filename) VALUES ('018_duplicate_booking_same_hold.sql');

COMMIT;
