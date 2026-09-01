-- DLT · 005 · bookings, payments, refunds
--
-- 001 created the tables. This migration adds the operations that must be
-- indivisible: creating a booking out of a basket of held seats, and settling a
-- payment. Both are here rather than in application code for the same reason
-- seat allocation is — the guarantee is a lock guarantee, and an application
-- that forgets the lock reintroduces the defect.

BEGIN;

-- ---------------------------------------------------------------- codes

-- DLT-40219 and WX3102. Collision is possible but vanishingly unlikely; the
-- UNIQUE constraints on bookings.code / boarding_code are the real guarantee
-- and the caller retries on 23505.
CREATE FUNCTION new_booking_code() RETURNS text AS $$
  SELECT 'DLT-' || lpad((floor(random() * 90000) + 10000)::int::text, 5, '0');
$$ LANGUAGE sql VOLATILE;

CREATE FUNCTION new_boarding_code() RETURNS text AS $$
  SELECT 'WX' || lpad((floor(random() * 9000) + 1000)::int::text, 4, '0');
$$ LANGUAGE sql VOLATILE;

-- ---------------------------------------------------------------- creation
--
-- Turns a basket of HELD seats into a PAYMENT_PENDING booking in one
-- transaction. The fare is frozen onto the booking here (F-03): a later change
-- to trips.price cannot silently alter what this student owes.

CREATE FUNCTION create_booking_from_holds(
  p_trip_id       uuid,
  p_user_id       uuid,
  p_guest_token   text,
  p_contact_phone text,
  p_passengers    jsonb,        -- [{seatNumber,name,studentId,phone}]
  p_hold_ttl      interval DEFAULT interval '10 minutes'
) RETURNS bookings AS $$
DECLARE
  t trips; b bookings; p jsonb; s trip_seats; n int := 0; price int;
BEGIN
  SELECT * INTO t FROM trips WHERE id = p_trip_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trip not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF t.status <> 'OPEN' THEN
    RAISE EXCEPTION 'that departure is no longer taking bookings'
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_array_length(p_passengers) = 0 THEN
    RAISE EXCEPTION 'a booking needs at least one passenger' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_array_length(p_passengers) > 4 THEN
    RAISE EXCEPTION 'up to 4 passengers in one booking' USING ERRCODE = 'check_violation';
  END IF;

  price := t.price;

  INSERT INTO bookings (code, boarding_code, trip_id, user_id, status, kind,
                        unit_price, total_amount, contact_phone, hold_expires_at)
  VALUES (new_booking_code(), new_boarding_code(), p_trip_id, p_user_id,
          'PAYMENT_PENDING', 'ONLINE',
          price, price * jsonb_array_length(p_passengers), p_contact_phone,
          now() + p_hold_ttl)
  RETURNING * INTO b;

  FOR p IN SELECT * FROM jsonb_array_elements(p_passengers) LOOP
    -- lock the seat and prove it is still this basket's before consuming it
    SELECT * INTO s FROM trip_seats
      WHERE trip_id = p_trip_id AND seat_number = (p->>'seatNumber')
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'seat % is not on this vehicle', (p->>'seatNumber')
        USING ERRCODE = 'no_data_found';
    END IF;
    IF s.status <> 'HELD' OR s.hold_expires_at <= now()
       OR NOT ((p_user_id IS NOT NULL AND s.hold_by = p_user_id)
            OR (p_guest_token IS NOT NULL AND s.hold_guest_token = p_guest_token)) THEN
      RAISE EXCEPTION 'your hold on seat % has gone', (p->>'seatNumber')
        USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO booking_passengers (booking_id, trip_seat_id, name, student_id,
                                    phone, seat_number, seat_type)
    VALUES (b.id, s.id, p->>'name', p->>'studentId', p->>'phone',
            s.seat_number, s.seat_type);

    -- the seat now belongs to the booking, still as a hold until payment lands
    UPDATE trip_seats SET booking_id = b.id, hold_expires_at = b.hold_expires_at,
                          updated_at = now()
      WHERE id = s.id;
    n := n + 1;
  END LOOP;

  RETURN b;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- settlement
--
-- F-01, the reproduced defect, closed at the lowest level. A settlement that
-- arrives after the hold lapsed must NOT confirm the booking and must NOT take
-- the seat back from whoever has it now. The money is real, so the caller
-- raises a refund; what cannot happen is a second person on one seat.
--
-- Returns the outcome so the caller knows which of the three paths ran.

CREATE TYPE settlement_outcome AS ENUM ('CONFIRMED','ALREADY_CONFIRMED','REFUND_REQUIRED');

