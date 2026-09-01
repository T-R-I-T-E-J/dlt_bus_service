-- DLT · database foundation tests
--
-- Run against a THROWAWAY database:
--   createdb dlt_test && psql dlt_test -f migrations/001_init.sql \
--     -f migrations/002_seat_allocation.sql -f test/001_schema.test.sql
--
-- Every assertion below tests a constraint that exists because this audit
-- reproduced the defect it prevents. A passing run proves the schema refuses
-- the bad state; it does not prove the application uses the schema correctly.
-- That is what the integration tests in the next phase are for.
--
-- NOT YET EXECUTED. This environment has no PostgreSQL.

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION must_fail(sql text, label text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS  %  (refused: %)', label, left(SQLERRM, 90);
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL  % — the database ACCEPTED what it must refuse', label;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION must_hold(cond boolean, label text) RETURNS void AS $$
BEGIN
  IF cond THEN RAISE NOTICE 'PASS  %', label;
  ELSE RAISE EXCEPTION 'FAIL  %', label; END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- fixtures

INSERT INTO users (id, email, name, role) VALUES
  ('11111111-1111-1111-1111-111111111111','a@woxsen.edu.in','Student A','STUDENT'),
  ('22222222-2222-2222-2222-222222222222','b@woxsen.edu.in','Student B','STUDENT'),
  ('33333333-3333-3333-3333-333333333333','staff@dlt.co.in','Door Staff','BOARDING_STAFF'),
  ('44444444-4444-4444-4444-444444444444','super@dlt.co.in','Super','SUPER_ADMIN');

INSERT INTO routes (id, code, origin, destination, duration_min)
  VALUES ('55555555-5555-5555-5555-555555555555','WX-MYP','Woxsen','Miyapur Metro',75);
INSERT INTO vehicles (id, name, registration, row_count)
  VALUES ('66666666-6666-6666-6666-666666666666','DLT-01','TS07 AA 1111',11);
INSERT INTO trips (id, route_id, vehicle_id, departure_at, price, status)
  VALUES ('77777777-7777-7777-7777-777777777777',
          '55555555-5555-5555-5555-555555555555',
          '66666666-6666-6666-6666-666666666666',
          now() + interval '2 days', 259, 'OPEN');

SELECT must_hold(materialise_trip_seats('77777777-7777-7777-7777-777777777777') = 44,
  'a trip materialises 44 seats from an 11-row vehicle');

-- ---------------------------------------------------------------- identity

SELECT must_fail($$INSERT INTO users (email,name) VALUES ('A@WOXSEN.EDU.IN','Dup')$$,
  'email uniqueness is case-insensitive');
SELECT must_fail($$INSERT INTO users (email,name,phone) VALUES ('c@x.in','C','12345')$$,
  'a malformed phone number is refused');

-- ---------------------------------------------------------------- seat holds (§4)

SELECT must_hold((hold_seat('77777777-7777-7777-7777-777777777777','2B',
  '11111111-1111-1111-1111-111111111111')).status = 'HELD',
  'a free seat can be held');

SELECT must_fail($$SELECT hold_seat('77777777-7777-7777-7777-777777777777','2B',
  '22222222-2222-2222-2222-222222222222')$$,
  'F-01 · a second student cannot hold a seat that is already held');

SELECT must_hold((hold_seat('77777777-7777-7777-7777-777777777777','2B',
  '11111111-1111-1111-1111-111111111111')).status = 'HELD',
  'the holder may extend their own hold');

-- an expired hold is free again
UPDATE trip_seats SET hold_expires_at = now() - interval '1 minute'
  WHERE trip_id = '77777777-7777-7777-7777-777777777777' AND seat_number = '2B';
SELECT must_hold((hold_seat('77777777-7777-7777-7777-777777777777','2B',
  '22222222-2222-2222-2222-222222222222')).hold_by = '22222222-2222-2222-2222-222222222222',
  'an expired hold is claimable by the next student');

-- ---------------------------------------------------------------- allocation (F-01)

INSERT INTO bookings (id, code, boarding_code, trip_id, user_id, status, unit_price, total_amount, hold_expires_at)
VALUES ('88888888-8888-8888-8888-888888888888','DLT-10001','WX1001',
        '77777777-7777-7777-7777-777777777777','22222222-2222-2222-2222-222222222222',
        'PAYMENT_PENDING',259,259, now() + interval '10 minutes');

SELECT must_hold((allocate_seat_to_booking(
    (SELECT id FROM trip_seats WHERE trip_id='77777777-7777-7777-7777-777777777777' AND seat_number='2B'),
    '88888888-8888-8888-8888-888888888888')).status = 'BOOKED',
  'a held seat allocates to its own booking');

SELECT must_hold((allocate_seat_to_booking(
    (SELECT id FROM trip_seats WHERE trip_id='77777777-7777-7777-7777-777777777777' AND seat_number='2B'),
    '88888888-8888-8888-8888-888888888888')).status = 'BOOKED',
  '§5 · re-allocating the same seat to the same booking is idempotent');

-- the exact defect: an abandoned booking whose payment lands late
INSERT INTO bookings (id, code, boarding_code, trip_id, user_id, status, unit_price, total_amount)
VALUES ('99999999-9999-9999-9999-999999999999','DLT-10002','WX1002',
        '77777777-7777-7777-7777-777777777777','11111111-1111-1111-1111-111111111111',
        'ABANDONED',259,259);

SELECT must_fail($$SELECT allocate_seat_to_booking(
    (SELECT id FROM trip_seats WHERE trip_id='77777777-7777-7777-7777-777777777777' AND seat_number='2B'),
    '99999999-9999-9999-9999-999999999999')$$,
  'F-01 · a late settlement cannot resurrect an ABANDONED booking');

SELECT must_hold(
  (SELECT booking_id FROM trip_seats
     WHERE trip_id='77777777-7777-7777-7777-777777777777' AND seat_number='2B')
  = '88888888-8888-8888-8888-888888888888',
  'F-01 · and the seat still belongs to the student who actually paid');

SELECT must_fail($$UPDATE trip_seats SET status='AVAILABLE'
  WHERE trip_id='77777777-7777-7777-7777-777777777777' AND seat_number='2B'$$,
  'a booked seat cannot be freed while it still names a booking');

-- ---------------------------------------------------------------- money (F-05, F-12)

SELECT must_fail($$INSERT INTO refunds (booking_id,amount,reason)
  VALUES ('88888888-8888-8888-8888-888888888888',0,'zero override')$$,
  'F-12 · a zero-value refund is not representable');

SELECT must_fail($$INSERT INTO refunds (booking_id,amount,reason)
  VALUES ('88888888-8888-8888-8888-888888888888',259,'refund with no payment received')$$,
  'F-05 · a refund cannot exceed money actually received');

INSERT INTO payments (id, booking_id, amount, status, provider_order_id)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','88888888-8888-8888-8888-888888888888',
        259,'SUCCESS','cf_order_1');

