BEGIN;

ALTER TABLE trips ADD COLUMN actual_departed_at timestamptz;
ALTER TABLE trips ADD COLUMN actual_completed_at timestamptz;
CREATE TABLE operational_settings (
  key text PRIMARY KEY,
  value integer NOT NULL CHECK (value >= 0 AND value <= 1440)
);
INSERT INTO operational_settings VALUES ('vehicle_turnaround_minutes',30);
GRANT SELECT ON operational_settings TO dlt_app;

CREATE FUNCTION require_trip_action(p_trip uuid, p_action text) RETURNS trips AS $$
DECLARE t trips; allowed boolean;
BEGIN
  SELECT * INTO t FROM trips WHERE id=p_trip FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found' USING ERRCODE='P0002'; END IF;
  allowed := CASE p_action
    WHEN 'edit' THEN t.status='DRAFT'
    WHEN 'hold' THEN t.status='OPEN' AND t.departure_at > now()+interval '1 hour'
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

CREATE FUNCTION check_trip_action(p_trip uuid, p_action text) RETURNS trips AS $$
DECLARE t trips; allowed boolean;
BEGIN
  SELECT * INTO t FROM trips WHERE id=p_trip;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found' USING ERRCODE='P0002'; END IF;
  allowed := CASE p_action
    WHEN 'edit' THEN t.status='DRAFT'
    WHEN 'hold' THEN t.status='OPEN' AND t.departure_at > now()+interval '1 hour'
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

CREATE FUNCTION trip_publish_problems(p_trip uuid) RETURNS text[] AS $$
DECLARE t trips; v vehicles; r routes; problems text[] := '{}'; buffer_minutes int;
BEGIN
  SELECT * INTO t FROM trips WHERE id=p_trip;
  IF NOT FOUND THEN RETURN ARRAY['Trip not found']; END IF;
  IF t.status <> 'DRAFT' THEN problems:=array_append(problems,'Trip must be DRAFT'); END IF;
  SELECT * INTO r FROM routes WHERE id=t.route_id;
  IF NOT FOUND OR NOT r.active OR length(btrim(r.origin))=0 OR length(btrim(r.destination))=0
    OR r.origin=r.destination THEN problems:=array_append(problems,'Route must be active and valid'); END IF;
  IF t.departure_at <= now() THEN problems:=array_append(problems,'Departure must be in the future'); END IF;
  SELECT * INTO v FROM vehicles WHERE id=t.vehicle_id;
  IF NOT FOUND OR v.status <> 'AVAILABLE' THEN problems:=array_append(problems,'Vehicle is unavailable'); END IF;
  IF (SELECT count(*) FROM trip_seats WHERE trip_id=t.id) <> v.capacity
    OR EXISTS(SELECT 1 FROM trip_seats WHERE trip_id=t.id AND
      (seat_row NOT BETWEEN 1 AND v.row_count OR seat_number NOT IN
        (seat_row::text||'A',seat_row::text||'B',seat_row::text||'C',seat_row::text||'D')))
    OR NOT EXISTS(SELECT 1 FROM trip_seats WHERE trip_id=t.id)
    THEN problems:=array_append(problems,'Seat map does not match vehicle configuration'); END IF;
  SELECT value INTO buffer_minutes FROM operational_settings WHERE key='vehicle_turnaround_minutes';
  IF buffer_minutes IS NULL THEN RAISE EXCEPTION 'Turnaround configuration missing'; END IF;
  IF EXISTS(SELECT 1 FROM trips other JOIN routes rr ON rr.id=other.route_id
    WHERE other.vehicle_id=t.vehicle_id AND other.id<>t.id
      AND other.status IN ('OPEN','BOOKING_CLOSED','BOARDING','DEPARTED')
      AND (other.departure_at < t.departure_at+make_interval(mins=>r.duration_min+buffer_minutes)
      AND t.departure_at < other.departure_at+make_interval(mins=>rr.duration_min+buffer_minutes)
      OR other.status IN ('BOARDING','DEPARTED') AND other.departure_at < now()))
    THEN problems:=array_append(problems,'Vehicle has a conflicting or unclosed departure'); END IF;
  RETURN problems;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION guard_trip_change() RETURNS trigger AS $$
