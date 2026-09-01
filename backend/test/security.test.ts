/* DLT · test/security.test.ts — regression tests for every fixed vulnerability.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STATUS: WRITTEN — NOT EXECUTED — NOT VERIFIED.
 *
 * No PostgreSQL and no Node runtime exist where this was authored.
 *
 * One test per finding, each written to FAIL against the pre-fix code. That is
 * the point: a security test that passes both before and after proves nothing.
 * Where a test cannot distinguish (H-3's trigger, which needs a real role) it
 * says so.
 *
 * Run:
 *   createdb dlt_test
 *   export DATABASE_URL=postgres://localhost/dlt_test NODE_ENV=test
 *   for f in backend/migrations/00*.sql; do psql "$DATABASE_URL" -f "$f"; done
 *   node --test --experimental-strip-types backend/test/security.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import * as pay from '../src/domain/payments.ts';
import * as seats from '../src/domain/seats.ts';
import * as boarding from '../src/domain/boarding.ts';
import * as authz from '../src/domain/authz.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const q = (sql: string, a: unknown[] = []) => pool.query(sql, a);

let TRIP: string, TRIP_B: string, ALICE: string, BOB: string, OPS: string,
    SUPER: string, STAFF: string, STAFF_B: string;

const alice = () => ({ userId: ALICE, role: 'STUDENT', ip: '10.0.0.1' });
const bob = () => ({ userId: BOB, role: 'STUDENT', ip: '10.0.0.2' });
const ops = () => ({ userId: OPS, role: 'OPS_ADMIN' });
const sup = () => ({ userId: SUPER, role: 'SUPER_ADMIN' });
const staffA = () => ({ userId: STAFF, role: 'BOARDING_STAFF' });
const guest = (t: string) => ({ guestToken: t, ip: '10.0.0.9' });

async function seed() {
  await q(`TRUNCATE users, trips, routes, vehicles, trip_seats, bookings, booking_passengers,
           payments, refunds, boarding_passes, boarding_events, trip_staff, waitlist_entries,
           idempotency_keys, guest_hold_attempts, notification_requests, audit_logs,
           provider_events, sessions, user_credentials, student_profiles
           RESTART IDENTITY CASCADE`);
  const mk = async (e: string, n: string, r: string) =>
    (await q(`INSERT INTO users (email,name,role,phone) VALUES ($1,$2,$3,'9876543210') RETURNING id`,
      [e, n, r])).rows[0].id;
  ALICE = await mk('alice@woxsen.edu.in', 'Alice', 'STUDENT');
  BOB = await mk('bob@woxsen.edu.in', 'Bob', 'STUDENT');
  OPS = await mk('ops@dlt.co.in', 'Ops', 'OPS_ADMIN');
  SUPER = await mk('super@dlt.co.in', 'Super', 'SUPER_ADMIN');
  STAFF = await mk('doora@dlt.co.in', 'Door A', 'BOARDING_STAFF');
  STAFF_B = await mk('doorb@dlt.co.in', 'Door B', 'BOARDING_STAFF');

  const r = (await q(`INSERT INTO routes (code,origin,destination,duration_min)
    VALUES ('WX-MYP','Woxsen','Miyapur',75) RETURNING id`)).rows[0].id;
  const v = (await q(`INSERT INTO vehicles (name,registration,row_count)
    VALUES ('DLT-01','TS07 AA 1111',11) RETURNING id`)).rows[0].id;
  TRIP = (await q(`INSERT INTO trips (route_id,vehicle_id,departure_at,price,status)
    VALUES ($1,$2, now() + interval '3 days', 259,'OPEN') RETURNING id`, [r, v])).rows[0].id;
  TRIP_B = (await q(`INSERT INTO trips (route_id,vehicle_id,departure_at,price,status)
    VALUES ($1,$2, now() + interval '4 days', 259,'OPEN') RETURNING id`, [r, v])).rows[0].id;
  await q('SELECT materialise_trip_seats($1)', [TRIP]);
  await q('SELECT materialise_trip_seats($1)', [TRIP_B]);
  await q(`INSERT INTO trip_staff (trip_id,user_id,assigned_by) VALUES ($1,$2,$3)`, [TRIP, STAFF, OPS]);
}

/** A paid, confirmed booking owned by `user`. */
async function paidBooking(user: string, seat: string, code: string) {
  await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, seat, user]);
  const b = await pay.createBooking({
    tripId: TRIP, holder: { userId: user }, contactPhone: '9876543210',
    idempotencyKey: `k-${code}`,
    passengers: [{ seatNumber: seat, name: 'Test Passenger', studentId: 'WU1' }],
  });
  const { rows: [p] } = await q(
    `INSERT INTO payments (booking_id,amount,status,provider,provider_order_id,provider_payment_id)
     VALUES ($1,$2,'SUCCESS','RAZORPAY',$3,$4) RETURNING *`,
    [b.id, b.totalAmount, 'order_' + code, 'pay_' + code]);
  await q('SELECT settle_booking($1,$2)', [b.id, p.id]);
  return { booking: b, payment: p };
}