CREATE FUNCTION settle_booking(p_booking_id uuid, p_payment_id uuid)
RETURNS settlement_outcome AS $$
DECLARE
  b bookings; pax booking_passengers; s trip_seats; tok text;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- §5 idempotency: the same webhook twice is a no-op, not a second confirmation
  IF b.status = 'CONFIRMED' THEN RETURN 'ALREADY_CONFIRMED'; END IF;

  IF b.status IN ('ABANDONED','CANCELLED_BY_STUDENT','CANCELLED_BY_DLT') THEN
    RETURN 'REFUND_REQUIRED';
  END IF;

  -- every seat must still be ours; allocate_seat_to_booking refuses otherwise
  FOR pax IN SELECT * FROM booking_passengers WHERE booking_id = b.id LOOP
    SELECT * INTO s FROM trip_seats WHERE id = pax.trip_seat_id FOR UPDATE;
    IF s IS NULL OR (s.status = 'BOOKED' AND s.booking_id <> b.id)
       OR (s.status = 'HELD' AND s.booking_id IS DISTINCT FROM b.id)
       OR s.status = 'BLOCKED' THEN
      RETURN 'REFUND_REQUIRED';         -- somebody else has it now
    END IF;
    UPDATE trip_seats
       SET status = 'BOOKED', booking_id = b.id, hold_by = NULL,
           hold_guest_token = NULL, hold_expires_at = NULL, updated_at = now()
     WHERE id = s.id;

    -- one pass per passenger, ever (boarding_passes.passenger_id is UNIQUE)
    tok := 'dlt.' || encode(gen_random_bytes(14), 'hex');
    INSERT INTO boarding_passes (passenger_id, booking_id, trip_id, qr_token)
    VALUES (pax.id, b.id, b.trip_id, tok)
    ON CONFLICT (passenger_id) DO NOTHING;
  END LOOP;

  UPDATE bookings SET status = 'CONFIRMED', hold_expires_at = NULL, updated_at = now()
    WHERE id = b.id;
  PERFORM convert_waitlist_entry(b.user_id, b.trip_id, b.id);
  RETURN 'CONFIRMED';
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- release
--
-- Cancellation and refund both free seats. One function, so the two paths
-- cannot drift apart, and so a freed seat always reaches the waitlist.

CREATE FUNCTION release_booking_seats(p_booking_id uuid, p_new_status booking_status)
RETURNS int AS $$
DECLARE n int; trip uuid;
BEGIN
  SELECT trip_id INTO trip FROM bookings WHERE id = p_booking_id;

  UPDATE booking_passengers SET boarding_status = 'CANCELLED' WHERE booking_id = p_booking_id;
  UPDATE boarding_passes SET status = 'VOID', voided_at = now()
    WHERE booking_id = p_booking_id AND status = 'VALID';

  WITH freed AS (
    UPDATE trip_seats
       SET status = 'AVAILABLE', booking_id = NULL, hold_by = NULL,
           hold_guest_token = NULL, hold_expires_at = NULL, updated_at = now()
     WHERE booking_id = p_booking_id
    RETURNING id
  ) SELECT count(*) INTO n FROM freed;

  UPDATE bookings SET status = p_new_status, updated_at = now() WHERE id = p_booking_id;
  IF n > 0 THEN PERFORM offer_seat_to_waitlist(trip); END IF;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- money view
--
-- F-05 / F-12. One definition of "how much is still refundable", used by the
-- policy path, the override path and the duplicate-payment path alike. The
-- refunds_within_receipts trigger in 001 is the enforcement; this is the
-- reading, so no caller has to compute it and get it subtly wrong.

CREATE VIEW booking_money AS
  SELECT b.id AS booking_id, b.code, b.total_amount,
         COALESCE(pin.received, 0)  AS received,
         COALESCE(rout.returned, 0) AS returned,
         GREATEST(COALESCE(pin.received,0) - COALESCE(rout.returned,0), 0) AS refundable
    FROM bookings b
    LEFT JOIN LATERAL (
      SELECT sum(amount)::int AS received FROM payments
       WHERE booking_id = b.id AND status IN ('SUCCESS','DUPLICATE')
    ) pin ON true
    LEFT JOIN LATERAL (
      SELECT sum(amount)::int AS returned FROM refunds
       WHERE booking_id = b.id AND status <> 'REFUND_FAILED'
    ) rout ON true;

-- ---------------------------------------------------------------- repricing
--
-- F-03, the reproduced defect. The prototype recomputed the total, wrote it,
-- then threw — and the throw rolled its own correction back, so the booking
-- could never be paid. Here the new price is PERSISTED and returned as data.
-- Nothing throws; the caller decides what to tell the student.

CREATE FUNCTION check_booking_price(p_booking_id uuid)
RETURNS TABLE (changed boolean, old_total int, new_total int) AS $$
DECLARE b bookings; t trips; seats int; fresh int;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
  SELECT * INTO t FROM trips WHERE id = b.trip_id;
  SELECT count(*)::int INTO seats FROM booking_passengers WHERE booking_id = b.id;
  fresh := t.price * seats;

  IF fresh = b.total_amount THEN
    RETURN QUERY SELECT false, b.total_amount, b.total_amount;
  ELSE
    UPDATE bookings SET reprice_pending_at = now(), reprice_to = fresh, updated_at = now()
      WHERE id = b.id;
    RETURN QUERY SELECT true, b.total_amount, fresh;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION accept_reprice(p_booking_id uuid) RETURNS bookings AS $$
DECLARE b bookings;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF b.reprice_to IS NULL THEN
    RAISE EXCEPTION 'there is no price change to accept' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE bookings
     SET total_amount = b.reprice_to,
         unit_price = b.reprice_to / GREATEST(
           (SELECT count(*)::int FROM booking_passengers WHERE booking_id = b.id), 1),
         reprice_to = NULL, reprice_pending_at = NULL, updated_at = now()
   WHERE id = b.id RETURNING * INTO b;
  -- any intent created against the old amount is now stale
  UPDATE payments SET status = 'CANCELLED', failure_reason = 'superseded by a price change',
                      updated_at = now()
   WHERE booking_id = b.id AND status IN ('CREATED','PENDING');
  RETURN b;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (filename) VALUES ('005_bookings_payments.sql');

COMMIT;
