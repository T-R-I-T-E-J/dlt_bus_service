-- DLT · 008 · admin and operations authority
--
-- Phase 3 built these workflows in the prototype store and Phase 6 moves them
-- to the server. Most of the business logic is already expressed as constraints
-- in 001–007; what this migration adds is the handful of operations whose rules
-- are genuinely relational, plus the report views so that no total is ever
-- computed by a caller.
--
-- Deliberately NOT re-implemented here: the refund override and manual bookings.
-- They exist in domain/payments.ts, correct and tested, and the rule against
-- duplicating business logic outranks tidiness of file layout.

BEGIN;

-- ---------------------------------------------------------------- permissions
--
-- Gaps found while auditing Phase 5 and 6 against the role seed in 003:
-- boarding.ts already calls boarding.deny and boarding.noshow, and admin.ts
-- needs trip.publish and trip.status. A missing permission row means
-- has_permission() returns false and the operation is silently impossible for
-- every role — so these are added before the code that depends on them ships.

INSERT INTO role_permissions (role, permission) VALUES
  ('OPS_ADMIN','trip.publish'),
  ('OPS_ADMIN','trip.status'),
  ('OPS_ADMIN','boarding.deny'),
  ('OPS_ADMIN','boarding.noshow')
ON CONFLICT DO NOTHING;

-- SUPER_ADMIN mirrors OPS_ADMIN and keeps its exclusive powers.
INSERT INTO role_permissions (role, permission)
  SELECT 'SUPER_ADMIN', permission FROM role_permissions WHERE role = 'OPS_ADMIN'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- seat blocking
--
-- §13.4. A seat is taken out of sale for a reason (water damage, a broken belt,
-- a reserved escort seat). It must never take a seat somebody has bought, and
-- unblocking must never resurrect a stale booking reference.

CREATE FUNCTION block_seat(
  p_trip_id uuid, p_seat_number text, p_reason text, p_actor_id uuid
) RETURNS trip_seats AS $$
DECLARE s trip_seats;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 4 THEN
    RAISE EXCEPTION 'A reason is required to block a seat' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO s FROM trip_seats
    WHERE trip_id = p_trip_id AND seat_number = p_seat_number FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'seat % is not on this vehicle', p_seat_number USING ERRCODE = 'no_data_found';
  END IF;

  IF s.status = 'BOOKED' THEN
    RAISE EXCEPTION 'seat % is booked — cancel the booking first', p_seat_number
      USING ERRCODE = 'check_violation';
  END IF;
  IF s.status = 'BLOCKED' THEN
    RAISE EXCEPTION 'seat % is already blocked', p_seat_number USING ERRCODE = 'unique_violation';
  END IF;

  /* A live hold is displaced: the student has not paid, and the seat is unfit
   * to sell. Their next action fails with a clear conflict rather than a
   * mystery, which is why the hold is cleared rather than left dangling. */
  UPDATE trip_seats
     SET status = 'BLOCKED', block_reason = btrim(p_reason),
         hold_by = NULL, hold_guest_token = NULL, hold_expires_at = NULL,
         booking_id = NULL, updated_at = now()
   WHERE id = s.id
  RETURNING * INTO s;
  RETURN s;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION unblock_seat(p_trip_id uuid, p_seat_number text) RETURNS trip_seats AS $$
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
     SET status = 'AVAILABLE', block_reason = NULL, booking_id = NULL, updated_at = now()
   WHERE id = s.id
  RETURNING * INTO s;
  /* A freed seat may be owed to somebody waiting (F-02). */
  PERFORM offer_seat_to_waitlist(p_trip_id);
  RETURN s;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- vehicles
--
-- §4 / FR-015. The guard that matters: a seat configuration cannot change while
-- seats are sold, because renumbering under a paying student is a defect no
-- refund fixes. The prototype had this rule and no interface to reach it (F-14).