DECLARE problems text[];
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Trips must be created as DRAFT before publishing' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Trip history cannot be deleted' USING ERRCODE='23514'; END IF;
  IF OLD.status IN ('COMPLETED','CANCELLED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal trip cannot be changed' USING ERRCODE='23514';
  END IF;
  IF (NEW.route_id,NEW.vehicle_id,NEW.departure_at,NEW.price) IS DISTINCT FROM
     (OLD.route_id,OLD.vehicle_id,OLD.departure_at,OLD.price) THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'Publish/status changes must not be combined with commercial trip edits' USING ERRCODE='23514';
    END IF;
    PERFORM require_trip_action(OLD.id,'edit');
    IF EXISTS(SELECT 1 FROM bookings WHERE trip_id=OLD.id) THEN
      RAISE EXCEPTION 'Trip with booking history cannot be commercially edited' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status='DRAFT' AND NEW.status IN ('OPEN','CANCELLED'))
      OR (OLD.status='OPEN' AND NEW.status IN ('BOOKING_CLOSED','CANCELLED'))
      OR (OLD.status='BOOKING_CLOSED' AND NEW.status IN ('BOARDING','OPEN','CANCELLED'))
      OR (OLD.status='BOARDING' AND NEW.status IN ('DEPARTED','CANCELLED'))
      OR (OLD.status='DEPARTED' AND NEW.status='COMPLETED')) THEN
      RAISE EXCEPTION 'Invalid trip transition: % to %',OLD.status,NEW.status USING ERRCODE='23514';
    END IF;
    IF NEW.status='OPEN' THEN
      PERFORM 1 FROM vehicles WHERE id=NEW.vehicle_id FOR UPDATE;
      IF OLD.status='DRAFT' THEN
        problems:=trip_publish_problems(OLD.id);
        IF cardinality(problems)>0 THEN RAISE EXCEPTION '%',array_to_string(problems,'; ') USING ERRCODE='23514'; END IF;
      ELSIF NEW.departure_at <= now()+interval '1 hour' THEN
        RAISE EXCEPTION 'Cannot reopen after booking cutoff' USING ERRCODE='23514';
      END IF;
    END IF;
    IF NEW.status='CANCELLED' AND EXISTS(SELECT 1 FROM booking_passengers bp JOIN bookings b ON b.id=bp.booking_id
      WHERE b.trip_id=OLD.id AND bp.boarding_status='BOARDED') THEN
      RAISE EXCEPTION 'Passengers have boarded; trip cancellation is unavailable' USING ERRCODE='23514';
    END IF;
    IF NEW.status='CANCELLED' AND (
      EXISTS(SELECT 1 FROM bookings WHERE trip_id=OLD.id
        AND status IN ('PENDING','PAYMENT_PENDING','CONFIRMED'))
      OR EXISTS(SELECT 1 FROM trip_seats WHERE trip_id=OLD.id AND status IN ('HELD','BOOKED'))
    ) THEN
      RAISE EXCEPTION 'Active bookings or seats must be settled before cancelling the trip' USING ERRCODE='23514';
    END IF;
    IF NEW.status='DEPARTED' THEN NEW.actual_departed_at:=now(); END IF;
    IF NEW.status='COMPLETED' THEN NEW.actual_completed_at:=now(); END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trip_operational_guard BEFORE INSERT OR UPDATE OR DELETE ON trips FOR EACH ROW EXECUTE FUNCTION guard_trip_change();

CREATE OR REPLACE FUNCTION set_trip_status(p_trip_id uuid,p_status trip_status,p_reason text,p_actor_id uuid)
RETURNS trips AS $$
DECLARE t trips;
BEGIN
  IF length(btrim(COALESCE(p_reason,'')))<4 THEN RAISE EXCEPTION 'A reason is required' USING ERRCODE='23514'; END IF;
  IF p_status='CANCELLED' THEN RAISE EXCEPTION 'Use the cancellation workflow' USING ERRCODE='23514'; END IF;
  SELECT * INTO t FROM trips WHERE id=p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found' USING ERRCODE='P0002'; END IF;
  IF t.status=p_status THEN RETURN t; END IF;
  UPDATE trips SET status=p_status,pinned_status=p_status,
    pinned_until=LEAST(t.departure_at + interval '4 hours', now() + interval '6 hours'),
    updated_at=now()
    WHERE id=p_trip_id RETURNING * INTO t;
  RETURN t;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION guard_trip_inventory() RETURNS trigger AS $$
DECLARE trip uuid; t trips;
BEGIN
  trip:=CASE WHEN TG_OP='DELETE' THEN OLD.trip_id ELSE NEW.trip_id END;
  t:=check_trip_action(trip,'seats');
  IF TG_OP='UPDATE' AND NEW.trip_id<>OLD.trip_id THEN RAISE EXCEPTION 'Cannot move a seat between trips' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM booking_passengers WHERE trip_seat_id=OLD.id) THEN
    RAISE EXCEPTION 'Seat has passenger history' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND t.status<>'DRAFT' THEN RAISE EXCEPTION 'Inventory can only be generated for drafts' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trip_inventory_guard BEFORE INSERT OR UPDATE OR DELETE ON trip_seats FOR EACH ROW EXECUTE FUNCTION guard_trip_inventory();

CREATE FUNCTION guard_trip_booking() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM check_trip_action(NEW.trip_id,CASE WHEN NEW.kind='ONLINE' THEN 'book' ELSE 'settle' END);
  ELSE
    IF NEW.trip_id<>OLD.trip_id THEN RAISE EXCEPTION 'Cannot move booking between trips' USING ERRCODE='23514'; END IF;
    IF (NEW.status,NEW.unit_price,NEW.total_amount) IS DISTINCT FROM (OLD.status,OLD.unit_price,OLD.total_amount) THEN
      PERFORM check_trip_action(OLD.trip_id,'settle');
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trip_booking_guard BEFORE INSERT OR UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION guard_trip_booking();

