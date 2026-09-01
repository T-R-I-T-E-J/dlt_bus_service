-- DLT · 001 · initial schema
-- PostgreSQL 15+. Forward-only. Runs as one transaction.
--
-- Entities and relationships follow Data Model & API Architecture Spec §1–§2.
-- Where a constraint exists to prevent a defect this audit reproduced, the
-- finding id is named in a comment. Those are not decoration: they are the
-- reason the constraint is declarative rather than left to application code.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;   -- case-insensitive email, per §7.1

CREATE TABLE schema_migrations (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- enums

CREATE TYPE user_role        AS ENUM ('STUDENT','BOARDING_STAFF','OPS_ADMIN','SUPER_ADMIN');
CREATE TYPE user_status      AS ENUM ('ACTIVE','SUSPENDED','DELETED');
CREATE TYPE trip_status      AS ENUM ('DRAFT','OPEN','BOOKING_CLOSED','BOARDING','DEPARTED','COMPLETED','CANCELLED');
CREATE TYPE seat_status      AS ENUM ('AVAILABLE','HELD','BOOKED','BLOCKED');
CREATE TYPE seat_type        AS ENUM ('WINDOW','AISLE');
CREATE TYPE booking_status   AS ENUM ('PENDING','PAYMENT_PENDING','PROCESSING','CONFIRMED',
                                      'ABANDONED','CANCELLED_BY_STUDENT','CANCELLED_BY_DLT');
CREATE TYPE booking_kind     AS ENUM ('ONLINE','MANUAL_COMPLIMENTARY','MANUAL_EXTERNAL');
CREATE TYPE payment_status   AS ENUM ('CREATED','PENDING','SUCCESS','FAILED','CANCELLED',
                                      'DUPLICATE','NOT_APPLICABLE');
CREATE TYPE refund_status    AS ENUM ('REFUND_PENDING','REFUNDED','REFUND_FAILED');
CREATE TYPE pass_status      AS ENUM ('VALID','VOID');
CREATE TYPE boarding_state   AS ENUM ('NOT_BOARDED','BOARDED','DENIED_BOARDING','NO_SHOW','CANCELLED');
CREATE TYPE scan_result      AS ENUM ('VALID','INVALID','ALREADY BOARDED','DENIED','NO_SHOW');
CREATE TYPE scan_method      AS ENUM ('SCAN','CODE','MANUAL');
CREATE TYPE waitlist_state   AS ENUM ('WAITING','CLAIM_OFFERED','CLAIMED','EXPIRED','CANCELLED','CONVERTED');
CREATE TYPE vehicle_status   AS ENUM ('AVAILABLE','MAINTENANCE','INACTIVE');
CREATE TYPE request_kind     AS ENUM ('GET_NOTIFIED','STUDENT_ID_CHANGE','ACCOUNT_DELETION');
CREATE TYPE request_status   AS ENUM ('PENDING','NOTIFIED','APPROVED','REJECTED');

-- ---------------------------------------------------------------- identity

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL,
  name              text   NOT NULL,
  phone             text,
  role              user_role   NOT NULL DEFAULT 'STUDENT',
  status            user_status NOT NULL DEFAULT 'ACTIVE',
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_phone_shape CHECK (phone IS NULL OR phone ~ '^[6-9][0-9]{9}$')
);
-- a deleted account keeps its row (financial records reference it) but frees
-- nothing: the email is rewritten at deletion, so uniqueness is unconditional.
CREATE UNIQUE INDEX users_email_key ON users (email);