CREATE FUNCTION save_vehicle(
  p_id uuid,                      -- NULL to create
  p_name text,
  p_registration text,
  p_row_count int,
  p_status vehicle_status
) RETURNS vehicles AS $$
DECLARE v vehicles; sold int; affected int;
BEGIN
  IF p_name IS NULL OR length(btrim(p_name)) < 2 THEN
    RAISE EXCEPTION 'Enter a vehicle name' USING ERRCODE = 'check_violation';
  END IF;
  IF p_registration IS NULL OR length(btrim(p_registration)) < 6 THEN
    RAISE EXCEPTION 'Enter a valid registration' USING ERRCODE = 'check_violation';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO vehicles (name, registration, row_count, status)
    VALUES (btrim(p_name), btrim(p_registration), p_row_count, COALESCE(p_status, 'AVAILABLE'))
    RETURNING * INTO v;
    RETURN v;
  END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vehicle not found' USING ERRCODE = 'no_data_found';
  END IF;

  /* THE GUARD. Only a row-count change can invalidate bookings; name,
   * registration and status are always safe to correct. */
  IF p_row_count IS NOT NULL AND p_row_count <> v.row_count THEN
    SELECT count(*)::int INTO sold
      FROM trip_seats ts JOIN trips t ON t.id = ts.trip_id
     WHERE t.vehicle_id = p_id
       AND ts.status IN ('BOOKED','HELD')
       AND t.status NOT IN ('COMPLETED','CANCELLED');
    IF sold > 0 THEN
      RAISE EXCEPTION
        'Cannot change the seat configuration: % seat(s) are already held or booked on upcoming trips. Cancel or complete those trips first.',
        sold USING ERRCODE = 'check_violation';
    END IF;
    /* Also refuse if a future trip would end up with fewer seats than its
     * existing seat rows imply — belt and braces for a trip mid-setup. */
    SELECT count(*)::int INTO affected
      FROM trips t WHERE t.vehicle_id = p_id
        AND t.status IN ('OPEN','BOOKING_CLOSED','BOARDING');
    IF affected > 0 AND p_row_count < v.row_count THEN
      RAISE EXCEPTION
        'Cannot shrink the configuration while % trip(s) are open on this vehicle', affected
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE vehicles
     SET name = COALESCE(btrim(p_name), v.name),
         registration = COALESCE(btrim(p_registration), v.registration),
         row_count = COALESCE(p_row_count, v.row_count),
         status = COALESCE(p_status, v.status),
         updated_at = now()
   WHERE id = p_id
  RETURNING * INTO v;
  RETURN v;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- trip status
--
-- F-23. The prototype set statusPinned = true on ANY manual change and the
-- sweeper then refused to advance that trip forever — closing booking ten
-- minutes early meant hand-driving boarding, departure and completion for the
-- rest of that trip's life. Here a correction pins ONE transition, and the pin
-- expires at the next scheduled boundary.

CREATE FUNCTION set_trip_status(
  p_trip_id uuid, p_status trip_status, p_reason text, p_actor_id uuid
) RETURNS trips AS $$
DECLARE t trips; sold int;
BEGIN
  SELECT * INTO t FROM trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trip not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF t.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'a cancelled trip cannot change status' USING ERRCODE = 'check_violation';
  END IF;
  IF p_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'use cancel_trip, which handles refunds and notification'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE trips
     SET status = p_status,
         pinned_status = p_status,
         /* the pin covers this transition only; the clock resumes afterwards */
         pinned_until = LEAST(t.departure_at + interval '4 hours', now() + interval '6 hours'),
         updated_at = now()
   WHERE id = p_trip_id
  RETURNING * INTO t;
  RETURN t;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- reports
--
-- Every total is computed HERE, from the authoritative rows. No caller supplies
-- a figure and no caller adds anything up. F-22: the trip filter is applied in
-- the same view that produces the numbers, so a filter that is shown is a
-- filter that applies.

