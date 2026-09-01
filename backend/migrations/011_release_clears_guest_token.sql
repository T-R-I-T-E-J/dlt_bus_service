-- DLT · 011 · releasing a seat must clear hold_guest_token
--
-- THE DEFECT (found at runtime, not in review):
--
--   GET /api/trips returned 500 for every visitor, and the 30-second sweep job
--   threw on every cycle, as soon as any GUEST hold lapsed:
--
--     new row for relation "trip_seats" violates check constraint
--     "trip_seats_allocation_coherent"
--
-- 002 wrote sweep_expired_holds() before guest holds existed. 004 added
-- trip_seats.hold_guest_token, and 003 tightened the coherence constraint to
--
--     status = 'AVAILABLE' AND booking_id IS NULL
--                          AND hold_by IS NULL
--                          AND hold_guest_token IS NULL
--
-- but the release paths written BEFORE that column existed were never revisited.
-- They set status='AVAILABLE' and clear hold_by, and leave hold_guest_token set,
-- which the constraint now rejects.
--
-- Two consequences, both observed:
--   1. an expired guest hold can never be released — the seat leaks, held forever
--   2. sweep_expired_holds() is called inline by the public trip list, so the
--      product's first screen 500s once a single guest hold has lapsed
--
-- The functions written AFTER 004 (release_seat, release_all_held,
-- release_booking_seats) already clear it. This brings the older four in line.
-- Adding `hold_guest_token = NULL` where it is already NULL is a no-op, so the
-- paths that could not carry a guest token are unaffected.
--
-- Bodies are otherwise reproduced verbatim from the live definitions.

BEGIN;

-- 1. THE BROKEN ONE. Every lapsed guest hold hit this.
CREATE OR REPLACE FUNCTION sweep_expired_holds() RETURNS TABLE (
  seats_released int, bookings_abandoned int
) AS $$
DECLARE
  n_seats int; n_bookings int;
BEGIN
  WITH lapsed AS (
    UPDATE trip_seats
       SET status = 'AVAILABLE', hold_by = NULL, hold_guest_token = NULL,
           hold_expires_at = NULL, booking_id = NULL, updated_at = now()
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

-- 2. Latent: a waitlist offer is only made to a signed-in student, so the
--    reserved seat carries hold_by, not a guest token. Corrected anyway — the
--    invariant should not depend on which paths happen to be reachable today.
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
       SET status = 'AVAILABLE', hold_by = NULL, hold_guest_token = NULL,
           hold_expires_at = NULL, updated_at = now()
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

-- 3. Same class as (2).
CREATE OR REPLACE FUNCTION decline_waitlist_offer(p_entry_id uuid, p_user_id uuid)
RETURNS boolean AS $$
DECLARE e waitlist_entries;
BEGIN
  SELECT * INTO e FROM waitlist_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND OR e.user_id <> p_user_id OR e.status <> 'CLAIM_OFFERED' THEN
    RETURN false;
  END IF;
  UPDATE trip_seats
     SET status = 'AVAILABLE', hold_by = NULL, hold_guest_token = NULL,
         hold_expires_at = NULL, updated_at = now()
   WHERE id = e.reserved_seat_id;
  UPDATE waitlist_entries
     SET status = 'CANCELLED', reserved_seat_id = NULL, updated_at = now()
   WHERE id = e.id;
  PERFORM offer_seat_to_waitlist(e.trip_id);   -- straight to the next student
  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- 4. Same class. A BLOCKED seat should never carry a hold, so this is belt and
--    braces — but unblocking must not be the statement that violates the
--    constraint if one ever did.
CREATE OR REPLACE FUNCTION unblock_seat(p_trip_id uuid, p_seat_number text)
RETURNS trip_seats AS $$
DECLARE s trip_seats;
BEGIN
  SELECT * INTO s FROM trip_seats
    WHERE trip_id = p_trip_id AND seat_number = p_seat_number FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'seat % is not on this vehicle', p_seat_number USING ERRCODE = 'no_data_found';
  END IF;
  IF s.status <> 'BLOCKED' THEN
    RAISE EXCEPTION 'seat % is not blocked', p_seat_number USING ERRCODE = 'check_violation';
  END IF;

  UPDATE trip_seats
     SET status = 'AVAILABLE', block_reason = NULL, booking_id = NULL,
         hold_by = NULL, hold_guest_token = NULL, hold_expires_at = NULL,
         updated_at = now()
   WHERE id = s.id
  RETURNING * INTO s;
  /* A freed seat may be owed to somebody waiting (F-02). */
  PERFORM offer_seat_to_waitlist(p_trip_id);
  RETURN s;
END;
$$ LANGUAGE plpgsql;

-- Repair any row already stranded by the defect: AVAILABLE but still carrying a
-- guest token. These are seats that lapsed and could not be swept.
UPDATE trip_seats
   SET hold_guest_token = NULL
 WHERE status = 'AVAILABLE' AND hold_guest_token IS NOT NULL;

INSERT INTO schema_migrations (filename) VALUES ('011_release_clears_guest_token.sql');

COMMIT;