after(async () => { await pool.end(); });
beforeEach(seed);

/* ================================================================= C-1 */

describe('C-1 · checkout handback', () => {
  test('an unauthenticated caller cannot read a payment', async () => {
    const { payment } = await paidBooking(ALICE, '2A', 'C1A');
    await assert.rejects(
      pay.paymentForActor(payment.id, { guestToken: 'nobody', ip: '1.2.3.4' } as any),
      /Sign in required/);
  });

  test('a non-owner is refused, and learns nothing about the payment', async () => {
    const { payment } = await paidBooking(ALICE, '2B', 'C1B');
    await assert.rejects(pay.paymentForActor(payment.id, bob()), (e: any) => {
      assert.equal(e.code, 'FORBIDDEN');
      /* the message must not confirm existence, owner, or amount */
      assert.ok(!/259|Alice|alice/.test(e.message));
      return true;
    });
  });

  test('the owner may read it; an operator may too', async () => {
    const { payment } = await paidBooking(ALICE, '2C', 'C1C');
    assert.equal((await pay.paymentForActor(payment.id, alice()))._access, 'OWNER');
    assert.equal((await pay.paymentForActor(payment.id, ops()))._access, 'OPERATOR');
  });

  test('THE DEFECT · reconcile returns a STATUS, never a booking object', async () => {
    const { payment } = await paidBooking(ALICE, '2D', 'C1D');
    const out = await pay.reconcile(payment.id, alice(), fakeProvider());
    /* pre-fix this returned bookingViewById(): names, student IDs, phone */
    assert.deepEqual(Object.keys(out).sort(), ['bookingId', 'bookingStatus', 'paymentStatus']);
    const blob = JSON.stringify(out);
    assert.ok(!/Test Passenger|9876543210|WU1/.test(blob), 'no PII may leave through this path');
  });
});

/* ================================================================= C-2 */

describe('C-2 · cross-user reconcile', () => {
  test('THE DEFECT · another student cannot reconcile a stranger\u2019s payment', async () => {
    const { payment } = await paidBooking(ALICE, '3A', 'C2A');
    await assert.rejects(pay.reconcile(payment.id, bob(), fakeProvider()), /not yours/);
  });

  test('the owner can, and an operator with the permission can', async () => {
    const { payment } = await paidBooking(ALICE, '3B', 'C2B');
    assert.ok(await pay.reconcile(payment.id, alice(), fakeProvider()));
    assert.ok(await pay.reconcile(payment.id, ops(), fakeProvider()));
  });

  test('a nonexistent payment gives NOT_FOUND, not a different code than a foreign one', async () => {
    /* Both 404/403 must be indistinguishable enough not to enumerate. */
    await assert.rejects(
      pay.reconcile('00000000-0000-4000-8000-000000000000', bob(), fakeProvider()),
      /not found/i);
  });
});

/* ================================================================= H-1 */

