-- DLT · 013 · a denied passenger is reported as denied, not as "voided"
--
-- deny_boarding() sets booking_passengers.boarding_status='DENIED_BOARDING' AND
-- voids the boarding pass. board_by_pass() checked the voided pass first, so the
-- DENIED_BOARDING branch was unreachable through that path, and a staff member
-- rescanning a passenger they had already turned away saw only
-- "This pass has been voided."
--
-- Both statements are true; the question is which one the person at the door can
-- act on. The chain already answers that elsewhere - the wrong-trip check is
-- deliberately ordered ahead of the cancelled-booking check "because that is
-- what the staff member can act on at the door". This applies the same rule.
--
-- SECURITY: unchanged. Both branches return INVALID and board nobody; only the
-- message and the logged reason differ. The scope, cancelled-booking, payment
-- and completed-journey checks all keep their positions and their precedence.
--
-- Body reproduced verbatim from the live definition; only the position of the
-- DENIED_BOARDING block and the step numbers in comments differ.

BEGIN;

CREATE OR REPLACE FUNCTION public.board_by_pass(p_pass_id uuid, p_staff_id uuid, p_staff_role user_role, p_scope_trip_id uuid, p_method scan_method, p_token_prefix text)
 RETURNS scan_verdict
 LANGUAGE plpgsql
AS $function$
DECLARE
  pass boarding_passes; pax booking_passengers; b bookings; t trips;
  v scan_verdict; boarded_at timestamptz; pay_status payment_status;
  refunded boolean;