CREATE FUNCTION guard_passenger_operation() RETURNS trigger AS $$
DECLARE trip uuid; b bookings; pass_ok boolean; paid boolean;
BEGIN
  SELECT * INTO b FROM bookings WHERE id=NEW.booking_id;
  trip:=b.trip_id;
  IF TG_OP='INSERT' THEN PERFORM check_trip_action(trip,'settle');
  ELSIF NEW IS DISTINCT FROM OLD THEN
    IF NEW.boarding_status='BOARDED' AND OLD.boarding_status<>'BOARDED' THEN
      PERFORM check_trip_action(trip,'board');
      SELECT EXISTS(SELECT 1 FROM boarding_passes WHERE passenger_id=NEW.id AND status='VALID') INTO pass_ok;
      SELECT EXISTS(SELECT 1 FROM payments WHERE booking_id=b.id AND status IN ('SUCCESS','NOT_APPLICABLE')) INTO paid;
      IF b.status<>'CONFIRMED' OR NOT pass_ok OR NOT paid OR OLD.boarding_status<>'NOT_BOARDED' THEN
        RAISE EXCEPTION 'Passenger is not eligible to board' USING ERRCODE='23514'; END IF;
    ELSIF NEW.boarding_status='NO_SHOW' THEN
      PERFORM check_trip_action(trip,'noshow');
      IF OLD.boarding_status<>'NOT_BOARDED' THEN RAISE EXCEPTION 'Only awaiting passengers can be no-shows' USING ERRCODE='23514'; END IF;
    ELSIF NEW.boarding_status='DENIED_BOARDING' THEN
      PERFORM check_trip_action(trip,'board');
      IF OLD.boarding_status<>'NOT_BOARDED' THEN RAISE EXCEPTION 'Passenger is not awaiting boarding' USING ERRCODE='23514'; END IF;
    ELSE PERFORM check_trip_action(trip,'settle'); END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER passenger_operational_guard BEFORE INSERT OR UPDATE ON booking_passengers FOR EACH ROW EXECUTE FUNCTION guard_passenger_operation();

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
  IF NOT (t.status='OPEN' AND t.departure_at>now()+interval '1 hour') THEN
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

CREATE OR REPLACE FUNCTION release_seat(
  p_trip_id uuid, p_seat_number text, p_user_id uuid, p_guest_token text DEFAULT NULL
) RETURNS boolean AS $$
DECLARE s trip_seats; owner bookings;
BEGIN
  PERFORM require_trip_action(p_trip_id,'release');
  SELECT * INTO s FROM trip_seats WHERE trip_id=p_trip_id AND seat_number=p_seat_number FOR UPDATE;
  IF NOT FOUND OR s.status<>'HELD' THEN RETURN false; END IF;
  IF NOT ((p_user_id IS NOT NULL AND s.hold_by=p_user_id) OR
          (p_guest_token IS NOT NULL AND s.hold_guest_token=p_guest_token)) THEN RETURN false; END IF;
  IF s.booking_id IS NOT NULL THEN
    SELECT * INTO owner FROM bookings WHERE id=s.booking_id;
    IF FOUND AND owner.status IN ('PENDING','PAYMENT_PENDING')
       AND owner.hold_expires_at IS NOT NULL AND owner.hold_expires_at>now() THEN
      RAISE EXCEPTION 'seat % belongs to your pending booking % — cancel that booking first, then choose seats again',
        p_seat_number,owner.code USING ERRCODE='unique_violation';
    END IF;
  END IF;
  UPDATE trip_seats SET status='AVAILABLE',hold_by=NULL,hold_guest_token=NULL,
    hold_expires_at=NULL,booking_id=NULL,updated_at=now() WHERE id=s.id;
  RETURN true;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION release_all_held(
  p_trip_id uuid, p_user_id uuid, p_guest_token text DEFAULT NULL
) RETURNS int AS $$
DECLARE n int;
BEGIN
  PERFORM require_trip_action(p_trip_id,'release');
  WITH target AS (
    SELECT ts.id FROM trip_seats ts
     WHERE ts.trip_id=p_trip_id AND ts.status='HELD'
       AND ((p_user_id IS NOT NULL AND ts.hold_by=p_user_id)
         OR (p_guest_token IS NOT NULL AND ts.hold_guest_token=p_guest_token))
       AND NOT EXISTS (
         SELECT 1 FROM bookings b WHERE b.id=ts.booking_id
          AND b.status IN ('PENDING','PAYMENT_PENDING')
          AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at>now())
     ORDER BY ts.seat_number FOR UPDATE
  ), freed AS (
    UPDATE trip_seats SET status='AVAILABLE',hold_by=NULL,hold_guest_token=NULL,
      hold_expires_at=NULL,booking_id=NULL,updated_at=now()
     WHERE id IN (SELECT id FROM target) RETURNING id
  ) SELECT count(*) INTO n FROM freed;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION materialise_trip_seats(p_trip_id uuid) RETURNS int AS $$