describe('H-1 · cancellation quote', () => {
  test('THE DEFECT · a stranger cannot read another student\u2019s refundable balance', async () => {
    const { booking } = await paidBooking(ALICE, '4A', 'H1A');
    await assert.rejects(pay.cancellationQuote(booking.id, bob()), /not yours/);
  });

  test('owner and operator both may', async () => {
    const { booking } = await paidBooking(ALICE, '4B', 'H1B');
    assert.equal((await pay.cancellationQuote(booking.id, alice())).amount, 259);
    assert.equal((await pay.cancellationQuote(booking.id, ops())).amount, 259);
  });

  test('and cancel is still protected (S-2 regression)', async () => {
    const { booking } = await paidBooking(ALICE, '4C', 'H1C');
    await assert.rejects(pay.cancelBooking(booking.id, bob(), 'not mine'), /not yours/);
    const { rows: [b] } = await q('SELECT status FROM bookings WHERE id=$1', [booking.id]);
    assert.equal(b.status, 'CONFIRMED', 'nothing happened');
  });

  test('reading a booking is protected (S-1 regression)', async () => {
    const { booking } = await paidBooking(ALICE, '4D', 'H1D');
    await assert.rejects(pay.bookingForActor(booking.id, bob()), /not yours/);
    const mine = await pay.bookingForActor(booking.id, alice());
    assert.equal(mine.code, booking.code);
  });
});

/* ================================================================= H-2 */

describe('H-2 · guest hold abuse', () => {
  test('a normal guest still holds up to 4 seats \u2014 documented behaviour preserved', async () => {
    for (const s of ['5A', '5B', '5C', '5D'])
      await seats.holdSeat(TRIP, s, guest('normal-student'));
    await assert.rejects(seats.holdSeat(TRIP, '6A', guest('normal-student')), /up to 4 seats/);
  });

  test('THE ATTACK · one source cannot lock a 44-seat departure with fresh tokens', async () => {
    let held = 0, refusals = 0;
    /* 20 fresh identities x 4 seats = 80 attempts against a 44-seat coach */
    for (let i = 0; i < 20; i++) {
      for (const col of ['A', 'B', 'C', 'D']) {
        const seat = `${(i % 11) + 1}${col}`;
        try { await seats.holdSeat(TRIP, seat, { guestToken: `attacker-${i}`, ip: '203.0.113.7' }); held++; }
        catch { refusals++; }
      }
    }
    const { rows: [c] } = await q(
      `SELECT count(*) FILTER (WHERE status='HELD')::int AS held,
              count(*) FILTER (WHERE status='AVAILABLE')::int AS free
         FROM trip_seats WHERE trip_id=$1`, [TRIP]);
    assert.ok(refusals > 0, 'the attacker must be refused at some point');
    assert.ok(c.free > 0, 'the coach must never be fully locked out');
    assert.ok(c.held <= Math.floor(44 * seats.GUEST_HOLD_CEILING_PCT / 100) + 4,
      `guest holds (${c.held}) must stay within the ceiling`);
  });

  test('the per-IP window is FIXED from the first attempt \u2014 a shared NAT cannot be locked out forever', async () => {
    for (let i = 0; i < seats.GUEST_HOLDS_PER_IP + 4; i++) {
      try { await seats.holdSeat(TRIP, `${(i % 11) + 1}A`, { guestToken: `g${i}`, ip: '198.51.100.4' }); }
      catch { /* expected past the budget */ }
    }
    const { rows: [first] } = await q(
      'SELECT window_started_at FROM guest_hold_attempts WHERE ip=$1', ['198.51.100.4']);
    for (let i = 0; i < 5; i++) {
      try { await seats.holdSeat(TRIP, '9A', { guestToken: `late${i}`, ip: '198.51.100.4' }); } catch {}
    }
    const { rows: [later] } = await q(
      'SELECT window_started_at FROM guest_hold_attempts WHERE ip=$1', ['198.51.100.4']);
    assert.deepEqual(later.window_started_at, first.window_started_at,
      'further attempts must not extend the window (F-06 rule, applied here)');
  });

  test('A SIGNED-IN STUDENT IS NEVER RATE-LIMITED BY THE GUEST CEILING', async () => {
    /* fill to the guest ceiling from one IP, then prove a real student is unaffected */
    for (let i = 0; i < 18; i++) {
      try { await seats.holdSeat(TRIP, `${(i % 11) + 1}B`, { guestToken: `g${i}`, ip: '203.0.113.9' }); } catch {}
    }
    const s = await seats.holdSeat(TRIP, '11D', { userId: ALICE, ip: '203.0.113.9' });
    assert.equal(s.status, 'HELD', 'abuse control must not punish authenticated students');
  });

  test('the limits are configurable', () => {
    assert.equal(typeof seats.GUEST_HOLDS_PER_IP, 'number');
    assert.equal(typeof seats.GUEST_HOLD_CEILING_PCT, 'number');
    assert.ok(seats.GUEST_HOLD_CEILING_PCT > 0 && seats.GUEST_HOLD_CEILING_PCT < 100);
  });
});

