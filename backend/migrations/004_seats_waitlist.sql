-- DLT · 004 · guest holds, seat release, waitlist claim
--
-- 002 established atomic allocation for authenticated holders. Three things it
-- did not cover are needed before the trips/seats API can be honest:
--
--   1. GUEST HOLDS. UX §4 and the booking copy promise seats can be picked
--      without an account (F-09). A hold therefore needs an owner that is not
--      yet a user, and sign-in adopts it (F-08).
--   2. RELEASE. Deliberate release must be distinguishable from expiry, because
--      the student is told different things (F-20).
--   3. WAITLIST CLAIM. F-02: the prototype could offer a seat and had no way to
--      accept one. The offer already reserves the seat in 002; this adds the
--      accept and decline sides.

BEGIN;

-- ---------------------------------------------------------------- guest holds

DROP FUNCTION IF EXISTS hold_seat(uuid, text, uuid, interval);

-- Exactly one of p_user_id / p_guest_token identifies the holder. Everything
-- else is 002's logic unchanged: lock the row, then decide.
CREATE FUNCTION hold_seat(
  p_trip_id     uuid,
  p_seat_number text,
  p_user_id     uuid,
  p_guest_token text DEFAULT NULL,
  p_ttl         interval DEFAULT interval '10 minutes'
) RETURNS trip_seats AS $$
DECLARE
  s trip_seats;
  t trips;
  mine boolean;
BEGIN
  IF (p_user_id IS NULL) = (p_guest_token IS NULL) THEN
    RAISE EXCEPTION 'a hold needs exactly one holder: a user or a guest token'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

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
    FOR UPDATE;                        -- the serialisation point
  IF NOT FOUND THEN
    RAISE EXCEPTION 'seat % is not on this vehicle', p_seat_number
      USING ERRCODE = 'no_data_found';
  END IF;

  IF s.status = 'HELD' AND s.hold_expires_at <= now() THEN
    s.status := 'AVAILABLE'; s.hold_by := NULL;
    s.hold_guest_token := NULL; s.hold_expires_at := NULL;
  END IF;

  mine := s.status = 'HELD' AND (
    (p_user_id IS NOT NULL AND s.hold_by = p_user_id) OR
    (p_guest_token IS NOT NULL AND s.hold_guest_token = p_guest_token));

  IF mine THEN
    -- renewal: §12 lets a student extend the basket they already hold
    UPDATE trip_seats SET hold_expires_at = now() + p_ttl, updated_at = now()
      WHERE id = s.id RETURNING * INTO s;
    RETURN s;
  END IF;

  IF s.status <> 'AVAILABLE' THEN
    RAISE EXCEPTION 'seat % is %', p_seat_number, lower(s.status::text)
      USING ERRCODE = 'unique_violation';   -- the losing racer lands here
  END IF;

  UPDATE trip_seats
     SET status = 'HELD', hold_by = p_user_id, hold_guest_token = p_guest_token,
         hold_expires_at = now() + p_ttl, booking_id = NULL, updated_at = now()
   WHERE id = s.id
  RETURNING * INTO s;
  RETURN s;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- release
--
-- F-20: a deliberate release is not an expiry. This function only ever releases
-- a seat the caller actually holds, so one student cannot free another's seat.

CREATE FUNCTION release_seat(
  p_trip_id uuid, p_seat_number text, p_user_id uuid, p_guest_token text DEFAULT NULL
) RETURNS boolean AS $$
DECLARE s trip_seats;
BEGIN
  SELECT * INTO s FROM trip_seats
    WHERE trip_id = p_trip_id AND seat_number = p_seat_number FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF s.status <> 'HELD' THEN RETURN false; END IF;
  IF NOT ((p_user_id IS NOT NULL AND s.hold_by = p_user_id) OR
          (p_guest_token IS NOT NULL AND s.hold_guest_token = p_guest_token)) THEN
    RETURN false;                       -- not yours; say nothing about whose it is
  END IF;

  UPDATE trip_seats
     SET status = 'AVAILABLE', hold_by = NULL, hold_guest_token = NULL,
         hold_expires_at = NULL, updated_at = now()
   WHERE id = s.id;
  RETURN true;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION release_all_held(
  p_trip_id uuid, p_user_id uuid, p_guest_token text DEFAULT NULL
) RETURNS int AS $$
DECLARE n int;
BEGIN
  WITH freed AS (
    UPDATE trip_seats
       SET status = 'AVAILABLE', hold_by = NULL, hold_guest_token = NULL,
           hold_expires_at = NULL, updated_at = now()
     WHERE trip_id = p_trip_id AND status = 'HELD'
       AND ((p_user_id IS NOT NULL AND hold_by = p_user_id)
         OR (p_guest_token IS NOT NULL AND hold_guest_token = p_guest_token))
    RETURNING id
  ) SELECT count(*) INTO n FROM freed;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- waitlist claim