-- F-06: credentials live in their own table and are never selected into any
-- client-facing view or join used by a read endpoint.
CREATE TABLE user_credentials (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash  text NOT NULL,           -- argon2id, encoded string incl. params
  kdf            text NOT NULL DEFAULT 'argon2id',
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE student_profiles (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  student_id         text NOT NULL,
  emergency_contact  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX student_profiles_student_id_key ON student_profiles (upper(student_id));

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,      -- sha256 of the cookie value; never the value
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  last_seen_at timestamptz,
  ip           inet,
  user_agent   text
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- F-06: reset codes are stored hashed, single-use, and never returned to a caller.
CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id) WHERE used_at IS NULL;

CREATE TABLE email_verifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

-- F-06: the lockout window is fixed from the FIRST failure so repeated attempts
-- cannot extend it against a victim. window_started_at is never bumped on retry.
CREATE TABLE login_attempts (
  key               text PRIMARY KEY,      -- lower(email) or 'ip:<addr>'
  failures          int  NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  locked_until      timestamptz
);

-- ---------------------------------------------------------------- fleet

CREATE TABLE vehicles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  registration text NOT NULL,
  row_count    int  NOT NULL CHECK (row_count BETWEEN 4 AND 20),
  capacity     int  GENERATED ALWAYS AS (row_count * 4) STORED,
  status       vehicle_status NOT NULL DEFAULT 'AVAILABLE',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vehicles_registration_key ON vehicles (upper(replace(registration,' ','')));

CREATE TABLE routes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  origin       text NOT NULL,
  destination  text NOT NULL,
  duration_min int  NOT NULL CHECK (duration_min > 0),
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE trips (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id       uuid NOT NULL REFERENCES routes(id),
  vehicle_id     uuid REFERENCES vehicles(id),
  departure_at   timestamptz NOT NULL,
  price          integer NOT NULL CHECK (price >= 0),   -- paise-free: whole rupees
  status         trip_status NOT NULL DEFAULT 'DRAFT',
  -- F-23: a manual correction pins ONE transition, not the trip forever.
  pinned_status  trip_status,
  pinned_until   timestamptz,
  cancel_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trips_departure_idx ON trips (departure_at);
CREATE INDEX trips_status_idx    ON trips (status) WHERE status IN ('OPEN','BOOKING_CLOSED','BOARDING');

-- F-19: the ONLY source of a boarding staff member's trip. The scanner derives
-- its trip from this table; a client-supplied trip id is never trusted.
CREATE TABLE trip_staff (
  trip_id     uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by uuid NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  reason      text,
  PRIMARY KEY (trip_id, user_id)
);
CREATE INDEX trip_staff_user_idx ON trip_staff (user_id);

-- ---------------------------------------------------------------- bookings

CREATE TABLE bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,          -- DLT-40219
  boarding_code   text NOT NULL UNIQUE,          -- WX3102, the F-11 fallback key
  trip_id         uuid NOT NULL REFERENCES trips(id),
  user_id         uuid REFERENCES users(id),     -- null for a manual booking with no account
  status          booking_status NOT NULL DEFAULT 'PENDING',
  kind            booking_kind   NOT NULL DEFAULT 'ONLINE',
  -- F-03: the fare is FROZEN onto the booking at creation. A later trip price
  -- change produces a repricing row, never a recomputation at payment time.
  unit_price      integer NOT NULL CHECK (unit_price >= 0),
  total_amount    integer NOT NULL CHECK (total_amount >= 0),
  contact_phone   text,
  hold_expires_at timestamptz,
  reprice_pending_at timestamptz,
  reprice_to      integer,
  manual_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_manual_needs_reason
    CHECK (kind = 'ONLINE' OR manual_reason IS NOT NULL),
  -- F-05: a complimentary booking is free, and being free is what makes a
  -- refund against it impossible (see refunds_within_receipts below).
  CONSTRAINT bookings_complimentary_is_free
    CHECK (kind <> 'MANUAL_COMPLIMENTARY' OR total_amount = 0)
);
CREATE INDEX bookings_trip_idx ON bookings (trip_id);
CREATE INDEX bookings_user_idx ON bookings (user_id);
CREATE INDEX bookings_hold_sweep_idx ON bookings (hold_expires_at)
  WHERE status IN ('PENDING','PAYMENT_PENDING');

-- Seats are materialised per trip so that allocation is a row lock on a real
-- row rather than a computation over bookings.
CREATE TABLE trip_seats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id         uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seat_number     text NOT NULL,                 -- 1A … 11D
  seat_row        int  NOT NULL,
  seat_type       seat_type NOT NULL,
  status          seat_status NOT NULL DEFAULT 'AVAILABLE',
  booking_id      uuid REFERENCES bookings(id) ON DELETE SET NULL,
  hold_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  hold_expires_at timestamptz,
  block_reason    text,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- §4 UNIQUE ACTIVE SEAT. One row per seat per trip is the allocation unit;
  -- allocation takes SELECT … FOR UPDATE on this row, so two devices racing for
  -- 2B serialise on the lock and the loser sees status <> 'AVAILABLE'.
  CONSTRAINT trip_seats_unique_seat UNIQUE (trip_id, seat_number),

  -- F-01: a seat that is spoken for must say who by, and a free seat must not
  -- carry a stale owner. This is the constraint the late-settlement bug walked
  -- straight through when it overwrote booking_id on a seat owned by someone else.
  CONSTRAINT trip_seats_allocation_coherent CHECK (
    (status = 'AVAILABLE' AND booking_id IS NULL AND hold_by IS NULL) OR
    (status = 'HELD'      AND hold_by IS NOT NULL AND hold_expires_at IS NOT NULL) OR
    (status = 'BOOKED'    AND booking_id IS NOT NULL) OR
    (status = 'BLOCKED'   AND booking_id IS NULL AND block_reason IS NOT NULL)
  )
);
CREATE INDEX trip_seats_trip_idx ON trip_seats (trip_id);
-- F-01: at most one BOOKED allocation per seat, enforced by the database rather
-- than by whichever code path happens to run last.
CREATE UNIQUE INDEX trip_seats_one_booking_per_seat
  ON trip_seats (trip_id, seat_number) WHERE status = 'BOOKED';