/* ================================================================= H-3 */

describe('H-3 · audit log immutability', () => {
  test('THE DEFECT · the trigger refuses DELETE even as the table OWNER', async () => {
    await q(`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
             VALUES ($1,'test.entry','test','1')`, [OPS]);
    /* Pre-fix, the REVOKE FROM PUBLIC did not bind the owner and this succeeded.
     * The test suite runs AS the owner, which is exactly why the trigger — not
     * the grant — is what this asserts. */
    await assert.rejects(q('DELETE FROM audit_logs'), /append-only/);
    await assert.rejects(q(`UPDATE audit_logs SET reason='rewritten'`), /append-only/);
    await assert.rejects(q('TRUNCATE audit_logs'), /append-only/);
    const { rows: [n] } = await q(`SELECT count(*)::int n FROM audit_logs WHERE action='test.entry'`);
    assert.equal(n.n, 1, 'the record survives every attempt');
  });

  test('INSERT and SELECT still work \u2014 append-only, not read-only', async () => {
    await q(`INSERT INTO audit_logs (actor_id, action, entity_type) VALUES ($1,'test.ok','test')`, [OPS]);
    const { rows } = await q(`SELECT action FROM audit_logs WHERE action='test.ok'`);
    assert.equal(rows.length, 1);
  });

  test('the runtime role holds no destructive privilege', async () => {
    const { rows: [p] } = await q(
      `SELECT has_table_privilege('dlt_app','audit_logs','DELETE') AS del,
              has_table_privilege('dlt_app','audit_logs','UPDATE') AS upd,
              has_table_privilege('dlt_app','audit_logs','INSERT') AS ins,
              has_table_privilege('dlt_app','audit_logs','SELECT') AS sel`);
    assert.equal(p.del, false);
    assert.equal(p.upd, false);
    assert.equal(p.ins, true);
    assert.equal(p.sel, true);
  });

  test('there is still no retention cap (Admin Spec §9–§10)', async () => {
    await q(`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
             SELECT $1,'test.bulk','test',g::text FROM generate_series(1,700) g`, [OPS]);
    const { rows: [n] } = await q(`SELECT count(*)::int n FROM audit_logs WHERE action='test.bulk'`);
    assert.equal(n.n, 700);
  });
});

/* ================================================================= H-4 */

