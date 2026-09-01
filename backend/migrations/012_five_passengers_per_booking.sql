-- DLT · 012 · the booking cap is 5 passengers, not 4
--
-- The specification is unambiguous and consistent:
--   00_Master_Specification.md  "Up to 5 passengers per booking",
--                               "**5 seats per booking**",
--                               "One booking may contain up to 5 passengers."
--   01_Product_Requirements_Document.md  "Maximum 5 passengers per booking"
-- and the booking screen has always said "Choose up to five seats".
--
-- The backend enforced 4, in two authoritative places: MAX_SEATS_PER_BOOKING in
-- domain/seats.ts (the basket cap, checked while holding) and this function (the
-- cap checked while converting holds into a booking). A student could therefore
-- be told they may take five seats and be refused the fifth.
--
-- This migration moves the DATABASE half to 5. The domain constant is changed in
-- the same commit. Nothing else about the function is altered — body reproduced
-- verbatim from the live definition, with only the two cap lines changed.
--
-- Deliberately NOT changed: the guest per-IP budget, the guest per-trip ceiling
-- and the waitlist limits are separate rules with separate reasons.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_booking_from_holds(p_trip_id uuid, p_user_id uuid, p_guest_token text, p_contact_phone text, p_passengers jsonb, p_hold_ttl interval DEFAULT '00:10:00'::interval)
 RETURNS bookings
 LANGUAGE plpgsql
AS $function$
DECLARE
  t trips; b bookings; p jsonb; s trip_seats; price int;
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
$function$;


INSERT INTO schema_migrations (filename) VALUES ('012_five_passengers_per_booking.sql');

COMMIT;