DECLARE v vehicles; r int; c text; n int:=0; sold int;
BEGIN
  PERFORM require_trip_action(p_trip_id,'seats');
  SELECT vh.* INTO v FROM trips t JOIN vehicles vh ON vh.id=t.vehicle_id WHERE t.id=p_trip_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'trip % has no vehicle',p_trip_id USING ERRCODE='no_data_found'; END IF;
  SELECT count(*) INTO sold FROM trip_seats WHERE trip_id=p_trip_id AND status IN ('BOOKED','HELD');
  IF sold>0 THEN RAISE EXCEPTION 'cannot rebuild the seat map: % seats are already held or booked',sold
    USING ERRCODE='check_violation'; END IF;
  DELETE FROM trip_seats WHERE trip_id=p_trip_id;
  FOR r IN 1..v.row_count LOOP
    FOREACH c IN ARRAY ARRAY['A','B','C','D'] LOOP
      INSERT INTO trip_seats (trip_id,seat_number,seat_row,seat_type)
      VALUES (p_trip_id,r::text||c,r,CASE WHEN c IN ('A','D') THEN 'WINDOW'::seat_type ELSE 'AISLE'::seat_type END);
      n:=n+1;
    END LOOP;
  END LOOP;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION block_seat(
  p_trip_id uuid, p_seat_number text, p_reason text, p_actor_id uuid
) RETURNS trip_seats AS $$
DECLARE s trip_seats;
BEGIN
  PERFORM require_trip_action(p_trip_id,'seats');
  IF p_reason IS NULL OR length(btrim(p_reason))<4 THEN
    RAISE EXCEPTION 'A reason is required to block a seat' USING ERRCODE='check_violation';
  END IF;
  SELECT * INTO s FROM trip_seats WHERE trip_id=p_trip_id AND seat_number=p_seat_number FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'seat % is not on this vehicle',p_seat_number USING ERRCODE='no_data_found'; END IF;
  IF s.status='BOOKED' THEN RAISE EXCEPTION 'seat % is booked — cancel the booking first',p_seat_number USING ERRCODE='check_violation'; END IF;
  IF s.status='BLOCKED' THEN RAISE EXCEPTION 'seat % is already blocked',p_seat_number USING ERRCODE='unique_violation'; END IF;
  UPDATE trip_seats SET status='BLOCKED',block_reason=btrim(p_reason),hold_by=NULL,
      hold_guest_token=NULL,hold_expires_at=NULL,booking_id=NULL,updated_at=now()
    WHERE id=s.id RETURNING * INTO s;
  RETURN s;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION unblock_seat(p_trip_id uuid, p_seat_number text)
RETURNS trip_seats AS $$
DECLARE s trip_seats;
BEGIN
  PERFORM require_trip_action(p_trip_id,'seats');
  SELECT * INTO s FROM trip_seats WHERE trip_id=p_trip_id AND seat_number=p_seat_number FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'seat % is not on this vehicle',p_seat_number USING ERRCODE='no_data_found'; END IF;
  IF s.status<>'BLOCKED' THEN RAISE EXCEPTION 'seat % is not blocked',p_seat_number USING ERRCODE='check_violation'; END IF;
  UPDATE trip_seats SET status='AVAILABLE',block_reason=NULL,booking_id=NULL,updated_at=now()
    WHERE id=s.id RETURNING * INTO s;
  PERFORM offer_seat_to_waitlist(p_trip_id);
  RETURN s;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION create_booking_from_holds(
  p_trip_id uuid, p_user_id uuid, p_guest_token text, p_contact_phone text,
  p_passengers jsonb, p_hold_ttl interval DEFAULT interval '10 minutes'
) RETURNS bookings AS $$
DECLARE t trips; b bookings; p jsonb; s trip_seats; price int; existing bookings;
BEGIN
  SELECT * INTO t FROM trips WHERE id=p_trip_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'trip not found' USING ERRCODE='no_data_found'; END IF;
  IF NOT (t.status='OPEN' AND t.departure_at>now()) THEN
    RAISE EXCEPTION 'that departure is no longer taking bookings' USING ERRCODE='check_violation';
  END IF;
  IF jsonb_array_length(p_passengers)=0 THEN RAISE EXCEPTION 'a booking needs at least one passenger' USING ERRCODE='check_violation'; END IF;
  IF jsonb_array_length(p_passengers)>5 THEN RAISE EXCEPTION 'up to 5 passengers in one booking' USING ERRCODE='check_violation'; END IF;
  IF (p_user_id IS NULL)=(p_guest_token IS NULL) THEN
    RAISE EXCEPTION 'a booking needs exactly one holder: a user or a guest token' USING ERRCODE='invalid_parameter_value';
  END IF;
  price:=t.price;
  INSERT INTO bookings (code,boarding_code,trip_id,user_id,guest_token,status,kind,
    unit_price,total_amount,contact_phone,hold_expires_at)
  VALUES (new_booking_code(),new_boarding_code(),p_trip_id,p_user_id,p_guest_token,
    'PAYMENT_PENDING','ONLINE',price,price*jsonb_array_length(p_passengers),
    p_contact_phone,now()+p_hold_ttl) RETURNING * INTO b;
  FOR p IN SELECT value FROM jsonb_array_elements(p_passengers) ORDER BY value->>'seatNumber' LOOP
    SELECT * INTO s FROM trip_seats WHERE trip_id=p_trip_id AND seat_number=(p->>'seatNumber') FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'seat % is not on this vehicle',(p->>'seatNumber') USING ERRCODE='no_data_found'; END IF;
    IF s.status<>'HELD' OR s.hold_expires_at<=now()
       OR NOT ((p_user_id IS NOT NULL AND s.hold_by=p_user_id)
            OR (p_guest_token IS NOT NULL AND s.hold_guest_token IS NOT NULL AND s.hold_guest_token=p_guest_token)) THEN
      RAISE EXCEPTION 'your hold on seat % has gone',(p->>'seatNumber') USING ERRCODE='unique_violation';
    END IF;
    IF s.booking_id IS NOT NULL THEN
      SELECT * INTO existing FROM bookings WHERE id=s.booking_id;
      IF FOUND AND existing.status='PAYMENT_PENDING' AND existing.hold_expires_at>now() THEN
        RAISE EXCEPTION 'you already have a pending booking (%) for seat % — finish or cancel it first',
          existing.code,(p->>'seatNumber') USING ERRCODE='unique_violation';
      END IF;
    END IF;
    INSERT INTO booking_passengers (booking_id,trip_seat_id,name,student_id,phone,seat_number,seat_type)
    VALUES (b.id,s.id,p->>'name',p->>'studentId',p->>'phone',s.seat_number,s.seat_type);
    UPDATE trip_seats SET booking_id=b.id,hold_expires_at=b.hold_expires_at,updated_at=now()
      WHERE id=s.id;
  END LOOP;
  RETURN b;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION settle_booking(p_booking_id uuid, p_payment_id uuid)