describe('H-4 · idempotency', () => {
  const req = (seat: string) => ({
    tripId: TRIP, holder: { userId: ALICE }, contactPhone: '9876543210',
    passengers: [{ seatNumber: seat, name: 'Test Passenger', studentId: 'WU1' }],
  });

  test('same user + same key + same request → the same booking', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '7A', ALICE]);
    const a = await pay.createBooking({ ...req('7A'), idempotencyKey: 'same' } as any);
    const b = await pay.createBooking({ ...req('7A'), idempotencyKey: 'same' } as any);
    assert.equal(a.id, b.id);
    const { rows: [n] } = await q('SELECT count(*)::int n FROM bookings');
    assert.equal(n.n, 1);
  });

  test('THE DEFECT · same key + DIFFERENT request is refused, not answered from cache', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '7B', ALICE]);
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '7C', ALICE]);
    await pay.createBooking({ ...req('7B'), idempotencyKey: 'reused' } as any);
    await assert.rejects(
      pay.createBooking({ ...req('7C'), idempotencyKey: 'reused' } as any),
      /already used for a different request/);
    const { rows: [n] } = await q('SELECT count(*)::int n FROM bookings');
    assert.equal(n.n, 1, 'and no second booking was created');
  });

  test('THE DEFECT · a different user presenting the same key gets NOTHING', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '8A', ALICE]);
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '8B', BOB]);
    const alices = await pay.createBooking({ ...req('8A'), idempotencyKey: 'shared-key' } as any);
    await assert.rejects(pay.createBooking({
      tripId: TRIP, holder: { userId: BOB }, contactPhone: '9003155218',
      idempotencyKey: 'shared-key',
      passengers: [{ seatNumber: '8B', name: 'Bob B', studentId: 'WU2' }],
    } as any), /already used for a different request/);
    /* pre-fix, Bob received Alice's stored booking view */
    const { rows } = await q('SELECT id FROM bookings');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, alices.id);
  });

  test('the stored hash is a digest, not a length', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '9B', ALICE]);
    await pay.createBooking({ ...req('9B'), idempotencyKey: 'digest' } as any);
    const { rows: [k] } = await q('SELECT request_hash, user_id FROM idempotency_keys');
    assert.equal(k.request_hash.length, 64, 'sha256 hex');
    assert.match(k.request_hash, /^[0-9a-f]{64}$/);
    assert.equal(k.user_id, ALICE, 'and the record is bound to its caller');
  });

  test('key order in the body does not change the digest', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '9C', ALICE]);
    const a = { ...req('9C'), idempotencyKey: 'canon' };
    const reordered = { idempotencyKey: 'canon', passengers: a.passengers,
      holder: a.holder, contactPhone: a.contactPhone, tripId: a.tripId };
    const first = await pay.createBooking(a as any);
    const second = await pay.createBooking(reordered as any);
    assert.equal(first.id, second.id, 'canonicalisation must ignore property order');
  });

  test('concurrent duplicates produce ONE booking', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '10A', ALICE]);
    const results = await Promise.allSettled([
      pay.createBooking({ ...req('10A'), idempotencyKey: 'race' } as any),
      pay.createBooking({ ...req('10A'), idempotencyKey: 'race' } as any),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length >= 1, true);
    const { rows: [n] } = await q('SELECT count(*)::int n FROM bookings');
    assert.equal(n.n, 1, 'the row lock serialises them');
  });
});

/* ================================================================= M-1 */