CREATE INDEX trip_seats_hold_sweep_idx ON trip_seats (hold_expires_at) WHERE status = 'HELD';

CREATE TABLE booking_passengers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  trip_seat_id    uuid REFERENCES trip_seats(id) ON DELETE SET NULL,
  name            text NOT NULL,
  student_id      text NOT NULL,
  phone           text,
  seat_number     text NOT NULL,
  seat_type       seat_type NOT NULL,
  boarding_status boarding_state NOT NULL DEFAULT 'NOT_BOARDED',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_passengers_booking_idx ON booking_passengers (booking_id);

-- ---------------------------------------------------------------- money

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          uuid NOT NULL REFERENCES bookings(id),
  amount              integer NOT NULL CHECK (amount >= 0),
  status              payment_status NOT NULL DEFAULT 'CREATED',
  provider            text NOT NULL DEFAULT 'CASHFREE',
  provider_order_id   text,
  provider_reference  text,
  failure_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_provider_order_key ON payments (provider_order_id)
  WHERE provider_order_id IS NOT NULL;
CREATE INDEX payments_booking_idx ON payments (booking_id);
-- At most one settled payment per booking; a second success is a DUPLICATE and
-- must be refunded, not silently accepted.
CREATE UNIQUE INDEX payments_one_success_per_booking
  ON payments (booking_id) WHERE status = 'SUCCESS';

-- §5 idempotency + replay protection. The webhook handler verifies the
-- signature, inserts here, and returns 200. A replayed delivery collides on
-- provider_event_id and is a no-op — the F-01 duplicate-webhook path.
CREATE TABLE provider_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           text NOT NULL DEFAULT 'CASHFREE',
  provider_event_id  text NOT NULL,
  payment_id         uuid REFERENCES payments(id),
  refund_id          uuid,
  kind               text NOT NULL,
  raw_body           jsonb NOT NULL,
  signature_ok       boolean NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  process_error      text,
  CONSTRAINT provider_events_unique UNIQUE (provider, provider_event_id)
);
CREATE INDEX provider_events_unprocessed_idx ON provider_events (received_at)
  WHERE processed_at IS NULL;

CREATE TABLE refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         uuid NOT NULL REFERENCES bookings(id),
  payment_id         uuid REFERENCES payments(id),
  -- F-05 / F-12: a refund is a positive amount or it is not a refund. The
  -- prototype raised ₹259 against a ₹0 booking and reported "Override applied"
  -- on a zero-value action; both are now unrepresentable.
  amount             integer NOT NULL CHECK (amount > 0),
  status             refund_status NOT NULL DEFAULT 'REFUND_PENDING',
  is_override        boolean NOT NULL DEFAULT false,
  reason             text NOT NULL,
  requested_by       uuid REFERENCES users(id),
  provider_reference text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refunds_override_needs_actor
    CHECK (NOT is_override OR requested_by IS NOT NULL)
);
CREATE INDEX refunds_booking_idx ON refunds (booking_id);

-- F-05: money out can never exceed money in, for any booking, by any path —
-- policy refund, override, or duplicate-payment return. A trigger rather than a
-- CHECK because the rule spans rows.
CREATE OR REPLACE FUNCTION refunds_within_receipts() RETURNS trigger AS $$
DECLARE
  received integer;
  returned integer;
BEGIN
  SELECT COALESCE(sum(amount),0) INTO received
    FROM payments WHERE booking_id = NEW.booking_id AND status IN ('SUCCESS','DUPLICATE');
  SELECT COALESCE(sum(amount),0) INTO returned
    FROM refunds  WHERE booking_id = NEW.booking_id AND status <> 'REFUND_FAILED'
                    AND id <> NEW.id;
  IF returned + NEW.amount > received THEN
    RAISE EXCEPTION
      'refund of % exceeds refundable balance (received %, already returned %) on booking %',
      NEW.amount, received, returned, NEW.booking_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refunds_within_receipts_trg
  BEFORE INSERT OR UPDATE OF amount ON refunds
  FOR EACH ROW EXECUTE FUNCTION refunds_within_receipts();