RETURNS settlement_outcome AS $$
DECLARE b bookings; pax booking_passengers; s trip_seats; tok text; t trips;
BEGIN
  SELECT b0.* INTO b FROM bookings b0 WHERE b0.id=p_booking_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking not found' USING ERRCODE='no_data_found'; END IF;
  SELECT * INTO t FROM trips WHERE id=b.trip_id FOR UPDATE;
  SELECT b0.* INTO b FROM bookings b0 WHERE b0.id=p_booking_id FOR UPDATE;
  IF b.status='CONFIRMED' THEN RETURN 'ALREADY_CONFIRMED'; END IF;
  IF b.status IN ('ABANDONED','CANCELLED_BY_STUDENT','CANCELLED_BY_DLT')
     OR t.status NOT IN ('OPEN','BOOKING_CLOSED','BOARDING') THEN
    RETURN 'REFUND_REQUIRED';
  END IF;
  FOR pax IN SELECT * FROM booking_passengers WHERE booking_id=b.id ORDER BY seat_number LOOP
    SELECT * INTO s FROM trip_seats WHERE id=pax.trip_seat_id FOR UPDATE;
    IF s IS NULL OR (s.status='BOOKED' AND s.booking_id<>b.id)
       OR (s.status='HELD' AND s.booking_id IS DISTINCT FROM b.id)
       OR s.status='BLOCKED' THEN RETURN 'REFUND_REQUIRED'; END IF;
    UPDATE trip_seats SET status='BOOKED',booking_id=b.id,hold_by=NULL,hold_guest_token=NULL,
      hold_expires_at=NULL,updated_at=now() WHERE id=s.id;
    tok:='dlt.' || encode(gen_random_bytes(14),'hex');
    INSERT INTO boarding_passes (passenger_id,booking_id,trip_id,qr_token)
    VALUES (pax.id,b.id,b.trip_id,tok) ON CONFLICT (passenger_id) DO NOTHING;
  END LOOP;
  UPDATE bookings SET status='CONFIRMED',hold_expires_at=NULL,updated_at=now() WHERE id=b.id;
  PERFORM convert_waitlist_entry(b.user_id,b.trip_id,b.id);
  RETURN 'CONFIRMED';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION release_booking_seats(p_booking_id uuid, p_new_status booking_status)
RETURNS int AS $$
DECLARE n int; trip uuid;
BEGIN
  SELECT trip_id INTO trip FROM bookings WHERE id=p_booking_id;
  PERFORM require_trip_action(trip,'release');
  UPDATE booking_passengers SET boarding_status='CANCELLED' WHERE booking_id=p_booking_id;
  UPDATE boarding_passes SET status='VOID',voided_at=now()
    WHERE booking_id=p_booking_id AND status='VALID';
  WITH freed AS (
    UPDATE trip_seats SET status='AVAILABLE',booking_id=NULL,hold_by=NULL,
      hold_guest_token=NULL,hold_expires_at=NULL,updated_at=now()
     WHERE booking_id=p_booking_id RETURNING id
  ) SELECT count(*) INTO n FROM freed;
  UPDATE bookings SET status=p_new_status,updated_at=now() WHERE id=p_booking_id;
  IF n>0 THEN PERFORM offer_seat_to_waitlist(trip); END IF;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS settle_booking_v2(uuid, uuid);
CREATE FUNCTION settle_booking_v2(p_booking_id uuid, p_payment_id uuid)
RETURNS TABLE (outcome text, seats_claimed int, seats_lost int, refund_amount int) AS $$
DECLARE b bookings; pax booking_passengers; s trip_seats; tok text; t trips;
  found_seat boolean; claimable boolean; n_claimed int:=0; n_lost int:=0;