--
-- F-02, the missing half. 002's offer_seat_to_waitlist reserves a real seat for
-- the offered student for 30 minutes. This is how they take it — and how the
-- seat goes back if they do not.

CREATE FUNCTION claim_waitlist_offer(p_entry_id uuid, p_user_id uuid)
RETURNS trip_seats AS $$
DECLARE e waitlist_entries; s trip_seats;
BEGIN
  SELECT * INTO e FROM waitlist_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that waitlist entry does not exist' USING ERRCODE = 'no_data_found';
  END IF;
  IF e.user_id <> p_user_id THEN
    RAISE EXCEPTION 'that offer belongs to another student' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF e.status <> 'CLAIM_OFFERED' THEN
    RAISE EXCEPTION 'there is no open offer on this entry (it is %)', lower(e.status::text)
      USING ERRCODE = 'check_violation';
  END IF;
  IF e.offer_expires_at <= now() THEN
    RAISE EXCEPTION 'that offer expired at %', e.offer_expires_at
      USING ERRCODE = 'check_violation';
  END IF;

  -- the reserved seat becomes an ordinary hold, so the student finishes through
  -- the normal booking flow with the normal 10-minute basket
  SELECT * INTO s FROM trip_seats WHERE id = e.reserved_seat_id FOR UPDATE;
  IF NOT FOUND OR s.status <> 'HELD' OR s.hold_by <> p_user_id THEN
    RAISE EXCEPTION 'the seat reserved for you is no longer available'
      USING ERRCODE = 'unique_violation';
  END IF;

  UPDATE trip_seats SET hold_expires_at = now() + interval '10 minutes', updated_at = now()
    WHERE id = s.id RETURNING * INTO s;
  UPDATE waitlist_entries SET status = 'CLAIMED', updated_at = now() WHERE id = e.id;
  RETURN s;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION decline_waitlist_offer(p_entry_id uuid, p_user_id uuid)
RETURNS boolean AS $$
DECLARE e waitlist_entries;
BEGIN
  SELECT * INTO e FROM waitlist_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND OR e.user_id <> p_user_id OR e.status <> 'CLAIM_OFFERED' THEN
    RETURN false;
  END IF;
  UPDATE trip_seats
     SET status = 'AVAILABLE', hold_by = NULL, hold_expires_at = NULL, updated_at = now()
   WHERE id = e.reserved_seat_id;
  UPDATE waitlist_entries
     SET status = 'CANCELLED', reserved_seat_id = NULL, updated_at = now()
   WHERE id = e.id;
  PERFORM offer_seat_to_waitlist(e.trip_id);   -- straight to the next student
  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- A claimed entry converts when the booking confirms. Called from the booking
-- domain, kept here so every waitlist state transition is in one file.
CREATE FUNCTION convert_waitlist_entry(p_user_id uuid, p_trip_id uuid, p_booking_id uuid)
RETURNS boolean AS $$
DECLARE n int;
BEGIN
  UPDATE waitlist_entries
     SET status = 'CONVERTED', booking_id = p_booking_id, updated_at = now()
   WHERE user_id = p_user_id AND trip_id = p_trip_id AND status = 'CLAIMED';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- seat map read
--
-- One statement for the whole seat map, so a read cannot see a half-swept trip.
-- Expired holds are reported as AVAILABLE even before the sweeper runs: the
-- prototype's seat maps showed lapsed holds as taken until a timer fired.

CREATE VIEW trip_seat_view AS
  SELECT ts.id, ts.trip_id, ts.seat_number, ts.seat_row, ts.seat_type,
         CASE WHEN ts.status = 'HELD' AND ts.hold_expires_at <= now()
              THEN 'AVAILABLE'::seat_status ELSE ts.status END AS status,
         ts.booking_id, ts.hold_by, ts.hold_guest_token, ts.hold_expires_at,
         ts.block_reason
    FROM trip_seats ts;

INSERT INTO schema_migrations (filename) VALUES ('004_seats_waitlist.sql');

COMMIT;
