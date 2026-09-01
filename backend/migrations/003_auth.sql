-- DLT · 003 · authentication support
--
-- 001 created users, user_credentials, sessions, password_resets,
-- email_verifications and login_attempts. This migration adds what the auth
-- SERVICE needs on top of those tables: the permission model that role checks
-- read from, and the columns the prototype's behaviour implies but 001 left out.
--
-- The permission table is data, not code, because Admin Spec §7 lists the
-- permissions per role and that list will change without a deploy.

BEGIN;

-- ---------------------------------------------------------------- profile

-- The prototype's publicUser() returns university; it is a real field and
-- belongs on the profile rather than being hardcoded in the client.
ALTER TABLE student_profiles
  ADD COLUMN university text NOT NULL DEFAULT 'Woxsen University';

-- §8.1 the emergency contact is structured, and is revealed to operations only
-- through an audited action — so it is stored apart from the fields a student
-- edits freely.
ALTER TABLE student_profiles
  ADD COLUMN emergency_contact_name  text,
  ADD COLUMN emergency_contact_phone text,
  ADD CONSTRAINT emergency_contact_pairs CHECK (
    (emergency_contact_name IS NULL) = (emergency_contact_phone IS NULL)
  );
ALTER TABLE student_profiles DROP COLUMN emergency_contact;

-- ---------------------------------------------------------------- permissions

CREATE TABLE role_permissions (
  role       user_role NOT NULL,
  permission text      NOT NULL,
  PRIMARY KEY (role, permission)
);

-- Admin Spec §7. Least privilege: BOARDING_STAFF can scan and read a manifest
-- and nothing else — no phone numbers, no manual boarding, no reports.
INSERT INTO role_permissions (role, permission) VALUES
  ('BOARDING_STAFF','boarding.scan'),
  ('BOARDING_STAFF','boarding.read'),

  ('OPS_ADMIN','boarding.scan'),
  ('OPS_ADMIN','boarding.read'),
  ('OPS_ADMIN','boarding.manual'),
  ('OPS_ADMIN','booking.read'),
  ('OPS_ADMIN','booking.cancel'),
  ('OPS_ADMIN','booking.contact'),
  ('OPS_ADMIN','payment.read'),
  ('OPS_ADMIN','payment.reconcile'),
  ('OPS_ADMIN','refund.create'),
  ('OPS_ADMIN','trip.read'),
  ('OPS_ADMIN','trip.write'),
  ('OPS_ADMIN','trip.cancel'),
  ('OPS_ADMIN','seat.block'),
  ('OPS_ADMIN','vehicle.read'),
  ('OPS_ADMIN','vehicle.write'),
  ('OPS_ADMIN','report.read'),
  ('OPS_ADMIN','report.export'),
  ('OPS_ADMIN','waitlist.read'),
  ('OPS_ADMIN','waitlist.reorder'),
  ('OPS_ADMIN','feedback.read'),
  ('OPS_ADMIN','feedback.moderate'),
  ('OPS_ADMIN','notification.read'),
  ('OPS_ADMIN','notification.resolve'),
  ('OPS_ADMIN','staff.assign'),
  ('OPS_ADMIN','student.read'),
  ('OPS_ADMIN','audit.read');

-- SUPER_ADMIN holds everything OPS_ADMIN holds, plus the money and identity
-- powers: the policy override, manual bookings, and reading a reset code at the
-- support desk.
INSERT INTO role_permissions (role, permission)
  SELECT 'SUPER_ADMIN', permission FROM role_permissions WHERE role = 'OPS_ADMIN';
INSERT INTO role_permissions (role, permission) VALUES
  ('SUPER_ADMIN','refund.override'),
  ('SUPER_ADMIN','booking.manual'),
  ('SUPER_ADMIN','user.write'),
  ('SUPER_ADMIN','auth.reset_lookup');

CREATE OR REPLACE FUNCTION has_permission(p_role user_role, p_permission text)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_permissions WHERE role = p_role AND permission = p_permission
  );
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------- sessions