-- §5 general idempotency for POSTs carrying an Idempotency-Key header.
CREATE TABLE idempotency_keys (
  key           text PRIMARY KEY,
  user_id       uuid REFERENCES users(id),
  endpoint      text NOT NULL,
  request_hash  text NOT NULL,
  response_code int,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

-- ---------------------------------------------------------------- boarding

CREATE TABLE boarding_passes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passenger_id  uuid NOT NULL UNIQUE REFERENCES booking_passengers(id) ON DELETE CASCADE,
  booking_id    uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  trip_id       uuid NOT NULL REFERENCES trips(id),
  qr_token      text NOT NULL UNIQUE,
  status        pass_status NOT NULL DEFAULT 'VALID',
  issued_at     timestamptz NOT NULL DEFAULT now(),
  voided_at     timestamptz
);
CREATE INDEX boarding_passes_trip_idx ON boarding_passes (trip_id);

-- Every scan attempt is recorded, including the invalid ones. Append-only.
CREATE TABLE boarding_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid REFERENCES trips(id),
  passenger_id  uuid REFERENCES booking_passengers(id),
  staff_user_id uuid NOT NULL REFERENCES users(id),
  result        scan_result NOT NULL,
  method        scan_method NOT NULL DEFAULT 'SCAN',
  reason        text,
  token_prefix  text,                    -- F-28: never the whole token
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boarding_events_trip_idx ON boarding_events (trip_id, occurred_at DESC);

-- ---------------------------------------------------------------- waitlist, reviews, requests

CREATE TABLE waitlist_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id           uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seats_wanted      int  NOT NULL DEFAULT 1 CHECK (seats_wanted BETWEEN 1 AND 4),
  position          int  NOT NULL,
  status            waitlist_state NOT NULL DEFAULT 'WAITING',
  -- F-02: the seat held FOR this student during the claim window. Without it an
  -- offer is an announcement rather than a reservation.
  reserved_seat_id  uuid REFERENCES trip_seats(id) ON DELETE SET NULL,
  offered_at        timestamptz,
  offer_expires_at  timestamptz,
  booking_id        uuid REFERENCES bookings(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waitlist_offer_has_expiry
    CHECK (status <> 'CLAIM_OFFERED' OR (offer_expires_at IS NOT NULL AND reserved_seat_id IS NOT NULL))
);
CREATE UNIQUE INDEX waitlist_one_active_per_user_per_trip
  ON waitlist_entries (trip_id, user_id) WHERE status IN ('WAITING','CLAIM_OFFERED');
CREATE UNIQUE INDEX waitlist_one_offer_per_seat
  ON waitlist_entries (reserved_seat_id) WHERE status = 'CLAIM_OFFERED';
CREATE INDEX waitlist_offer_sweep_idx ON waitlist_entries (offer_expires_at)
  WHERE status = 'CLAIM_OFFERED';

CREATE TABLE reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      int  NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     text,
  hidden_at   timestamptz,
  hidden_by   uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reviews_one_per_booking UNIQUE (booking_id)
);

CREATE TABLE notification_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            request_kind NOT NULL,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  trip_id         uuid REFERENCES trips(id) ON DELETE SET NULL,
  email           text,
  requested_value text,                  -- the new student id, for ID changes
  current_value   text,
  reason          text,
  status          request_status NOT NULL DEFAULT 'PENDING',
  decided_at      timestamptz,
  decided_by      uuid REFERENCES users(id),
  decision_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT requests_decision_needs_reason
    CHECK (status NOT IN ('APPROVED','REJECTED') OR decision_reason IS NOT NULL)
);
-- F-15: one open deletion or ID-change request per person at a time.
CREATE UNIQUE INDEX requests_one_open_per_kind
  ON notification_requests (user_id, kind) WHERE status = 'PENDING';

-- ---------------------------------------------------------------- audit

-- Admin Spec §9–§10: operational records are never deleted. The prototype
-- truncated this table to 600 rows; there is deliberately no trigger, no
-- retention job and no cap here. Archive by partition, never by DELETE.
CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  actor_id     uuid REFERENCES users(id),
  actor_name   text,
  actor_role   user_role,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  before_value text,
  after_value  text,
  reason       text,
  ip           inet,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx   ON audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_actor_idx    ON audit_logs (actor_id, occurred_at DESC);
CREATE INDEX audit_logs_action_idx   ON audit_logs (action, occurred_at DESC);

REVOKE DELETE, TRUNCATE ON audit_logs FROM PUBLIC;
REVOKE UPDATE ON audit_logs FROM PUBLIC;

INSERT INTO schema_migrations (filename) VALUES ('001_init.sql');

COMMIT;
