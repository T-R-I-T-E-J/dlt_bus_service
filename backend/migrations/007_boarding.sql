-- DLT · 007 · boarding server authority
--
-- The prototype's scan() is a single atomic operation: resolve an identifier,
-- run eleven checks in a fixed order, and either board the passenger or record
-- why not. It must stay atomic on the server, because two staff scanning the
-- same pass at the same moment must produce exactly one VALID and one
-- ALREADY BOARDED — never two VALIDs.
--
-- So the chain lives in SQL, holding a row lock on the passenger. The ORDER of
-- the checks is preserved verbatim from the prototype: it was reviewed, and it
-- decides which of several true statements a staff member is shown at the door.
--
-- What is NOT here: identifier resolution beyond a direct lookup, and the
-- CHOOSE flow. Those are decisions, not mutations, and live in the domain.

BEGIN;

-- ---------------------------------------------------------------- assignment
--
-- F-19. The scanner's trip is DERIVED, never accepted. A boarding staff member
-- scanning is scoped to their assignment whatever the client sends; ops and
-- super admins may scan any trip.

CREATE FUNCTION assigned_trip_for(p_user_id uuid) RETURNS uuid AS $$
  SELECT ts.trip_id
    FROM trip_staff ts
    JOIN trips t ON t.id = ts.trip_id
   WHERE ts.user_id = p_user_id
     AND t.status IN ('BOOKING_CLOSED','BOARDING','OPEN')
   ORDER BY
     CASE t.status WHEN 'BOARDING' THEN 0 WHEN 'BOOKING_CLOSED' THEN 1 ELSE 2 END,
     t.departure_at
   LIMIT 1;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------- ordering

-- seat_number sorts as text ('10A' before '2A'), which is wrong at a coach
-- door where staff read down a numbered list.
ALTER TABLE booking_passengers
  ADD COLUMN seat_row_order int GENERATED ALWAYS AS
    (NULLIF(regexp_replace(seat_number, '[^0-9]', '', 'g'), '')::int) STORED;

-- ---------------------------------------------------------------- event log

-- Every attempt, valid or not, append-only. Declared BEFORE the chain that
-- calls it. F-28: only a token PREFIX is kept, never the whole token.
CREATE FUNCTION log_boarding(
  p_trip_id uuid, p_passenger_id uuid, p_staff_id uuid,
  p_result scan_result, p_method scan_method, p_reason text, p_token_prefix text
) RETURNS void AS $$
  INSERT INTO boarding_events (trip_id, passenger_id, staff_user_id, result, method, reason, token_prefix)
  VALUES (p_trip_id, p_passenger_id, p_staff_id, p_result, p_method, p_reason,
          left(COALESCE(p_token_prefix, ''), 12));
$$ LANGUAGE sql;

-- ---------------------------------------------------------------- the chain
--
-- Takes the pass row lock, runs the checks, mutates at most once, and ALWAYS
-- writes a boarding_event — including for invalid attempts, which is what makes
-- the event log evidence rather than a success counter.
--
-- p_scope_trip_id is the trip the scanner is authoritatively boarding (already
-- derived by the caller for staff). NULL means "any trip", for ops.

CREATE TYPE scan_verdict AS (
  result       scan_result,
  detail       text,
  passenger_id uuid,
  reason       text
);

CREATE FUNCTION board_by_pass(
  p_pass_id       uuid,
  p_staff_id      uuid,
  p_staff_role    user_role,
  p_scope_trip_id uuid,
  p_method        scan_method,
  p_token_prefix  text
) RETURNS scan_verdict AS $$
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

  /* ---- 3. voided pass */
  IF pass.status = 'VOID' THEN
    v := ('INVALID', 'This pass has been voided.', pax.id, 'void pass')::scan_verdict;
    PERFORM log_boarding(pass.trip_id, pax.id, p_staff_id, 'INVALID', p_method, 'void pass', p_token_prefix);
    RETURN v;
  END IF;

  /* ---- 4. refunded seat */
  SELECT EXISTS (SELECT 1 FROM refunds r
                  WHERE r.booking_id = b.id AND r.status = 'REFUNDED')
    INTO refunded;
  IF refunded AND pax.boarding_status = 'CANCELLED' THEN
    v := ('INVALID', 'This seat was refunded.', pax.id, 'refunded')::scan_verdict;
    PERFORM log_boarding(pass.trip_id, pax.id, p_staff_id, 'INVALID', p_method, 'refunded', p_token_prefix);
    RETURN v;
  END IF;

  /* ---- 5. payment. A complimentary booking is NOT_APPLICABLE and boards
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

  /* ---- 6. journey already complete */
  IF t.status = 'COMPLETED' THEN
    v := ('INVALID', 'That journey is already complete.', pax.id, 'completed journey')::scan_verdict;
    PERFORM log_boarding(pass.trip_id, pax.id, p_staff_id, 'INVALID', p_method, 'completed journey', p_token_prefix);
    RETURN v;
  END IF;

  /* ---- 7. already boarded. Reports WHEN, so staff can tell a duplicate scan
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

  /* ---- 8. previously denied */
  IF pax.boarding_status = 'DENIED_BOARDING' THEN
    v := ('INVALID', pax.name || ' was denied boarding.', pax.id, 'denied boarding')::scan_verdict;
    PERFORM log_boarding(pass.trip_id, pax.id, p_staff_id, 'INVALID', p_method, 'denied boarding', p_token_prefix);
    RETURN v;
  END IF;

  /* ---- board */
  UPDATE booking_passengers SET boarding_status = 'BOARDED' WHERE id = pax.id;
  PERFORM log_boarding(pass.trip_id, pax.id, p_staff_id, 'VALID', p_method, NULL, p_token_prefix);
  v := ('VALID', pax.name || ' \u00b7 seat ' || pax.seat_number || ' \u00b7 ' ||
        lower(pax.seat_type::text), pax.id, NULL)::scan_verdict;
  RETURN v;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- manifest
--
-- Least privilege, enforced in the projection rather than by a caller
-- remembering to strip fields: boarding staff never receive a phone number.

CREATE FUNCTION trip_manifest(p_trip_id uuid, p_role user_role)
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
   ORDER BY bp.seat_row_order, bp.seat_number;
$$ LANGUAGE sql STABLE;

INSERT INTO schema_migrations (filename) VALUES ('007_boarding.sql');

COMMIT;