-- Session hygiene the prototype had no notion of. A password change or an
-- approved deletion revokes every session the account holds; a role change
-- revokes them too, so a demoted admin cannot keep an admin session alive.
ALTER TABLE sessions
  ADD COLUMN revoked_reason text;

CREATE OR REPLACE FUNCTION revoke_user_sessions(p_user_id uuid, p_reason text)
RETURNS int AS $$
DECLARE n int;
BEGIN
  WITH gone AS (
    UPDATE sessions SET revoked_at = now(), revoked_reason = p_reason
     WHERE user_id = p_user_id AND revoked_at IS NULL AND expires_at > now()
    RETURNING id
  ) SELECT count(*) INTO n FROM gone;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- A session is valid only if it exists, is unexpired, is unrevoked, and belongs
-- to an ACTIVE account. All four in one place so no endpoint can check three.
CREATE OR REPLACE VIEW active_sessions AS
  SELECT s.id, s.user_id, s.token_hash, s.expires_at, s.last_seen_at,
         u.email, u.name, u.role, u.status, u.email_verified_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
   WHERE s.revoked_at IS NULL
     AND s.expires_at > now()
     AND u.status = 'ACTIVE';

-- ---------------------------------------------------------------- brute force

-- §7.1. The prototype keyed only on email, which let an attacker lock a known
-- student out at will. Keying on both email and IP means a single attacker
-- burns their own IP budget before the victim's account is affected, and the
-- window is fixed from the first failure so it cannot be extended.
ALTER TABLE login_attempts
  ADD COLUMN last_failure_at timestamptz;

CREATE OR REPLACE FUNCTION register_login_failure(
  p_key text, p_max int DEFAULT 5, p_window interval DEFAULT interval '15 minutes'
) RETURNS login_attempts AS $$
DECLARE a login_attempts;
BEGIN
  INSERT INTO login_attempts (key, failures, window_started_at, last_failure_at)
  VALUES (p_key, 1, now(), now())
  ON CONFLICT (key) DO UPDATE SET
    -- a lapsed window starts fresh; a live one is NEVER extended (F-06)
    failures = CASE WHEN login_attempts.window_started_at + p_window <= now()
                    THEN 1 ELSE login_attempts.failures + 1 END,
    window_started_at = CASE WHEN login_attempts.window_started_at + p_window <= now()
                    THEN now() ELSE login_attempts.window_started_at END,
    last_failure_at = now()
  RETURNING * INTO a;

  IF a.failures >= p_max THEN
    UPDATE login_attempts SET locked_until = a.window_started_at + p_window
      WHERE key = p_key RETURNING * INTO a;
  END IF;
  RETURN a;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION is_login_locked(p_key text) RETURNS timestamptz AS $$
  SELECT locked_until FROM login_attempts
   WHERE key = p_key AND locked_until IS NOT NULL AND locked_until > now();
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION clear_login_failures(p_key text) RETURNS void AS $$
  DELETE FROM login_attempts WHERE key = p_key;
$$ LANGUAGE sql;

-- ---------------------------------------------------------------- guest holds

-- The prototype adopts anonymous seat holds on sign-in (F-08/F-09). A guest is
-- a browser token, so holds need an owner that is not yet a user.
ALTER TABLE trip_seats
  ADD COLUMN hold_guest_token text;
ALTER TABLE trip_seats
  DROP CONSTRAINT trip_seats_allocation_coherent,
  ADD CONSTRAINT trip_seats_allocation_coherent CHECK (
    (status = 'AVAILABLE' AND booking_id IS NULL AND hold_by IS NULL AND hold_guest_token IS NULL) OR
    (status = 'HELD'      AND (hold_by IS NOT NULL OR hold_guest_token IS NOT NULL)
                          AND hold_expires_at IS NOT NULL) OR
    (status = 'BOOKED'    AND booking_id IS NOT NULL) OR
    (status = 'BLOCKED'   AND booking_id IS NULL AND block_reason IS NOT NULL)
  );
CREATE INDEX trip_seats_guest_hold_idx ON trip_seats (hold_guest_token)
  WHERE hold_guest_token IS NOT NULL;

INSERT INTO schema_migrations (filename) VALUES ('003_auth.sql');

COMMIT;