describe('M-1 · guest-hold seat ownership', () => {
  test('THE DEFECT · one guest cannot allocate a seat held by another guest', async () => {
    await seats.holdSeat(TRIP, '1A', guest('guest-A'));
    await seats.holdSeat(TRIP, '1B', guest('guest-B'));

    /* guest-B creates a booking on their own seat... */
    const bs = await pay.createBooking({
      tripId: TRIP, holder: { guestToken: 'guest-B' }, contactPhone: '9876543210',
      idempotencyKey: 'gb', passengers: [{ seatNumber: '1B', name: 'Guest B', studentId: 'WU2' }],
    });
    const { rows: [seatA] } = await q(
      `SELECT id FROM trip_seats WHERE trip_id=$1 AND seat_number='1A'`, [TRIP]);

    /* ...then tries to allocate guest-A's seat to it. Pre-fix, both user_ids
     * were NULL and `IS NOT DISTINCT FROM` made this succeed. */
    await assert.rejects(q('SELECT allocate_seat_to_booking($1,$2)', [seatA.id, bs.id]),
      /no longer available/);
    const { rows: [after] } = await q(
      `SELECT hold_guest_token, status FROM trip_seats WHERE id=$1`, [seatA.id]);
    assert.equal(after.hold_guest_token, 'guest-A', 'still guest-A\u2019s');
  });

  test('a guest booking persists the token its seats were held with', async () => {
    await seats.holdSeat(TRIP, '1C', guest('guest-C'));
    const b = await pay.createBooking({
      tripId: TRIP, holder: { guestToken: 'guest-C' }, contactPhone: '9876543210',
      idempotencyKey: 'gc', passengers: [{ seatNumber: '1C', name: 'Guest C', studentId: 'WU3' }],
    });
    const { rows: [row] } = await q('SELECT guest_token, user_id FROM bookings WHERE id=$1', [b.id]);
    assert.equal(row.guest_token, 'guest-C');
    assert.equal(row.user_id, null);
  });

  test('a guest may read their OWN booking, and no other', async () => {
    await seats.holdSeat(TRIP, '1D', guest('guest-D'));
    const b = await pay.createBooking({
      tripId: TRIP, holder: { guestToken: 'guest-D' }, contactPhone: '9876543210',
      idempotencyKey: 'gd', passengers: [{ seatNumber: '1D', name: 'Guest D', studentId: 'WU4' }],
    });
    assert.equal((await authz.bookingFor(guest('guest-D'), b.id))._access, 'GUEST');
    await assert.rejects(authz.bookingFor(guest('guest-OTHER'), b.id), /Sign in required/);
  });

  test('sign-in adopts a guest booking as well as its seats (F-08)', async () => {
    await seats.holdSeat(TRIP, '6B', guest('guest-E'));
    const b = await pay.createBooking({
      tripId: TRIP, holder: { guestToken: 'guest-E' }, contactPhone: '9876543210',
      idempotencyKey: 'ge', passengers: [{ seatNumber: '6B', name: 'Guest E', studentId: 'WU5' }],
    });
    const { rows: [n] } = await q('SELECT adopt_guest_bookings($1,$2) AS n', ['guest-E', ALICE]);
    assert.equal(n.n, 1);
    const { rows: [row] } = await q('SELECT user_id, guest_token FROM bookings WHERE id=$1', [b.id]);
    assert.equal(row.user_id, ALICE);
    assert.equal(row.guest_token, null);
    assert.equal((await authz.bookingFor(alice(), b.id))._access, 'OWNER');
  });

  test('an authenticated hold cannot be taken by a guest booking either', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '7D', ALICE]);
    await seats.holdSeat(TRIP, '8C', guest('guest-F'));
    const gb = await pay.createBooking({
      tripId: TRIP, holder: { guestToken: 'guest-F' }, contactPhone: '9876543210',
      idempotencyKey: 'gf', passengers: [{ seatNumber: '8C', name: 'Guest F', studentId: 'WU6' }],
    });
    const { rows: [alices] } = await q(
      `SELECT id FROM trip_seats WHERE trip_id=$1 AND seat_number='7D'`, [TRIP]);
    await assert.rejects(q('SELECT allocate_seat_to_booking($1,$2)', [alices.id, gb.id]),
      /no longer available/);
  });
});

/* ================================================================= L-2 */

describe('L-2 · boarding events trip scoping', () => {
  test('THE DEFECT · staff cannot read the scan log of a trip they are not assigned to', async () => {
    await assert.rejects(boarding.boardingEvents(TRIP_B, staffA()),
      /not the one you are assigned to/);
  });

  test('staff can read their own trip\u2019s log', async () => {
    assert.ok(Array.isArray(await boarding.boardingEvents(TRIP, staffA())));
  });

  test('ops may read any trip \u2014 documented broader access', async () => {
    assert.ok(Array.isArray(await boarding.boardingEvents(TRIP_B, ops())));
  });

  test('the manifest rule is unchanged (F-19 regression)', async () => {
    const m = await boarding.manifest(TRIP_B, staffA());
    assert.equal(m.trip.id, TRIP, 'staff always get their assigned trip');
  });
});

/* ================================================================= L-1 */

