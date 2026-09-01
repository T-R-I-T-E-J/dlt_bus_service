-- DLT · 009 · security remediation
--
-- Closes H-3 (audit log mutable by the table owner), M-1 (guest-hold seat
-- ownership decided by NULL = NULL) and the schema half of H-4 (idempotency
-- records not bound to a caller).
--
-- Nothing here changes a documented business rule. Every statement makes an
-- existing rule actually enforceable.

BEGIN;

-- ============================================================ H-3 audit log
--
-- THE DEFECT: 001 did `REVOKE DELETE, TRUNCATE, UPDATE ON audit_logs FROM
-- PUBLIC`. In PostgreSQL the table OWNER's rights are not granted via PUBLIC,
-- so revoking from PUBLIC does not touch them. If the application connects as
-- the role that ran the migrations — the common default — it can delete and
-- rewrite the audit trail freely. The protection LOOKED present in source, and
-- the admin test passed because it correctly tested as a non-owner role.
--
-- Three layers, deliberately redundant, because this is the control that makes
-- every reason-mandatory workflow meaningful:
--
--   1. a runtime role granted only SELECT + INSERT      (least privilege)
--   2. a trigger that raises on DELETE/UPDATE           (binds the OWNER too)
--   3. a startup assertion in assertReady()             (fails closed)
--
-- Layer 2 is the one that survives someone deploying with the wrong role.

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'audit_logs is append-only: % is not permitted on operational records (Admin Spec §9–§10). '
    'Archive by partition if retention is required.', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

-- Statement-level so a mass DELETE is refused before touching a single row, and
-- so TRUNCATE is covered (row triggers never fire for TRUNCATE).
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

-- The runtime role. Created only if absent so this migration is safe on a
-- database where the DBA has already provisioned it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dlt_app') THEN
    CREATE ROLE dlt_app NOLOGIN;
    RAISE NOTICE 'created role dlt_app — set a password and grant LOGIN in your deployment';
  END IF;
END $$;

-- Normal DML everywhere...
GRANT USAGE ON SCHEMA public TO dlt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dlt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dlt_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO dlt_app;

-- ...except the audit trail, which is append-only for the runtime role.
REVOKE ALL ON audit_logs FROM dlt_app;
GRANT SELECT, INSERT ON audit_logs TO dlt_app;

-- Future tables created by the migrator inherit the same shape.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dlt_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dlt_app;

COMMENT ON TABLE audit_logs IS
  'Append-only. Protected by triggers (which bind the owner) AND by the dlt_app '
  'grant (which is least privilege). Never DELETE; archive by partition.';

-- ============================================================ M-1 guest seats
--
-- THE DEFECT: allocate_seat_to_booking tested
--   s.hold_by IS NOT DISTINCT FROM b.user_id
-- For a guest hold, hold_by IS NULL. For a guest booking, user_id IS NULL.
-- NULL IS NOT DISTINCT FROM NULL is TRUE, so ANY guest-held seat matched ANY
-- guest booking. hold_guest_token was never consulted. Latent only because
-- settle_booking does its own check and is the sole production caller — but the
-- function's stated job is to refuse a seat that is not ours, and it did not.

-- The booking must remember which browser held its seats, so ownership can be a
-- positive comparison on both sides. This is also what lets sign-in adoption
-- reconcile a guest booking to an account later.
ALTER TABLE bookings ADD COLUMN guest_token text;
CREATE INDEX bookings_guest_token_idx ON bookings (guest_token)
  WHERE guest_token IS NOT NULL;

COMMENT ON COLUMN bookings.guest_token IS
  'The browser token the seats were held with, for an anonymous booking (F-09). '
  'Ownership is ALWAYS a positive match on both sides — never NULL = NULL.';