CREATE VIEW report_trip_summary AS
  SELECT t.id AS trip_id, t.departure_at, t.status AS trip_status,
         r.origin, r.destination, v.name AS vehicle, v.registration,
         (SELECT count(*)::int FROM trip_seats ts WHERE ts.trip_id = t.id) AS capacity,
         (SELECT count(*)::int FROM trip_seats ts
           WHERE ts.trip_id = t.id AND ts.status = 'BOOKED') AS seats_booked,
         (SELECT count(*)::int FROM trip_seats ts
           WHERE ts.trip_id = t.id AND ts.status = 'BLOCKED') AS seats_blocked,
         (SELECT count(*)::int FROM booking_passengers bp JOIN bookings b ON b.id = bp.booking_id
           WHERE b.trip_id = t.id AND b.status = 'CONFIRMED') AS passengers,
         (SELECT count(*)::int FROM booking_passengers bp JOIN bookings b ON b.id = bp.booking_id
           WHERE b.trip_id = t.id AND b.status = 'CONFIRMED'
             AND bp.boarding_status = 'BOARDED') AS boarded,
         (SELECT count(*)::int FROM booking_passengers bp JOIN bookings b ON b.id = bp.booking_id
           WHERE b.trip_id = t.id AND b.status = 'CONFIRMED'
             AND bp.boarding_status = 'NO_SHOW') AS no_shows,
         (SELECT count(*)::int FROM booking_passengers bp JOIN bookings b ON b.id = bp.booking_id
           WHERE b.trip_id = t.id AND b.status = 'CONFIRMED'
             AND bp.boarding_status = 'DENIED_BOARDING') AS denied,
         (SELECT COALESCE(sum(p.amount),0)::int FROM payments p JOIN bookings b ON b.id = p.booking_id
           WHERE b.trip_id = t.id AND p.status = 'SUCCESS') AS gross_rupees,
         (SELECT COALESCE(sum(rf.amount),0)::int FROM refunds rf JOIN bookings b ON b.id = rf.booking_id
           WHERE b.trip_id = t.id AND rf.status <> 'REFUND_FAILED') AS refunded_rupees,
         (SELECT count(*)::int FROM waitlist_entries w
           WHERE w.trip_id = t.id AND w.status IN ('WAITING','CLAIM_OFFERED')) AS waiting
    FROM trips t
    JOIN routes r ON r.id = t.route_id
    LEFT JOIN vehicles v ON v.id = t.vehicle_id;

-- Net revenue as one definition, so two reports cannot disagree.
CREATE VIEW report_revenue AS
  SELECT t.id AS trip_id, t.departure_at,
         s.gross_rupees, s.refunded_rupees,
         (s.gross_rupees - s.refunded_rupees) AS net_rupees
    FROM trips t JOIN report_trip_summary s ON s.trip_id = t.id;

-- ---------------------------------------------------------------- alerts
--
-- Operational conditions that need a human, derived rather than stored so they
-- cannot go stale: a payment that settled but could not be seated, a refund
-- that never dispatched, a boarding trip with no staff assigned.

CREATE VIEW operational_alerts AS
  SELECT 'LATE_SETTLEMENT' AS kind, b.id::text AS subject_id, b.code AS subject,
         'Payment received after the seats were released' AS detail,
         'P0' AS severity, p.updated_at AS since
    FROM bookings b JOIN payments p ON p.booking_id = b.id
   WHERE p.status = 'SUCCESS' AND b.status IN ('ABANDONED','CANCELLED_BY_STUDENT','CANCELLED_BY_DLT')
  UNION ALL
  SELECT 'REFUND_STUCK', r.id::text, b.code,
         'Refund has not reached the provider: ' || COALESCE(r.provider_status,'not dispatched'),
         'P1', r.created_at
    FROM refunds r JOIN bookings b ON b.id = r.booking_id
   WHERE r.status = 'REFUND_PENDING' AND r.created_at < now() - interval '1 hour'
  UNION ALL
  SELECT 'WEBHOOK_UNPROCESSED', e.id::text, COALESCE(e.subject_order_id,'unknown'),
         'Provider event recorded but not applied: ' || COALESCE(e.process_error,'pending'),
         'P1', e.received_at
    FROM provider_events e
   WHERE e.signature_ok = true
     AND (e.processed_at IS NULL OR e.process_error IS NOT NULL)
     AND e.received_at < now() - interval '15 minutes'
  UNION ALL
  SELECT 'BAD_SIGNATURE', e.id::text, COALESCE(e.subject_order_id,'unknown'),
         'A webhook failed signature verification', 'P1', e.received_at
    FROM provider_events e WHERE e.signature_ok = false
  UNION ALL
  SELECT 'NO_STAFF_ASSIGNED', t.id::text, to_char(t.departure_at,'Dy DD Mon HH24:MI'),
         'Boarding soon with no staff assigned', 'P1', t.departure_at
    FROM trips t
   WHERE t.status IN ('BOOKING_CLOSED','BOARDING')
     AND NOT EXISTS (SELECT 1 FROM trip_staff ts WHERE ts.trip_id = t.id)
  UNION ALL
  SELECT 'OFFER_EXPIRING', w.id::text, u.name,
         'Waitlist claim offer expires soon', 'P2', w.offer_expires_at
    FROM waitlist_entries w JOIN users u ON u.id = w.user_id
   WHERE w.status = 'CLAIM_OFFERED' AND w.offer_expires_at < now() + interval '10 minutes';

INSERT INTO schema_migrations (filename) VALUES ('008_admin_operations.sql');

COMMIT;