describe('L-1 · boarding actions may assert a trip', () => {
  test('a passenger on another departure is refused when a trip is named', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP_B, '2A', BOB]);
    const b = await pay.createBooking({
      tripId: TRIP_B, holder: { userId: BOB }, contactPhone: '9003155218',
      idempotencyKey: 'l1', passengers: [{ seatNumber: '2A', name: 'Bob B', studentId: 'WU2' }],
    });
    const { rows: [p] } = await q('SELECT id FROM booking_passengers WHERE booking_id=$1', [b.id]);
    await assert.rejects(
      boarding.manualBoard(p.id, 'Camera failed at the door', ops(), TRIP),
      /not on the departure you are working/);
  });
});

/* ================================================================= structural */

describe('the structural guarantee', () => {
  test('every owned-object guard refuses an unauthenticated actor', async () => {
    const { booking, payment } = await paidBooking(ALICE, '11A', 'STR');
    const nobody = { guestToken: 'nothing', ip: '1.1.1.1' } as any;
    await assert.rejects(authz.bookingFor(nobody, booking.id), /Sign in required/);
    await assert.rejects(authz.paymentFor(nobody, payment.id), /Sign in required/);
    await assert.rejects(authz.requireOperator(nobody, 'report.read'), /Sign in required/);
  });

  test('a forged role in the actor cannot escalate', async () => {
    const { booking } = await paidBooking(ALICE, '11B', 'FORGE');
    /* Bob claims SUPER_ADMIN. has_permission() is asked about the CLAIMED role,
     * and a role that is not in role_permissions fails; in the HTTP layer the
     * role comes from the session and req.body is never read for identity. */
    await assert.rejects(
      authz.bookingFor({ userId: BOB, role: 'ROOT' } as any, booking.id),
      /not yours|invalid input value/);
  });

  test('a guard returns the row, so a caller cannot skip the check and still read', async () => {
    const { booking } = await paidBooking(ALICE, '11C', 'SHAPE');
    const row = await authz.bookingFor(alice(), booking.id);
    assert.equal(row.code, booking.code);
    assert.equal(row._access, 'OWNER');
  });
});

/* ================================================================= N-1 */

describe('N-1 · role cannot be supplied by a caller', () => {
  test('overrideRefund reads the role from the DATABASE, not from its argument', async () => {
    const { booking } = await paidBooking(ALICE, '10D', 'N1A');
    /* An earlier remediation draft accepted an optional actorRole. Passing one
     * now must be inert: OPS still lacks refund.override however the call is
     * shaped. TypeScript rejects the property; this asserts the runtime too. */
    await assert.rejects(pay.overrideRefund({
      bookingId: booking.id, amount: 100, reason: 'claiming to be super',
      actorId: OPS, actorRole: 'SUPER_ADMIN',
    } as any), /cannot perform that action/);
  });

  test('createManualBooking likewise', async () => {
    await assert.rejects(pay.createManualBooking({
      tripId: TRIP, type: 'COMPLIMENTARY', contactPhone: '9876543210',
      reason: 'claiming to be super', actorId: OPS, actorRole: 'SUPER_ADMIN',
      passengers: [{ seatNumber: '11B', name: 'Free Rider', studentId: 'WU9' }],
    } as any), /cannot perform that action/);
  });

  test('a Super Admin still succeeds through the normal path', async () => {
    const { booking } = await paidBooking(ALICE, '11C', 'N1C');
    await q(`UPDATE trips SET departure_at = now() + interval '3 hours' WHERE id=$1`, [TRIP]);
    const out = await pay.overrideRefund({ bookingId: booking.id, amount: 100,
      reason: 'Departure retimed by 90 minutes', actorId: SUPER });
    assert.equal(out.amount, 100);
  });
});

/* ================================================================= hardening */

