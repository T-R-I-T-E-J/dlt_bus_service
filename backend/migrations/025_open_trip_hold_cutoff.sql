-- DLT · 025 · open trip hold cutoff alignment
--
-- Public trips are bookable while they are OPEN and before departure. Migration
-- 022 accidentally made the hold step stricter than booking by adding a one-hour
-- cutoff, so the UI could show an OPEN trip while seat selection failed.

BEGIN;

CREATE OR REPLACE FUNCTION require_trip_action(p_trip uuid, p_action text) RETURNS trips AS $$
DECLARE t trips; allowed boolean;
BEGIN
  SELECT * INTO t FROM trips WHERE id=p_trip FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found' USING ERRCODE='P0002'; END IF;
  allowed := CASE p_action
    WHEN 'edit' THEN t.status='DRAFT'
    WHEN 'hold' THEN t.status='OPEN' AND t.departure_at > now()
    WHEN 'book' THEN t.status='OPEN' AND t.departure_at > now()
    WHEN 'settle' THEN t.status IN ('OPEN','BOOKING_CLOSED','BOARDING')
    WHEN 'release' THEN t.status IN ('DRAFT','OPEN','BOOKING_CLOSED','BOARDING')
    WHEN 'seats' THEN t.status IN ('DRAFT','OPEN','BOOKING_CLOSED','BOARDING')
    WHEN 'staff' THEN t.status IN ('DRAFT','OPEN','BOOKING_CLOSED','BOARDING')
    WHEN 'cancel' THEN t.status IN ('DRAFT','OPEN','BOOKING_CLOSED','BOARDING')
    WHEN 'board' THEN t.status='BOARDING'
    WHEN 'noshow' THEN t.status='DEPARTED'
    WHEN 'refund' THEN t.status IN ('OPEN','BOOKING_CLOSED','BOARDING')
    ELSE false END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'Action % is unavailable while trip is %',p_action,t.status USING ERRCODE='23514';
  END IF;
  RETURN t;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION check_trip_action(p_trip uuid, p_action text) RETURNS trips AS $$
DECLARE t trips; allowed boolean;
BEGIN
  SELECT * INTO t FROM trips WHERE id=p_trip;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found' USING ERRCODE='P0002'; END IF;
  allowed := CASE p_action
    WHEN 'edit' THEN t.status='DRAFT'
    WHEN 'hold' THEN t.status='OPEN' AND t.departure_at > now()
    WHEN 'book' THEN t.status='OPEN' AND t.departure_at > now()
    WHEN 'settle' THEN t.status IN ('OPEN','BOOKING_CLOSED','BOARDING')
    WHEN 'release' THEN t.status IN ('DRAFT','OPEN','BOOKING_CLOSED','BOARDING')
    WHEN 'seats' THEN t.status IN ('DRAFT','OPEN','BOOKING_CLOSED','BOARDING')
    WHEN 'staff' THEN t.status IN ('DRAFT','OPEN','BOOKING_CLOSED','BOARDING')
    WHEN 'cancel' THEN t.status IN ('DRAFT','OPEN','BOOKING_CLOSED','BOARDING')
    WHEN 'board' THEN t.status='BOARDING'
    WHEN 'noshow' THEN t.status='DEPARTED'
    WHEN 'refund' THEN t.status IN ('OPEN','BOOKING_CLOSED','BOARDING')
    ELSE false END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'Action % is unavailable while trip is %',p_action,t.status USING ERRCODE='23514';
  END IF;
  RETURN t;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hold_seat(
  p_trip_id uuid, p_seat_number text, p_user_id uuid,
  p_guest_token text DEFAULT NULL, p_ttl interval DEFAULT interval '10 minutes'
) RETURNS trip_seats AS $$
DECLARE s trip_seats; t trips; mine boolean;
BEGIN
  IF (p_user_id IS NULL) = (p_guest_token IS NULL) THEN
    RAISE EXCEPTION 'a hold needs exactly one holder: a user or a guest token'
      USING ERRCODE='invalid_parameter_value';
  END IF;
  SELECT * INTO t FROM trips WHERE id=p_trip_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found' USING ERRCODE='P0002'; END IF;
  IF NOT (t.status='OPEN' AND t.departure_at>now()) THEN
    RAISE EXCEPTION 'Action hold is unavailable while trip is %',t.status USING ERRCODE='23514';
  END IF;
  SELECT * INTO s FROM trip_seats WHERE trip_id=p_trip_id AND seat_number=p_seat_number FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'seat % is not on this vehicle',p_seat_number USING ERRCODE='no_data_found'; END IF;
  IF s.status='HELD' AND s.hold_expires_at<=now() THEN
    s.status:='AVAILABLE'; s.hold_by:=NULL; s.hold_guest_token:=NULL; s.hold_expires_at:=NULL;
  END IF;
  mine:=s.status='HELD' AND ((p_user_id IS NOT NULL AND s.hold_by=p_user_id)
    OR (p_guest_token IS NOT NULL AND s.hold_guest_token=p_guest_token));
  IF mine THEN
    UPDATE trip_seats SET hold_expires_at=now()+p_ttl, updated_at=now()
      WHERE id=s.id RETURNING * INTO s;
    RETURN s;
  END IF;
  IF s.status<>'AVAILABLE' THEN
    RAISE EXCEPTION 'seat % is %',p_seat_number,lower(s.status::text) USING ERRCODE='unique_violation';
  END IF;
  UPDATE trip_seats SET status='HELD', hold_by=p_user_id, hold_guest_token=p_guest_token,
      hold_expires_at=now()+p_ttl, booking_id=NULL, updated_at=now()
    WHERE id=s.id RETURNING * INTO s;
  RETURN s;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (filename)
VALUES ('025_open_trip_hold_cutoff.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
