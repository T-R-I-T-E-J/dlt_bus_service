BEGIN;
-- Operator verified DLT-01: ten rows A-D. Historical trip inventory is a snapshot.
DO $$
DECLARE v vehicles; t trips;
BEGIN
  IF (SELECT count(*) FROM vehicles WHERE name='DLT-01')>1 THEN
    RAISE EXCEPTION 'Ambiguous DLT-01 vehicle; operator review required'; END IF;
  SELECT * INTO v FROM vehicles WHERE name='DLT-01' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v.row_count NOT IN (10,11) THEN RAISE EXCEPTION 'Unexpected DLT-01 layout'; END IF;
  FOR t IN SELECT * FROM trips WHERE vehicle_id=v.id AND departure_at>now()
    AND status IN ('DRAFT','OPEN','BOOKING_CLOSED') ORDER BY id FOR UPDATE
  LOOP
    IF EXISTS(SELECT 1 FROM bookings WHERE trip_id=t.id)
      OR EXISTS(SELECT 1 FROM boarding_passes WHERE trip_id=t.id)
      OR EXISTS(SELECT 1 FROM boarding_events WHERE trip_id=t.id)
      OR EXISTS(SELECT 1 FROM waitlist_entries WHERE trip_id=t.id)
      OR EXISTS(SELECT 1 FROM trip_seats WHERE trip_id=t.id AND status<>'AVAILABLE')
      OR EXISTS(SELECT 1 FROM audit_logs a JOIN trip_seats s ON a.entity_id=s.id::text WHERE s.trip_id=t.id)
    THEN CONTINUE; END IF;
    DELETE FROM trip_seats WHERE trip_id=t.id AND seat_row=11;
  END LOOP;
  UPDATE vehicles SET row_count=10,updated_at=now() WHERE id=v.id;
END;
$$;
INSERT INTO schema_migrations(filename) VALUES ('023_vehicle_40_seat_configuration.sql');
COMMIT;