BEGIN
  /* Lock the PASSENGER row: it is what the mutation touches, and locking it
   * serialises two staff scanning the same person. */
  SELECT * INTO pass FROM boarding_passes WHERE id = p_pass_id;
  IF NOT FOUND THEN
    v := ('INVALID', 'This code is not a DLT boarding pass, boarding code or booking ID.',
          NULL, NULL)::scan_verdict;
    PERFORM log_boarding(p_scope_trip_id, NULL, p_staff_id, 'INVALID', p_method, NULL, p_token_prefix);
    RETURN v;
  END IF;

  SELECT * INTO pax FROM booking_passengers WHERE id = pass.passenger_id FOR UPDATE;
  SELECT * INTO b   FROM bookings           WHERE id = pass.booking_id;
  SELECT * INTO t   FROM trips              WHERE id = pass.trip_id;

  IF pax IS NULL OR b IS NULL OR t IS NULL THEN
    v := ('INVALID', 'The booking behind this pass no longer exists.', NULL, NULL)::scan_verdict;
    PERFORM log_boarding(p_scope_trip_id, NULL, p_staff_id, 'INVALID', p_method, NULL, p_token_prefix);
    RETURN v;
  END IF;

  /* ---- 1. wrong trip. Staff are scoped by assignment (F-19); ops by the trip
   *         they selected. Same message either way \u2014 a pass for another
   *         departure is refused before anything else is considered. */
  IF p_scope_trip_id IS NOT NULL AND p_scope_trip_id <> pass.trip_id THEN
    v := ('INVALID',
          'This pass belongs to ' || to_char(t.departure_at, 'Dy DD Mon HH24:MI') ||
          ', not the trip you are boarding.', pax.id, 'wrong trip')::scan_verdict;
    PERFORM log_boarding(p_scope_trip_id, pax.id, p_staff_id, 'INVALID', p_method, 'wrong trip', p_token_prefix);
    RETURN v;
  END IF;

  /* ---- 2. cancelled booking */
  IF b.status IN ('CANCELLED_BY_STUDENT','CANCELLED_BY_DLT') THEN
    v := ('INVALID', 'Booking ' || b.code || ' is cancelled.', pax.id, 'cancelled booking')::scan_verdict;
    PERFORM log_boarding(pass.trip_id, pax.id, p_staff_id, 'INVALID', p_method, 'cancelled booking', p_token_prefix);
    RETURN v;
  END IF;

  /* ---- 3. previously denied.
   *
   * BEFORE the void check, deliberately. deny_boarding() both sets
   * boarding_status='DENIED_BOARDING' AND voids the pass, so with the void check
   * first this branch was unreachable through the deny path and the door was
   * told "This pass has been voided." — a mechanism, not a reason. Staff can act
   * on "X was denied boarding"; they cannot act on "voided". Same principle the
   * wrong-trip check is ordered by. Both outcomes are INVALID, so this changes
   * the message, never the decision. */
  IF pax.boarding_status = 'DENIED_BOARDING' THEN
    v := ('INVALID', pax.name || ' was denied boarding.', pax.id, 'denied boarding')::scan_verdict;
    PERFORM log_boarding(pass.trip_id, pax.id, p_staff_id, 'INVALID', p_method, 'denied boarding', p_token_prefix);
    RETURN v;
  END IF;

  /* ---- 4. voided pass */
  IF pass.status = 'VOID' THEN
    v := ('INVALID', 'This pass has been voided.', pax.id, 'void pass')::scan_verdict;
    PERFORM log_boarding(pass.trip_id, pax.id, p_staff_id, 'INVALID', p_method, 'void pass', p_token_prefix);
    RETURN v;
  END IF;

  /* ---- 5. refunded seat */
  SELECT EXISTS (SELECT 1 FROM refunds r
                  WHERE r.booking_id = b.id AND r.status = 'REFUNDED')
    INTO refunded;
  IF refunded AND pax.boarding_status = 'CANCELLED' THEN
    v := ('INVALID', 'This seat was refunded.', pax.id, 'refunded')::scan_verdict;
    PERFORM log_boarding(pass.trip_id, pax.id, p_staff_id, 'INVALID', p_method, 'refunded', p_token_prefix);
    RETURN v;
  END IF;

  /* ---- 6. payment. A complimentary booking is NOT_APPLICABLE and boards
   *         legitimately; anything else must have settled. */
  SELECT status INTO pay_status FROM payments
    WHERE booking_id = b.id
    ORDER BY CASE status WHEN 'SUCCESS' THEN 0 WHEN 'NOT_APPLICABLE' THEN 1 ELSE 2 END,
             created_at DESC
    LIMIT 1;
  IF pay_status IS NULL OR pay_status NOT IN ('SUCCESS','NOT_APPLICABLE') THEN
    v := ('INVALID', 'Payment for ' || b.code || ' is ' ||
          COALESCE(lower(pay_status::text), 'missing') || '.', pax.id, 'payment not successful')::scan_verdict;
    PERFORM log_boarding(pass.trip_id, pax.id, p_staff_id, 'INVALID', p_method, 'payment not successful', p_token_prefix);
    RETURN v;
  END IF;

  /* ---- 7. journey already complete */
  IF t.status = 'COMPLETED' THEN
    v := ('INVALID', 'That journey is already complete.', pax.id, 'completed journey')::scan_verdict;
    PERFORM log_boarding(pass.trip_id, pax.id, p_staff_id, 'INVALID', p_method, 'completed journey', p_token_prefix);
    RETURN v;
  END IF;

  /* ---- 8. already boarded. Reports WHEN, so staff can tell a duplicate scan
   *         from a passed-back pass. The row lock above is what guarantees the
   *         second of two simultaneous scans lands here. */
  IF pax.boarding_status = 'BOARDED' THEN
    SELECT occurred_at INTO boarded_at FROM boarding_events
      WHERE passenger_id = pax.id AND result = 'VALID'
      ORDER BY occurred_at DESC LIMIT 1;
    v := ('ALREADY BOARDED', pax.name || ' \u00b7 seat ' || pax.seat_number || ' boarded at ' ||
          to_char(COALESCE(boarded_at, now()), 'HH24:MI') || '.', pax.id, 'second scan')::scan_verdict;
    PERFORM log_boarding(pass.trip_id, pax.id, p_staff_id, 'ALREADY BOARDED', p_method, 'second scan', p_token_prefix);
    RETURN v;
  END IF;

  /* ---- board */
  UPDATE booking_passengers SET boarding_status = 'BOARDED' WHERE id = pax.id;
  PERFORM log_boarding(pass.trip_id, pax.id, p_staff_id, 'VALID', p_method, NULL, p_token_prefix);
  v := ('VALID', pax.name || ' \u00b7 seat ' || pax.seat_number || ' \u00b7 ' ||
        lower(pax.seat_type::text), pax.id, NULL)::scan_verdict;
  RETURN v;
END;
$function$;


INSERT INTO schema_migrations (filename) VALUES ('013_denied_before_void.sql');

COMMIT;