BEGIN
  SELECT b0.* INTO b FROM bookings b0 WHERE b0.id=p_booking_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking not found' USING ERRCODE='no_data_found'; END IF;
  SELECT * INTO t FROM trips WHERE id=b.trip_id FOR UPDATE;
  SELECT b0.* INTO b FROM bookings b0 WHERE b0.id=p_booking_id FOR UPDATE;
  IF b.status='CONFIRMED' THEN RETURN QUERY SELECT 'ALREADY_CONFIRMED'::text,0,0,0; RETURN; END IF;
  IF b.status IN ('ABANDONED','CANCELLED_BY_STUDENT','CANCELLED_BY_DLT')
     OR t.status NOT IN ('OPEN','BOOKING_CLOSED','BOARDING') THEN
    RETURN QUERY SELECT 'REFUND_REQUIRED'::text,0,0,0; RETURN;
  END IF;
  FOR pax IN SELECT * FROM booking_passengers WHERE booking_id=b.id ORDER BY seat_number LOOP
    found_seat:=false;
    IF pax.trip_seat_id IS NOT NULL THEN
      SELECT * INTO s FROM trip_seats WHERE id=pax.trip_seat_id FOR UPDATE;
      found_seat:=FOUND;
    END IF;
    claimable:=found_seat AND (s.status='AVAILABLE'
      OR (s.status='HELD' AND s.booking_id IS NOT DISTINCT FROM b.id)
      OR (s.status='BOOKED' AND s.booking_id=b.id));
    IF claimable THEN
      UPDATE trip_seats SET status='BOOKED',booking_id=b.id,hold_by=NULL,hold_guest_token=NULL,
        hold_expires_at=NULL,updated_at=now() WHERE id=s.id;
      tok:='dlt.' || encode(gen_random_bytes(14),'hex');
      INSERT INTO boarding_passes (passenger_id,booking_id,trip_id,qr_token)
      VALUES (pax.id,b.id,b.trip_id,tok) ON CONFLICT (passenger_id) DO NOTHING;
      n_claimed:=n_claimed+1;
    ELSE
      UPDATE boarding_passes SET status='VOID',voided_at=now()
        WHERE passenger_id=pax.id AND status='VALID';
      UPDATE booking_passengers SET boarding_status='CANCELLED',trip_seat_id=NULL WHERE id=pax.id;
      n_lost:=n_lost+1;
    END IF;
  END LOOP;
  IF n_claimed=0 THEN RETURN QUERY SELECT 'REFUND_REQUIRED'::text,0,n_lost,0; RETURN; END IF;
  UPDATE bookings SET status='CONFIRMED',hold_expires_at=NULL,updated_at=now() WHERE id=b.id;
  PERFORM convert_waitlist_entry(b.user_id,b.trip_id,b.id);
  IF n_lost=0 THEN
    RETURN QUERY SELECT 'CONFIRMED'::text,n_claimed,0,0;
  ELSE
    RETURN QUERY SELECT 'PARTIAL'::text,n_claimed,n_lost,b.unit_price*n_lost;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION board_by_pass(
  p_pass_id uuid, p_staff_id uuid, p_staff_role user_role, p_scope_trip_id uuid,
  p_method scan_method, p_token_prefix text
) RETURNS scan_verdict AS $$
DECLARE pass boarding_passes; pax booking_passengers; b bookings; t trips;
  v scan_verdict; boarded_at timestamptz; pay_status payment_status; refunded boolean;
BEGIN
  SELECT * INTO pass FROM boarding_passes WHERE id=p_pass_id;
  IF NOT FOUND THEN
    v:=('INVALID','This code is not a DLT boarding pass, boarding code or booking ID.',NULL,NULL)::scan_verdict;
    PERFORM log_boarding(p_scope_trip_id,NULL,p_staff_id,'INVALID',p_method,NULL,p_token_prefix);
    RETURN v;
  END IF;
  SELECT * INTO t FROM trips WHERE id=pass.trip_id FOR UPDATE;
  SELECT * INTO pax FROM booking_passengers WHERE id=pass.passenger_id FOR UPDATE;
  SELECT * INTO b FROM bookings WHERE id=pass.booking_id;
  IF pax IS NULL OR b IS NULL OR t IS NULL THEN
    v:=('INVALID','The booking behind this pass no longer exists.',NULL,NULL)::scan_verdict;
    PERFORM log_boarding(p_scope_trip_id,NULL,p_staff_id,'INVALID',p_method,NULL,p_token_prefix);
    RETURN v;
  END IF;
  IF p_scope_trip_id IS NOT NULL AND p_scope_trip_id<>pass.trip_id THEN
    v:=('INVALID','This pass belongs to '||to_char(t.departure_at,'Dy DD Mon HH24:MI')||
      ', not the trip you are boarding.',pax.id,'wrong trip')::scan_verdict;
    PERFORM log_boarding(p_scope_trip_id,pax.id,p_staff_id,'INVALID',p_method,'wrong trip',p_token_prefix);
    RETURN v;
  END IF;
  IF b.status IN ('CANCELLED_BY_STUDENT','CANCELLED_BY_DLT') THEN
    v:=('INVALID','Booking '||b.code||' is cancelled.',pax.id,'cancelled booking')::scan_verdict;
    PERFORM log_boarding(pass.trip_id,pax.id,p_staff_id,'INVALID',p_method,'cancelled booking',p_token_prefix);
    RETURN v;
  END IF;
  IF pass.status='VOID' THEN
    v:=('INVALID','This pass has been voided.',pax.id,'void pass')::scan_verdict;
    PERFORM log_boarding(pass.trip_id,pax.id,p_staff_id,'INVALID',p_method,'void pass',p_token_prefix);
    RETURN v;
  END IF;
  SELECT EXISTS(SELECT 1 FROM refunds r WHERE r.booking_id=b.id AND r.status='REFUNDED') INTO refunded;
  IF refunded AND pax.boarding_status='CANCELLED' THEN
    v:=('INVALID','This seat was refunded.',pax.id,'refunded')::scan_verdict;
    PERFORM log_boarding(pass.trip_id,pax.id,p_staff_id,'INVALID',p_method,'refunded',p_token_prefix);
    RETURN v;
  END IF;
  SELECT status INTO pay_status FROM payments WHERE booking_id=b.id
    ORDER BY CASE status WHEN 'SUCCESS' THEN 0 WHEN 'NOT_APPLICABLE' THEN 1 ELSE 2 END, created_at DESC LIMIT 1;
  IF pay_status IS NULL OR pay_status NOT IN ('SUCCESS','NOT_APPLICABLE') THEN
    v:=('INVALID','Payment for '||b.code||' is '||COALESCE(lower(pay_status::text),'missing')||'.',
      pax.id,'payment not successful')::scan_verdict;
    PERFORM log_boarding(pass.trip_id,pax.id,p_staff_id,'INVALID',p_method,'payment not successful',p_token_prefix);
    RETURN v;
  END IF;
  IF t.status='COMPLETED' THEN
    v:=('INVALID','That journey is already complete.',pax.id,'completed journey')::scan_verdict;
    PERFORM log_boarding(pass.trip_id,pax.id,p_staff_id,'INVALID',p_method,'completed journey',p_token_prefix);
    RETURN v;
  END IF;
  IF pax.boarding_status='BOARDED' THEN
    SELECT occurred_at INTO boarded_at FROM boarding_events
      WHERE passenger_id=pax.id AND result='VALID' ORDER BY occurred_at DESC LIMIT 1;
    v:=('ALREADY BOARDED',pax.name||' · seat '||pax.seat_number||' boarded at '||
      to_char(COALESCE(boarded_at,now()),'HH24:MI')||'.',pax.id,'second scan')::scan_verdict;
    PERFORM log_boarding(pass.trip_id,pax.id,p_staff_id,'ALREADY BOARDED',p_method,'second scan',p_token_prefix);
    RETURN v;
  END IF;
  IF pax.boarding_status='DENIED_BOARDING' THEN
    v:=('INVALID',pax.name||' was denied boarding.',pax.id,'denied boarding')::scan_verdict;
    PERFORM log_boarding(pass.trip_id,pax.id,p_staff_id,'INVALID',p_method,'denied boarding',p_token_prefix);
    RETURN v;
  END IF;
  PERFORM require_trip_action(pass.trip_id,'board');
  UPDATE booking_passengers SET boarding_status='BOARDED' WHERE id=pax.id;
  PERFORM log_boarding(pass.trip_id,pax.id,p_staff_id,'VALID',p_method,NULL,p_token_prefix);
  v:=('VALID',pax.name||' · seat '||pax.seat_number||' · '||lower(pax.seat_type::text),pax.id,NULL)::scan_verdict;
  RETURN v;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION offer_seat_to_waitlist(p_trip_id uuid)