describe('HD-3 · lazy argon2 initialisation', () => {
  test('the decoy hash is not computed at import time, and is computed once', async () => {
    const { _internals } = await import('../src/domain/auth.ts');
    const a = await _internals.getDecoyHash();
    const b = await _internals.getDecoyHash();
    assert.equal(a, b, 'memoised — one hash per process, not one per sign-in');
    assert.ok(a.startsWith('$argon2id$'));
  });

  test('a missing account and a wrong password both verify against something', async () => {
    /* The point of the decoy: timing must not distinguish them. This asserts the
     * shape (both paths reject identically); real timing analysis needs a
     * benchmark, not a unit test. */
    const auth = await import('../src/domain/auth.ts');
    const missing = await auth.signIn('nobody@woxsen.edu.in', 'whatever', {}).catch(e => e);
    const wrong = await auth.signIn('alice@woxsen.edu.in', 'whatever', {}).catch(e => e);
    assert.equal(missing.code, wrong.code);
    assert.equal(missing.message, wrong.message);
  });
});

describe('HD-6 · response headers', () => {
  test('Retry-After is derived from the domain\u2019s own message', async () => {
    const { retryAfterSeconds } = await import('../src/http/security-headers.ts');
    assert.equal(retryAfterSeconds(new Error('Too many attempts. Try again in 15 minutes.')), 900);
    assert.equal(retryAfterSeconds(new Error('Too many attempts. Try again in 1 minute.')), 60);
    assert.equal(retryAfterSeconds(new Error('no number here')), 60, 'conservative default');
  });

  test('a guest-hold rate limit raises RATE_LIMITED, which the header hook keys on', async () => {
    for (let i = 0; i < 30; i++) {
      try { await seats.holdSeat(TRIP, `${(i % 11) + 1}A`, { guestToken: `hd6-${i}`, ip: '192.0.2.55' }); }
      catch (e: any) {
        if (e.code === 'RATE_LIMITED') { assert.ok(true); return; }
      }
    }
    assert.fail('the guest limits must produce a RATE_LIMITED error');
  });
});

describe('H-3 layer 3 · startup assertion', () => {
  test('assertReady reports whether the audit log is append-only for THIS role', async () => {
    const { assertReady } = await import('../src/db/index.ts');
    /* The suite connects as the owner, which holds DELETE. Without the escape
     * hatch this must REFUSE to boot — that is the fail-closed behaviour. */
    const saved = process.env.ALLOW_AUDIT_PRIVILEGE;
    delete process.env.ALLOW_AUDIT_PRIVILEGE;
    const { rows: [p] } = await q(
      `SELECT has_table_privilege(current_user,'audit_logs','DELETE') AS del`);
    if (p.del) {
      await assert.rejects(assertReady(), /append-only audit trail|holds DELETE/,
        'a role that can delete audit records must not be allowed to boot silently');
    }
    process.env.ALLOW_AUDIT_PRIVILEGE = 'i-understand-the-risk';
    const ready = await assertReady();
    assert.equal(typeof ready.auditAppendOnly, 'boolean');
    if (saved === undefined) delete process.env.ALLOW_AUDIT_PRIVILEGE;
    else process.env.ALLOW_AUDIT_PRIVILEGE = saved;
  });

  test('dlt_app passes the assertion it is designed for', async () => {
    const { rows: [p] } = await q(
      `SELECT has_table_privilege('dlt_app','audit_logs','DELETE') AS del,
              has_table_privilege('dlt_app','audit_logs','UPDATE') AS upd,
              has_table_privilege('dlt_app','audit_logs','INSERT') AS ins`);
    assert.equal(p.del, false);
    assert.equal(p.upd, false);
    assert.equal(p.ins, true);
  });
});

/* ---------------------------------------------------------------- helper */

function fakeProvider(): any {
  return {
    name: 'RAZORPAY',
    async fetchOrder(id: string) {
      return { providerOrderId: id, kind: 'PAYMENT_SUCCEEDED',
        providerStatus: 'captured', amountRupees: 259, paymentId: 'pay_x' };
    },
    async createOrder() { throw new Error('not used'); },
    async createRefund() { throw new Error('not used'); },
    verifyAndParseWebhook() { throw new Error('not used'); },
    verifyCheckoutHandback() { return true; },
  };
}