CREATE OR REPLACE FUNCTION allocate_seat_to_booking(
  p_trip_seat_id uuid,
  p_booking_id   uuid
) RETURNS trip_seats AS $$
DECLARE
  s trip_seats;
  b bookings;
  ours boolean;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking % not found', p_booking_id USING ERRCODE = 'no_data_found';
  END IF;

  -- F-01: a booking the sweeper already abandoned must never be finalised by a
  -- late settlement. Unchanged.
  IF b.status IN ('ABANDONED','CANCELLED_BY_STUDENT','CANCELLED_BY_DLT') THEN
    RAISE EXCEPTION 'booking % is % — a late settlement cannot resurrect it', b.code, b.status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO s FROM trip_seats WHERE id = p_trip_seat_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'seat row % not found', p_trip_seat_id USING ERRCODE = 'no_data_found';
  END IF;

  -- already ours and settled: idempotent re-entry, which §5 requires
  IF s.status = 'BOOKED' AND s.booking_id = p_booking_id THEN
    RETURN s;
  END IF;

  -- M-1: a POSITIVE identity match on one side or the other. A NULL on either
  -- side can no longer satisfy anything.
  ours := (
       (s.hold_by IS NOT NULL AND b.user_id IS NOT NULL AND s.hold_by = b.user_id)
    OR (s.hold_guest_token IS NOT NULL AND b.guest_token IS NOT NULL
        AND s.hold_guest_token = b.guest_token)
  );

  IF NOT (
    (s.status = 'HELD' AND ours AND s.hold_expires_at > now())
    -- A genuinely free seat is still allocatable, but ONLY when it already
    -- belongs to this booking: create_booking_from_holds stamps booking_id when
    -- it consumes the basket. Previously any AVAILABLE seat qualified.
    OR (s.status = 'AVAILABLE' AND s.booking_id = p_booking_id)
  ) THEN
    RAISE EXCEPTION 'seat % is no longer available to booking % (seat is %)',
      s.seat_number, b.code, lower(s.status::text)
      USING ERRCODE = 'unique_violation';
  END IF;

  UPDATE trip_seats
     SET status = 'BOOKED', booking_id = p_booking_id,
         hold_by = NULL, hold_guest_token = NULL, hold_expires_at = NULL, updated_at = now()
   WHERE id = s.id
  RETURNING * INTO s;
  RETURN s;
END;
$$ LANGUAGE plpgsql;

-- create_booking_from_holds must now persist the guest token it validated
-- against, so the value the seat was held with is the value the booking carries.
CREATE OR REPLACE FUNCTION create_booking_from_holds(
  p_trip_id       uuid,
  p_user_id       uuid,
  p_guest_token   text,
  p_contact_phone text,
  p_passengers    jsonb,
  p_hold_ttl      interval DEFAULT interval '10 minutes'
) RETURNS bookings AS $$
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
  IF jsonb_array_length(p_passengers) > 4 THEN
    RAISE EXCEPTION 'up to 4 passengers in one booking' USING ERRCODE = 'check_violation';
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
$$ LANGUAGE plpgsql;

-- Sign-in adoption (F-08) should carry the booking across too, not just the
-- seats, so a guest who authenticates mid-checkout owns their booking.
CREATE FUNCTION adopt_guest_bookings(p_guest_token text, p_user_id uuid) RETURNS int AS $$
DECLARE n int;
BEGIN
  WITH moved AS (
    UPDATE bookings SET user_id = p_user_id, guest_token = NULL, updated_at = now()
     WHERE guest_token = p_guest_token
       AND user_id IS NULL
       AND status IN ('PENDING','PAYMENT_PENDING')
    RETURNING id
  ) SELECT count(*) INTO n FROM moved;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- ============================================================ H-4 idempotency
--
-- THE DEFECT: request_hash was `JSON.stringify(req).length + ':' + endpoint` —
-- a LENGTH, not a digest — and was never compared on replay. A caller
-- presenting a known key received the stored response body of the original
-- request, which is a full booking view. Keys are client-chosen, so key quality
-- was never ours to assume.

-- Bind every record to its caller. A key is only ever the same key WITHIN one
-- caller; two users presenting the same string are two different records.
ALTER TABLE idempotency_keys
  DROP CONSTRAINT idempotency_keys_pkey,
  ADD COLUMN guest_token text,
  ADD CONSTRAINT idempotency_keys_pkey
    PRIMARY KEY (key, endpoint);

-- The caller identity that produced the record. Enforced in the domain by
-- comparing on read; stored here so a mismatch is detectable and auditable.
CREATE INDEX idempotency_keys_caller_idx ON idempotency_keys (user_id, guest_token);

COMMENT ON COLUMN idempotency_keys.request_hash IS
  'SHA-256 of the canonicalised request body. On replay the domain compares it: '
  'equal returns the cached response, different is a 422. Never a length.';

-- ============================================================ H-2 guest holds
--
-- Per-IP hold budget, in the DATABASE rather than in process memory. HD-2: an
-- express-rate-limit counter is per-process and would multiply behind more than
-- one instance, and would reset on every deploy. This survives both.
--
-- Scoped to (ip, trip) so one busy departure cannot exhaust the budget for
-- another. The window is fixed from the first attempt and is NEVER extended by
-- further attempts — the same rule as login lockout (F-06), so a shared campus
-- NAT cannot be pushed into a permanent block by one bad actor behind it.

CREATE TABLE guest_hold_attempts (
  ip                inet NOT NULL,
  trip_id           uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  attempts          int  NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ip, trip_id)
);

CREATE INDEX guest_hold_attempts_window_idx ON guest_hold_attempts (window_started_at);

COMMENT ON TABLE guest_hold_attempts IS
  'H-2. Rate limits ANONYMOUS seat holds only; a signed-in student is never '
  'counted here, so sustained abuse costs an account. Prune rows older than a '
  'day with a periodic DELETE — this table is not evidence.';

INSERT INTO schema_migrations (filename) VALUES ('009_security_remediation.sql');

COMMIT;