RETURNS waitlist_entries AS $$
DECLARE e waitlist_entries; s trip_seats; t trips;
BEGIN
  SELECT * INTO t FROM trips WHERE id=p_trip_id FOR UPDATE;
  IF NOT FOUND OR t.status<>'OPEN' OR t.departure_at<=now()+interval '1 hour' THEN RETURN NULL; END IF;
  SELECT * INTO e FROM waitlist_entries WHERE trip_id=p_trip_id AND status='WAITING'
    ORDER BY position,created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO s FROM trip_seats WHERE trip_id=p_trip_id AND status='AVAILABLE'
    ORDER BY seat_row,seat_number FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE trip_seats SET status='HELD',hold_by=e.user_id,hold_expires_at=now()+interval '30 minutes',
    updated_at=now() WHERE id=s.id;
  UPDATE waitlist_entries SET status='CLAIM_OFFERED',reserved_seat_id=s.id,offered_at=now(),
    offer_expires_at=now()+interval '30 minutes',updated_at=now()
    WHERE id=e.id RETURNING * INTO e;
  RETURN e;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION claim_waitlist_offer(p_entry_id uuid, p_user_id uuid)
RETURNS trip_seats AS $$
DECLARE e waitlist_entries; s trip_seats;
BEGIN
  SELECT * INTO e FROM waitlist_entries WHERE id=p_entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'that waitlist entry does not exist' USING ERRCODE='no_data_found'; END IF;
  PERFORM require_trip_action(e.trip_id,'hold');
  IF e.user_id<>p_user_id THEN RAISE EXCEPTION 'that offer belongs to another student' USING ERRCODE='insufficient_privilege'; END IF;
  IF e.status<>'CLAIM_OFFERED' THEN RAISE EXCEPTION 'there is no open offer on this entry (it is %)',lower(e.status::text)
    USING ERRCODE='check_violation'; END IF;
  IF e.offer_expires_at<=now() THEN RAISE EXCEPTION 'that offer expired at %',e.offer_expires_at USING ERRCODE='check_violation'; END IF;
  SELECT * INTO s FROM trip_seats WHERE id=e.reserved_seat_id FOR UPDATE;
  IF NOT FOUND OR s.status<>'HELD' OR s.hold_by<>p_user_id THEN
    RAISE EXCEPTION 'the seat reserved for you is no longer available' USING ERRCODE='unique_violation';
  END IF;
  UPDATE trip_seats SET hold_expires_at=now()+interval '10 minutes',updated_at=now()
    WHERE id=s.id RETURNING * INTO s;
  UPDATE waitlist_entries SET status='CLAIMED',updated_at=now() WHERE id=e.id;
  RETURN s;
END;
$$ LANGUAGE plpgsql;

DROP VIEW IF EXISTS report_revenue;
DROP VIEW IF EXISTS report_trip_summary;
DROP VIEW IF EXISTS booking_money;
CREATE VIEW booking_money AS
  SELECT b.id AS booking_id, b.code, b.total_amount,
         COALESCE(pin.received,0) AS received,
         COALESCE(rout.returned,0) AS returned,
         GREATEST(COALESCE(pin.received,0)-COALESCE(obligated.amount,0),0) AS refundable
    FROM bookings b
    LEFT JOIN LATERAL (
      SELECT sum(amount)::int AS received FROM payments
       WHERE booking_id=b.id AND status IN ('SUCCESS','DUPLICATE')
    ) pin ON true
    LEFT JOIN LATERAL (
      SELECT sum(amount)::int AS returned FROM refunds
       WHERE booking_id=b.id AND status='REFUNDED'
    ) rout ON true
    LEFT JOIN LATERAL (
      SELECT sum(amount)::int AS amount FROM refunds
       WHERE booking_id=b.id AND status<>'REFUND_FAILED'
    ) obligated ON true;