INSERT INTO refunds (booking_id, amount, reason)
  VALUES ('88888888-8888-8888-8888-888888888888',100,'Departure retimed');
SELECT must_hold(true, 'a partial refund within receipts is accepted');

SELECT must_fail($$INSERT INTO refunds (booking_id,amount,reason)
  VALUES ('88888888-8888-8888-8888-888888888888',200,'second bite')$$,
  'F-05 · refunds in aggregate cannot exceed receipts');

SELECT must_fail($$INSERT INTO payments (booking_id,amount,status)
  VALUES ('88888888-8888-8888-8888-888888888888',259,'SUCCESS')$$,
  'a booking cannot hold two successful payments');

SELECT must_fail($$INSERT INTO provider_events (provider_event_id,kind,raw_body,signature_ok)
  VALUES ('cf_evt_1','PAYMENT_SUCCESS','{}'::jsonb,true),
         ('cf_evt_1','PAYMENT_SUCCESS','{}'::jsonb,true)$$,
  '§5 · a replayed webhook collides on the provider event id');

-- complimentary bookings
SELECT must_fail($$INSERT INTO bookings (code,boarding_code,trip_id,status,kind,unit_price,total_amount,manual_reason)
  VALUES ('DLT-10003','WX1003','77777777-7777-7777-7777-777777777777','CONFIRMED',
          'MANUAL_COMPLIMENTARY',259,259,'escort')$$,
  'F-05 · a complimentary booking cannot carry a fare');
SELECT must_fail($$INSERT INTO bookings (code,boarding_code,trip_id,status,kind,unit_price,total_amount)
  VALUES ('DLT-10004','WX1004','77777777-7777-7777-7777-777777777777','CONFIRMED',
          'MANUAL_EXTERNAL',259,259)$$,
  'a manual booking without a reason is refused');

-- ---------------------------------------------------------------- requests (F-15)

INSERT INTO notification_requests (kind,user_id,reason)
  VALUES ('ACCOUNT_DELETION','11111111-1111-1111-1111-111111111111','Graduating');
SELECT must_fail($$INSERT INTO notification_requests (kind,user_id,reason)
  VALUES ('ACCOUNT_DELETION','11111111-1111-1111-1111-111111111111','Asking again')$$,
  'F-15 · a second open deletion request is refused');
SELECT must_fail($$UPDATE notification_requests SET status='APPROVED'
  WHERE user_id='11111111-1111-1111-1111-111111111111'$$,
  'F-13 · a decision without a reason is refused');

-- ---------------------------------------------------------------- waitlist (F-02)

SELECT must_fail($$INSERT INTO waitlist_entries (trip_id,user_id,position,status)
  VALUES ('77777777-7777-7777-7777-777777777777','11111111-1111-1111-1111-111111111111',
          1,'CLAIM_OFFERED')$$,
  'F-02 · an offer without a reserved seat and an expiry is refused');

INSERT INTO waitlist_entries (trip_id,user_id,position)
  VALUES ('77777777-7777-7777-7777-777777777777','11111111-1111-1111-1111-111111111111',1);
SELECT must_fail($$INSERT INTO waitlist_entries (trip_id,user_id,position)
  VALUES ('77777777-7777-7777-7777-777777777777','11111111-1111-1111-1111-111111111111',2)$$,
  'one active waitlist entry per student per trip');

SELECT must_hold((offer_seat_to_waitlist('77777777-7777-7777-7777-777777777777')).status
  = 'CLAIM_OFFERED', 'F-02 · a released seat is offered to the first student waiting');
SELECT must_hold(
  (SELECT status FROM trip_seats WHERE id =
     (SELECT reserved_seat_id FROM waitlist_entries WHERE status='CLAIM_OFFERED' LIMIT 1)) = 'HELD',
  'F-02 · and that seat is genuinely reserved, not merely announced');

-- ---------------------------------------------------------------- audit (§9–10)

INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,reason)
  VALUES ('44444444-4444-4444-4444-444444444444','refund.policy_override','booking','DLT-10001','Retimed');
SELECT must_hold((SELECT count(*) FROM audit_logs) = 1, 'audit entries persist');
-- retention: there is deliberately no cap, no trigger and no job. The prototype
-- truncated to 600 rows; Admin Spec §9–10 says operational records are never
-- deleted. Nothing to assert except that nothing removes them.

ROLLBACK;

\echo ''
\echo 'All assertions above printed PASS, or the run stopped at the first FAIL.'
\echo 'Concurrency is NOT covered here — see test/concurrency.md, which needs two sessions.'