CREATE VIEW report_trip_summary AS
  SELECT t.id AS trip_id, t.departure_at, t.status AS trip_status,
         r.origin, r.destination, v.name AS vehicle, v.registration,
         (SELECT count(*)::int FROM trip_seats ts WHERE ts.trip_id=t.id) AS capacity,
         (SELECT count(*)::int FROM trip_seats ts WHERE ts.trip_id=t.id AND ts.status='BOOKED') AS seats_booked,
         (SELECT count(*)::int FROM trip_seats ts WHERE ts.trip_id=t.id AND ts.status='BLOCKED') AS seats_blocked,
         (SELECT count(*)::int FROM booking_passengers bp JOIN bookings b ON b.id=bp.booking_id
           WHERE b.trip_id=t.id AND b.status='CONFIRMED') AS passengers,
         (SELECT count(*)::int FROM booking_passengers bp JOIN bookings b ON b.id=bp.booking_id
           WHERE b.trip_id=t.id AND b.status='CONFIRMED' AND bp.boarding_status='BOARDED') AS boarded,
         (SELECT count(*)::int FROM booking_passengers bp JOIN bookings b ON b.id=bp.booking_id
           WHERE b.trip_id=t.id AND b.status='CONFIRMED' AND bp.boarding_status='NO_SHOW') AS no_shows,
         (SELECT count(*)::int FROM booking_passengers bp JOIN bookings b ON b.id=bp.booking_id
           WHERE b.trip_id=t.id AND b.status='CONFIRMED' AND bp.boarding_status='DENIED_BOARDING') AS denied,
         (SELECT COALESCE(sum(p.amount),0)::int FROM payments p JOIN bookings b ON b.id=p.booking_id
           WHERE b.trip_id=t.id AND p.status='SUCCESS') AS gross_rupees,
         (SELECT COALESCE(sum(rf.amount),0)::int FROM refunds rf JOIN bookings b ON b.id=rf.booking_id
           WHERE b.trip_id=t.id AND rf.status='REFUNDED') AS refunded_rupees,
         (SELECT count(*)::int FROM waitlist_entries w
           WHERE w.trip_id=t.id AND w.status IN ('WAITING','CLAIM_OFFERED')) AS waiting
    FROM trips t JOIN routes r ON r.id=t.route_id LEFT JOIN vehicles v ON v.id=t.vehicle_id;
CREATE VIEW report_revenue AS
  SELECT t.id AS trip_id, t.departure_at, s.gross_rupees, s.refunded_rupees,
         (s.gross_rupees-s.refunded_rupees) AS net_rupees
    FROM trips t JOIN report_trip_summary s ON s.trip_id=t.id;

CREATE OR REPLACE FUNCTION sweep_expired_holds() RETURNS TABLE(seats_released int,bookings_abandoned int) AS $$
DECLARE ns int; nb int;
BEGIN
  WITH changed AS (UPDATE trip_seats SET status='AVAILABLE',hold_by=NULL,hold_guest_token=NULL,
    hold_expires_at=NULL,booking_id=NULL,updated_at=now()
    WHERE status='HELD' AND hold_expires_at<=now() AND trip_id IN
      (SELECT id FROM trips WHERE status IN ('DRAFT','OPEN','BOOKING_CLOSED','BOARDING')) RETURNING id)
    SELECT count(*) INTO ns FROM changed;
  WITH changed AS (UPDATE bookings SET status='ABANDONED',updated_at=now()
    WHERE status IN ('PENDING','PAYMENT_PENDING') AND hold_expires_at<=now() AND trip_id IN
      (SELECT id FROM trips WHERE status IN ('OPEN','BOOKING_CLOSED','BOARDING')) RETURNING id)
    SELECT count(*) INTO nb FROM changed;
  RETURN QUERY SELECT ns,nb;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION expire_waitlist_offers() RETURNS int AS $$
DECLARE e waitlist_entries; n int:=0;
BEGIN
  FOR e IN SELECT * FROM waitlist_entries WHERE status='CLAIM_OFFERED' AND offer_expires_at<=now()
    AND trip_id IN (SELECT id FROM trips WHERE status IN ('OPEN','BOOKING_CLOSED','BOARDING'))
    FOR UPDATE SKIP LOCKED LOOP
    UPDATE trip_seats SET status='AVAILABLE',hold_by=NULL,hold_guest_token=NULL,hold_expires_at=NULL,
      booking_id=NULL,updated_at=now() WHERE id=e.reserved_seat_id;
    UPDATE waitlist_entries SET status='EXPIRED',reserved_seat_id=NULL,updated_at=now() WHERE id=e.id;
    IF EXISTS(SELECT 1 FROM trips WHERE id=e.trip_id AND status='OPEN' AND departure_at>now()+interval '1 hour')
      THEN PERFORM offer_seat_to_waitlist(e.trip_id); END IF;
    n:=n+1;
  END LOOP;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations(filename) VALUES ('022_trip_operational_safety.sql');
COMMIT;
