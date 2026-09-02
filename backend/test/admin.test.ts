/* DLT · test/admin.test.ts — operations authority and permissions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STATUS: WRITTEN — NOT EXECUTED — NOT VERIFIED.
 *
 * No PostgreSQL and no Node runtime exist where this was authored. Nothing below
 * has produced a result.
 *
 * Nothing here is provider-simulated: admin operations involve no third party.
 * Once run, these are genuine verification.
 *
 * The negative-authorization tests matter as much as the positive ones. A
 * permission model is only worth what its refusals are worth, and the prototype
 * had permissions that no screen ever reached (F-13, F-14) — meaning they had
 * never actually been exercised in either direction.
 *
 * Run:
 *   createdb dlt_test
 *   export DATABASE_URL=postgres://localhost/dlt_test
 *   for f in backend/migrations/00*.sql; do psql "$DATABASE_URL" -f "$f"; done
 *   npm ci
 *   node --test --experimental-strip-types backend/test/admin.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import * as admin from '../src/domain/admin.ts';
import { readAudit } from '../src/domain/audit.ts';
import * as auth from '../src/domain/auth.ts';
import { resetTables } from './_reset.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const q = (sql: string, a: unknown[] = []) => pool.query(sql, a);

let TRIP: string, TRIP_DRAFT: string, ROUTE: string, VEHICLE: string,
    SUPER: string, OPS: string, STAFF: string, STUDENT: string;

const sup = () => ({ userId: SUPER, role: 'SUPER_ADMIN' });
const ops = () => ({ userId: OPS, role: 'OPS_ADMIN' });
const staff = () => ({ userId: STAFF, role: 'BOARDING_STAFF' });
const student = () => ({ userId: STUDENT, role: 'STUDENT' });

async function seed() {
  await resetTables(pool, `users, trips, routes, vehicles, trip_seats, bookings, booking_passengers,
    payments, refunds, boarding_passes, boarding_events, trip_staff, waitlist_entries,
    notification_requests, student_profiles, user_credentials, sessions, audit_logs, reviews,
    provider_events`);
  const mk = async (e: string, n: string, r: string) =>
    (await q(`INSERT INTO users (email,name,role,phone) VALUES ($1,$2,$3,'9876543210') RETURNING id`,
      [e, n, r])).rows[0].id;
  SUPER = await mk('super@dlt.co.in', 'Super', 'SUPER_ADMIN');
  OPS = await mk('ops@dlt.co.in', 'Ops', 'OPS_ADMIN');
  STAFF = await mk('door@dlt.co.in', 'Door', 'BOARDING_STAFF');
  STUDENT = await mk('aarav@woxsen.edu.in', 'Aarav', 'STUDENT');
  await q(`INSERT INTO student_profiles (user_id, student_id) VALUES ($1,'WU204118')`, [STUDENT]);

  ROUTE = (await q(`INSERT INTO routes (code,origin,destination,duration_min)
    VALUES ('WX-MYP','Woxsen','Miyapur',75) RETURNING id`)).rows[0].id;
  VEHICLE = (await q(`INSERT INTO vehicles (name,registration,row_count)
    VALUES ('DLT-01','TS07 AA 1111',11) RETURNING id`)).rows[0].id;
  TRIP = (await q(`INSERT INTO trips (route_id,vehicle_id,departure_at,price,status)
    VALUES ($1,$2, now() + interval '2 days', 259,'OPEN') RETURNING id`, [ROUTE, VEHICLE])).rows[0].id;
  TRIP_DRAFT = (await q(`INSERT INTO trips (route_id,vehicle_id,departure_at,price,status)
    VALUES ($1,$2, now() + interval '5 days', 259,'DRAFT') RETURNING id`, [ROUTE, VEHICLE])).rows[0].id;
  await q('SELECT materialise_trip_seats($1)', [TRIP]);
  await q('SELECT materialise_trip_seats($1)', [TRIP_DRAFT]);
}

async function confirmedBooking(seats: string[], code: string, paid = true) {
  const { rows: [b] } = await q(
    `INSERT INTO bookings (code, boarding_code, trip_id, user_id, status, kind,
                           unit_price, total_amount, contact_phone)
     VALUES ($1,$2,$3,$4,'CONFIRMED','ONLINE',259,$5,'9876543210') RETURNING *`,
    [code, 'WX' + code.slice(-4), TRIP, STUDENT, 259 * seats.length]);
  if (paid)
    await q(`INSERT INTO payments (booking_id,amount,status,provider,provider_payment_id)
             VALUES ($1,$2,'SUCCESS','RAZORPAY',$3)`, [b.id, b.total_amount, 'pay_' + code]);
  for (const s of seats) {
    const { rows: [seat] } = await q(
      `UPDATE trip_seats SET status='BOOKED', booking_id=$1, hold_by=NULL, hold_expires_at=NULL
        WHERE trip_id=$2 AND seat_number=$3 RETURNING id`, [b.id, TRIP, s]);
    const { rows: [p] } = await q(
      `INSERT INTO booking_passengers (booking_id,trip_seat_id,name,student_id,phone,seat_number,seat_type)
       VALUES ($1,$2,$3,$4,'9876543210',$5,'AISLE') RETURNING id`,
      [b.id, seat.id, 'Passenger ' + s, 'WU' + s, s]);
    await q(`INSERT INTO boarding_passes (passenger_id,booking_id,trip_id,qr_token)
             VALUES ($1,$2,$3,$4)`, [p.id, b.id, TRIP, 'dlt.' + code + s]);
  }
  return b;
}

const seatOf = async (n: string) =>
  (await q('SELECT * FROM trip_seats WHERE trip_id=$1 AND seat_number=$2', [TRIP, n])).rows[0];
const auditFor = async (action: string) =>
  (await q('SELECT * FROM audit_logs WHERE action=$1 ORDER BY id DESC', [action])).rows;

after(async () => { await pool.end(); });
beforeEach(seed);

/* ================================================================= permissions */

describe('the permission model itself', () => {
  test('roles hold exactly the permissions the specification assigns', async () => {
    /* least privilege for staff: scan and read, nothing else */
    assert.equal(await auth.can('BOARDING_STAFF', 'boarding.scan'), true);
    assert.equal(await auth.can('BOARDING_STAFF', 'boarding.read'), true);
    assert.equal(await auth.can('BOARDING_STAFF', 'boarding.manual'), false);
    assert.equal(await auth.can('BOARDING_STAFF', 'boarding.deny'), false);
    assert.equal(await auth.can('BOARDING_STAFF', 'seat.block'), false);
    assert.equal(await auth.can('BOARDING_STAFF', 'report.read'), false);
    assert.equal(await auth.can('BOARDING_STAFF', 'audit.read'), false);

    /* a student holds no operational permission at all */
    for (const p of ['boarding.scan', 'seat.block', 'trip.write', 'vehicle.write',
      'report.read', 'audit.read', 'refund.create', 'notification.resolve'])
      assert.equal(await auth.can('STUDENT', p), false, `STUDENT must not hold ${p}`);
  });

  test('SUPER_ADMIN-only powers are genuinely exclusive', async () => {
    for (const p of ['refund.override', 'booking.manual', 'user.write', 'auth.reset_lookup']) {
      assert.equal(await auth.can('OPS_ADMIN', p), false, `OPS must not hold ${p}`);
      assert.equal(await auth.can('SUPER_ADMIN', p), true, `SUPER must hold ${p}`);
    }
  });

  test('the new Phase 5/6 permissions exist \u2014 a missing row silently disables an operation', async () => {
    for (const p of ['trip.publish', 'trip.status', 'boarding.deny', 'boarding.noshow']) {
      assert.equal(await auth.can('OPS_ADMIN', p), true, `${p} must be seeded`);
      assert.equal(await auth.can('SUPER_ADMIN', p), true);
    }
  });

  test('SUPER_ADMIN is a superset of OPS_ADMIN', async () => {
    const { rows } = await q(
      `SELECT permission FROM role_permissions WHERE role='OPS_ADMIN'
       EXCEPT SELECT permission FROM role_permissions WHERE role='SUPER_ADMIN'`);
    assert.equal(rows.length, 0);
  });
});

describe('negative authorization on every privileged operation', () => {
  /* Each entry: a thunk per role. Authorized succeeds, everyone else is refused
   * with FORBIDDEN — not a silent no-op, not a 500. */
  test('a student is refused every operations action', async () => {
    const b = await confirmedBooking(['2A'], 'DLT-90001');
    const calls: [string, () => Promise<unknown>][] = [
      ['blockSeat', () => admin.blockSeat(TRIP, '3A', 'water damage', student() as any)],
      ['unblockSeat', () => admin.unblockSeat(TRIP, '3A', student() as any)],
      ['saveVehicle', () => admin.saveVehicle({ name: 'Hack', registration: 'TS00 XX 0000' }, student() as any)],
      ['listVehicles', () => admin.listVehicles(student() as any)],
      ['saveTrip', () => admin.saveTrip({ routeId: ROUTE, vehicleId: VEHICLE,
        departureAt: new Date(Date.now() + 86400000).toISOString(), price: 1 }, student() as any)],
      ['publishTrip', () => admin.publishTrip(TRIP_DRAFT, student() as any)],
      ['setTripStatus', () => admin.setTripStatus(TRIP, 'BOARDING', 'because', student() as any)],
      ['cancelTrip', () => admin.cancelTrip(TRIP, 'because', student() as any)],
      ['assignStaff', () => admin.assignStaff(TRIP, STAFF, 'because', student() as any)],
      ['updateBookingContact', () => admin.updateBookingContact(b.id, '9876500000', 'because', student() as any)],
      ['findBookings', () => admin.findBookings({}, student() as any)],
      ['listRequests', () => admin.listRequests({}, student() as any)],
      ['report', () => admin.report('revenue', {}, student() as any)],
      ['exportReport', () => admin.exportReport('passengers', {}, student() as any)],
      ['listWaitlist', () => admin.listWaitlist(TRIP, student() as any)],
      ['affectedPassengers', () => admin.affectedPassengers(TRIP, student() as any)],
      ['today', () => admin.today(student() as any)],
    ];
    for (const [name, call] of calls)
      await assert.rejects(call(), /cannot perform that action/, `${name} must refuse a student`);
  });

  test('boarding staff are refused operations actions they must not hold', async () => {
    for (const [name, call] of [
      ['blockSeat', () => admin.blockSeat(TRIP, '3A', 'water damage', staff() as any)],
      ['saveVehicle', () => admin.saveVehicle({ name: 'X', registration: 'TS00 XX 0000' }, staff() as any)],
      ['setTripStatus', () => admin.setTripStatus(TRIP, 'BOARDING', 'because', staff() as any)],
      ['assignStaff', () => admin.assignStaff(TRIP, STAFF, 'self-assigning', staff() as any)],
      ['report', () => admin.report('revenue', {}, staff() as any)],
    ] as [string, () => Promise<unknown>][])
      await assert.rejects(call(), /cannot perform that action/, `${name} must refuse staff`);
  });

  test('OPS cannot use the Super-only powers, however the call is shaped', async () => {
    const b = await confirmedBooking(['2A'], 'DLT-90002');
    await assert.rejects(
      admin.overrideRefund({ bookingId: b.id, amount: 100, reason: 'trying it on', actorId: OPS }),
      /cannot perform that action|FORBIDDEN/);
    await assert.rejects(
      admin.createManualBooking({ tripId: TRIP, type: 'COMPLIMENTARY', contactPhone: '9876543210',
        reason: 'trying it on', actorId: OPS,
        passengers: [{ seatNumber: '4A', name: 'Free Rider', studentId: 'WU0001' }] }),
      /cannot perform that action|FORBIDDEN/);
  });

  test('A FORGED ROLE IN THE ARGUMENT CHANGES NOTHING \u2014 the DB decides', async () => {
    /* This is the shape of a tampered request: the client claims SUPER_ADMIN.
     * requirePermission reads role_permissions for the claimed role, so a role
     * that does not exist, or a real one the account does not have, both fail.
     * In the HTTP layer the role comes from the session and req.body is never
     * consulted for identity at all \u2014 this asserts the domain is safe even if
     * a future caller passed one through. */
    await assert.rejects(
      admin.blockSeat(TRIP, '3A', 'water damage', { userId: STUDENT, role: 'ADMIN' } as any),
      /cannot perform that action|invalid input value/);
    await assert.rejects(
      admin.blockSeat(TRIP, '3A', 'water damage', { userId: STUDENT, role: '' } as any),
      /cannot perform that action|invalid input value/);
    assert.equal((await seatOf('3A')).status, 'AVAILABLE', 'nothing happened');
  });

  test('an unauthenticated actor cannot reach the domain at all', async () => {
    /* The HTTP layer refuses first (requireAuth), but the domain must not be
     * usable with an empty actor either. */
    await assert.rejects(admin.blockSeat(TRIP, '3A', 'reason', { userId: '', role: '' } as any));
    await assert.rejects(admin.today({ userId: '', role: undefined } as any));
  });
});

/* ================================================================= seat blocking */

describe('§13.4 seat blocking (F-13)', () => {
  test('blocks an available seat, with a reason, and audits it', async () => {
    const out = await admin.blockSeat(TRIP, '3A', 'Seat belt torn', ops());
    assert.equal(out.status, 'BLOCKED');
    assert.equal(out.reason, 'Seat belt torn');
    const [a] = await auditFor('seat.blocked');
    assert.equal(a.reason, 'Seat belt torn');
    assert.equal(a.after_value, 'BLOCKED');
    assert.equal(a.actor_role, 'OPS_ADMIN');
  });

  test('a blocked seat cannot be held by a student', async () => {
    await admin.blockSeat(TRIP, '3B', 'Water damage', ops());
    await assert.rejects(q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '3B', STUDENT]));
  });

  test('REFUSES a booked seat \u2014 blocking must never take a paid seat', async () => {
    await confirmedBooking(['5A'], 'DLT-91001');
    await assert.rejects(admin.blockSeat(TRIP, '5A', 'Seat belt torn', ops()),
      /is booked — cancel the booking first/);
    assert.equal((await seatOf('5A')).status, 'BOOKED');
  });

  test('displaces a live hold, because an unfit seat must not be sold', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '6A', STUDENT]);
    await admin.blockSeat(TRIP, '6A', 'Broken armrest', ops());
    const s = await seatOf('6A');
    assert.equal(s.status, 'BLOCKED');
    assert.equal(s.hold_by, null, 'no dangling hold owner');
  });

  test('demands a reason, and refuses a double block', async () => {
    await assert.rejects(admin.blockSeat(TRIP, '7A', 'x', ops()), /reason is required/);
    await admin.blockSeat(TRIP, '7A', 'Under repair', ops());
    await assert.rejects(admin.blockSeat(TRIP, '7A', 'Under repair', ops()), /already blocked/);
  });

  test('unblocking returns the seat to sale and offers it to the waitlist', async () => {
    await admin.blockSeat(TRIP, '8A', 'Under repair', ops());
    await q(`UPDATE trip_seats SET status='BLOCKED', block_reason='fill'
              WHERE trip_id=$1 AND status='AVAILABLE'`, [TRIP]);
    await q(`INSERT INTO waitlist_entries (trip_id,user_id,position) VALUES ($1,$2,1)`,
      [TRIP, STUDENT]);
    await admin.unblockSeat(TRIP, '8A', ops());
    const { rows: [w] } = await q(
      `SELECT status, reserved_seat_id FROM waitlist_entries WHERE trip_id=$1`, [TRIP]);
    assert.equal(w.status, 'CLAIM_OFFERED');
    assert.ok(w.reserved_seat_id);
  });

  test('unblocking a seat that is not blocked is refused', async () => {
    await assert.rejects(admin.unblockSeat(TRIP, '9A', ops()), /is not blocked/);
  });
});

/* ================================================================= vehicles */

describe('§4 / FR-015 vehicle management (F-14)', () => {
  test('creates a vehicle with derived capacity', async () => {
    const v = await admin.saveVehicle(
      { name: 'DLT-02', registration: 'TS07 BB 2222', rowCount: 12 }, ops());
    assert.equal(v.rowCount, 12);
    assert.equal(v.capacity, 48, 'capacity is derived, never supplied');
    assert.equal(v.status, 'AVAILABLE');
  });

  test('edits registration, name and status freely \u2014 they cannot invalidate a booking', async () => {
    await confirmedBooking(['2A'], 'DLT-92001');
    const v = await admin.saveVehicle({ id: VEHICLE, name: 'DLT-01 (refit)',
      registration: 'TS07 AA 9999', status: 'MAINTENANCE' }, ops());
    assert.equal(v.registration, 'TS07 AA 9999');
    assert.equal(v.status, 'MAINTENANCE');
    const [a] = await auditFor('vehicle.updated');
    assert.match(a.before_value, /TS07 AA 1111/);
    assert.match(a.after_value, /TS07 AA 9999/);
  });

  test('THE GUARD \u00b7 refuses a seat-configuration change while seats are sold', async () => {
    await confirmedBooking(['2A'], 'DLT-92002');
    await assert.rejects(
      admin.saveVehicle({ id: VEHICLE, name: 'DLT-01', registration: 'TS07 AA 1111', rowCount: 9 }, ops()),
      /Cannot change the seat configuration: 1 seat\(s\) are already held or booked/);
    const { rows: [v] } = await q('SELECT row_count FROM vehicles WHERE id=$1', [VEHICLE]);
    assert.equal(v.row_count, 11, 'unchanged');
  });

  test('a live HOLD also blocks a configuration change', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '4B', STUDENT]);
    await assert.rejects(
      admin.saveVehicle({ id: VEHICLE, name: 'DLT-01', registration: 'TS07 AA 1111', rowCount: 14 }, ops()),
      /already held or booked/);
  });

  test('the explanation is specific, and the UI is told the field is locked', async () => {
    await confirmedBooking(['2A', '2B'], 'DLT-92003');
    const [v] = await admin.listVehicles(ops());
    assert.equal(v.seatsCommitted, 2);
    assert.equal(v.configLocked, true, 'so the form disables the field rather than failing later');
  });

  test('validates name and registration', async () => {
    await assert.rejects(admin.saveVehicle({ name: 'X', registration: 'TS07 CC 3333' }, ops()),
      /Enter a vehicle name/);
    await assert.rejects(admin.saveVehicle({ name: 'DLT-03', registration: 'TS07' }, ops()),
      /valid registration/);
  });

  test('registration is unique, ignoring case and spaces', async () => {
    await assert.rejects(
      admin.saveVehicle({ name: 'DLT-04', registration: 'ts07aa1111', rowCount: 11 }, ops()),
      /CONFLICT|duplicate/);
  });
});

/* ================================================================= trips */

describe('trip management', () => {
  test('creates a DRAFT with a materialised seat map, then publishes it', async () => {
    const t = await admin.saveTrip({ routeId: ROUTE, vehicleId: VEHICLE,
      departureAt: new Date(Date.now() + 4 * 86400000).toISOString(), price: 279 }, ops());
    assert.equal(t.status, 'DRAFT');
    const { rows: [n] } = await q('SELECT count(*)::int n FROM trip_seats WHERE trip_id=$1', [t.id]);
    assert.equal(n.n, 44);
    const pub = await admin.publishTrip(t.id, ops());
    assert.equal(pub.status, 'OPEN');
  });

  test('a DRAFT trip is not publicly listed until published', async () => {
    const { rows } = await q(
      `SELECT count(*)::int n FROM trips WHERE id=$1 AND status IN ('OPEN','BOOKING_CLOSED','BOARDING')`,
      [TRIP_DRAFT]);
    assert.equal(rows[0].n, 0);
  });

  test('publishing twice is refused', async () => {
    await admin.publishTrip(TRIP_DRAFT, ops());
    await assert.rejects(admin.publishTrip(TRIP_DRAFT, ops()), /already OPEN/);
  });

  test('a departure in the past is refused', async () => {
    await assert.rejects(admin.saveTrip({ routeId: ROUTE, vehicleId: VEHICLE,
      departureAt: new Date(Date.now() - 7 * 86400000).toISOString(), price: 259 }, ops()),
      /cannot be in the past/);
  });

  test('F-23 \u00b7 a manual status change pins ONE transition, not the trip forever', async () => {
    const out = await admin.setTripStatus(TRIP, 'BOOKING_CLOSED', 'Closing ten minutes early', ops());
    assert.equal(out.status, 'BOOKING_CLOSED');
    assert.ok(out.pinnedUntil, 'the pin has an expiry');
    const { rows: [t] } = await q('SELECT pinned_until FROM trips WHERE id=$1', [TRIP]);
    assert.ok(new Date(t.pinned_until).getTime() < Date.now() + 7 * 3600_000,
      'the prototype pinned the trip permanently; this expires');
  });

  test('a status change demands a reason and is audited', async () => {
    await assert.rejects(admin.setTripStatus(TRIP, 'BOARDING', 'x', ops()), /reason is required/);
    await admin.setTripStatus(TRIP, 'BOARDING', 'Coach arrived early', ops());
    const [a] = await auditFor('trip.status_changed');
    assert.equal(a.before_value, 'OPEN');
    assert.equal(a.after_value, 'BOARDING');
    assert.match(a.reason, /arrived early/);
  });

  test('cancellation must go through cancelTrip, not setTripStatus', async () => {
    await assert.rejects(admin.setTripStatus(TRIP, 'CANCELLED' as any, 'shortcut', ops()));
  });

  test('cancelling a trip refunds every paid booking and releases the seats', async () => {
    const a = await confirmedBooking(['2A'], 'DLT-93001');
    const b = await confirmedBooking(['2B'], 'DLT-93002');
    const out = await admin.cancelTrip(TRIP, 'Coach broke down at Woxsen', ops());
    assert.equal(out.bookingsAffected, 2);
    assert.equal(out.refundTotal, 259 * 2);
    assert.equal((await seatOf('2A')).status, 'AVAILABLE');
    const { rows: [r] } = await q('SELECT count(*)::int n FROM refunds');
    assert.equal(r.n, 2);
    const { rows: passes } = await q(
      `SELECT status FROM boarding_passes WHERE booking_id IN ($1,$2)`, [a.id, b.id]);
    assert.ok(passes.every((p: any) => p.status === 'VOID'));
  });

  test('an unpaid booking on a cancelled trip refunds nothing (F-05)', async () => {
    await confirmedBooking(['2C'], 'DLT-93003', false);
    const out = await admin.cancelTrip(TRIP, 'Route closed by police', ops());
    assert.equal(out.refundTotal, 0, 'money out can never exceed money in');
  });

  test('cancelling releases everyone waiting \u2014 there is nothing to wait for', async () => {
    await q(`INSERT INTO waitlist_entries (trip_id,user_id,position) VALUES ($1,$2,1)`,
      [TRIP, STUDENT]);
    await admin.cancelTrip(TRIP, 'Vehicle unavailable', ops());
    const { rows: [w] } = await q('SELECT status FROM waitlist_entries WHERE trip_id=$1', [TRIP]);
    assert.equal(w.status, 'CANCELLED');
  });

  test('cancelling twice is refused', async () => {
    await admin.cancelTrip(TRIP, 'Vehicle unavailable', ops());
    await assert.rejects(admin.cancelTrip(TRIP, 'again', ops()), /already cancelled/);
  });

  test('F-22 \u00b7 the affected list is scoped to THAT trip', async () => {
    await confirmedBooking(['2A'], 'DLT-93004');
    /* a passenger on an unrelated trip must not appear */
    const other = (await q(`INSERT INTO trips (route_id,vehicle_id,departure_at,price,status)
      VALUES ($1,$2, now() + interval '9 days', 259,'OPEN') RETURNING id`, [ROUTE, VEHICLE])).rows[0].id;
    await q('SELECT materialise_trip_seats($1)', [other]);
    const { rows: [ob] } = await q(
      `INSERT INTO bookings (code,boarding_code,trip_id,user_id,status,kind,unit_price,total_amount,contact_phone)
       VALUES ('DLT-99999','WX9999',$1,$2,'CONFIRMED','ONLINE',259,259,'9876543210') RETURNING id`,
      [other, STUDENT]);
    await q(`INSERT INTO booking_passengers (booking_id,name,student_id,seat_number,seat_type)
             VALUES ($1,'Other Trip Passenger','WU9','1A','WINDOW')`, [ob.id]);

    const list = await admin.affectedPassengers(TRIP, ops());
    assert.ok(list.length >= 1);
    assert.ok(!list.some((p: any) => p.name === 'Other Trip Passenger'),
      'the prototype exported every passenger in the system');
  });
});

/* ================================================================= staff */

describe('F-19 staff assignment', () => {
  test('assigns a staff account and audits it', async () => {
    const out = await admin.assignStaff(TRIP, STAFF, 'Evening shift', ops());
    assert.equal(out.assigned, true);
    const { rows: [a] } = await q('SELECT assigned_trip_for($1) AS trip', [STAFF]);
    assert.equal(a.trip, TRIP);
    assert.equal((await auditFor('staff.assigned'))[0].after_value, 'Door');
  });

  test('refuses a non-staff account and an inactive one', async () => {
    await assert.rejects(admin.assignStaff(TRIP, STUDENT, 'wrong role', ops()),
      /Choose a boarding staff account/);
    await q(`UPDATE users SET status='SUSPENDED' WHERE id=$1`, [STAFF]);
    await assert.rejects(admin.assignStaff(TRIP, STAFF, 'suspended', ops()), /not active/);
  });

  test('assignment revokes live sessions, so an open scanner cannot keep the old scope', async () => {
    await q(`INSERT INTO user_credentials (user_id,password_hash) VALUES ($1,'$argon2id$x')`, [STAFF]);
    const { rows: [s] } = await q(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1,'hash-abc', now() + interval '1 day') RETURNING id`, [STAFF]);
    await admin.assignStaff(TRIP, STAFF, 'Evening shift', ops());
    const { rows: [after] } = await q('SELECT revoked_at, revoked_reason FROM sessions WHERE id=$1', [s.id]);
    assert.ok(after.revoked_at);
    assert.match(after.revoked_reason, /assignment/);
  });

  test('unassigning works and is refused when there is nothing to remove', async () => {
    await admin.assignStaff(TRIP, STAFF, 'Evening shift', ops());
    assert.equal((await admin.unassignStaff(TRIP, STAFF, ops())).unassigned, true);
    await assert.rejects(admin.unassignStaff(TRIP, STAFF, ops()), /not assigned/);
  });

  test('a cancelled trip cannot be staffed', async () => {
    await admin.cancelTrip(TRIP, 'Vehicle unavailable', ops());
    await assert.rejects(admin.assignStaff(TRIP, STAFF, 'pointless', ops()), /cancelled/);
  });

  test('the staff list shows current assignments', async () => {
    await admin.assignStaff(TRIP, STAFF, 'Evening shift', ops());
    const list = await admin.listStaff(ops());
    const door = list.find((s: any) => s.id === STAFF);
    assert.equal(door.assignments.length, 1);
    assert.equal(door.assignments[0].tripId, TRIP);
  });
});

/* ================================================================= bookings */

describe('§14.3 booking contact editing (F-13)', () => {
  test('changes the contact with a reason, recording before and after', async () => {
    const b = await confirmedBooking(['2A'], 'DLT-94001');
    const out = await admin.updateBookingContact(b.id, '9003155218', 'Student changed number', ops());
    assert.equal(out.contactPhone, '9003155218');
    const [a] = await auditFor('booking.contact_changed');
    assert.equal(a.before_value, '9876543210');
    assert.equal(a.after_value, '9003155218');
    assert.match(a.reason, /changed number/);
  });

  test('validates the number and demands a reason', async () => {
    const b = await confirmedBooking(['2A'], 'DLT-94002');
    await assert.rejects(admin.updateBookingContact(b.id, '12345', 'bad number', ops()), /valid Indian mobile/);
    await assert.rejects(admin.updateBookingContact(b.id, '9003155218', 'x', ops()), /reason is required/);
  });

  test('booking search honours its filters', async () => {
    await confirmedBooking(['2A'], 'DLT-94003');
    await confirmedBooking(['2B'], 'DLT-94004');
    assert.equal((await admin.findBookings({ q: 'DLT-94003' }, ops())).length, 1);
    assert.equal((await admin.findBookings({ tripId: TRIP }, ops())).length, 2);
    assert.equal((await admin.findBookings({ status: 'CANCELLED_BY_DLT' }, ops())).length, 0);
  });
});

/* ================================================================= requests */

describe('§8.1 / §8.3 request approval (F-13)', () => {
  const mkRequest = async (kind: string, requested?: string) =>
    (await q(`INSERT INTO notification_requests (kind,user_id,requested_value,current_value,reason)
              VALUES ($1,$2,$3,'WU204118','Registry corrected it') RETURNING id`,
      [kind, STUDENT, requested ?? null])).rows[0].id;

  test('approving an ID change ACTUALLY CHANGES THE ID', async () => {
    const id = await mkRequest('STUDENT_ID_CHANGE', 'WU209999');
    const out = await admin.decideRequest(id, 'approve', 'Verified against the registry', ops());
    assert.equal(out.kind, 'STUDENT_ID_CHANGE');
    const { rows: [p] } = await q('SELECT student_id FROM student_profiles WHERE user_id=$1', [STUDENT]);
    assert.equal(p.student_id, 'WU209999', 'a decision that only set a status would be theatre');
  });

  test('rejecting an ID change leaves the ID alone but records the decision', async () => {
    const id = await mkRequest('STUDENT_ID_CHANGE', 'WU209999');
    await admin.decideRequest(id, 'reject', 'Registry does not confirm this', ops());
    const { rows: [p] } = await q('SELECT student_id FROM student_profiles WHERE user_id=$1', [STUDENT]);
    assert.equal(p.student_id, 'WU204118');
    const { rows: [r] } = await q('SELECT status, decision_reason FROM notification_requests WHERE id=$1', [id]);
    assert.equal(r.status, 'REJECTED');
    assert.match(r.decision_reason, /does not confirm/);
  });

  test('an ID change to one already in use is refused', async () => {
    const other = (await q(`INSERT INTO users (email,name,role) VALUES ('d@w.in','Diya','STUDENT')
      RETURNING id`)).rows[0].id;
    await q(`INSERT INTO student_profiles (user_id,student_id) VALUES ($1,'WU209999')`, [other]);
    const id = await mkRequest('STUDENT_ID_CHANGE', 'WU209999');
    await assert.rejects(admin.decideRequest(id, 'approve', 'Verified', ops()), /already in use/);
  });

  test('approving a deletion anonymises the account and revokes its sessions', async () => {
    await q(`INSERT INTO user_credentials (user_id,password_hash) VALUES ($1,'$argon2id$x')`, [STUDENT]);
    await q(`INSERT INTO sessions (user_id,token_hash,expires_at)
             VALUES ($1,'hash-del', now() + interval '1 day')`, [STUDENT]);
    const id = await mkRequest('ACCOUNT_DELETION');
    await admin.decideRequest(id, 'approve', 'Graduated, confirmed by email', ops());

    const { rows: [u] } = await q('SELECT status,name,email,phone FROM users WHERE id=$1', [STUDENT]);
    assert.equal(u.status, 'DELETED');
    assert.equal(u.name, 'Deleted account');
    assert.match(u.email, /@dlt\.invalid$/);
    assert.equal(u.phone, null);
    const { rows: [c] } = await q('SELECT count(*)::int n FROM user_credentials WHERE user_id=$1', [STUDENT]);
    assert.equal(c.n, 0);
    const { rows: [s] } = await q('SELECT revoked_at FROM sessions WHERE user_id=$1', [STUDENT]);
    assert.ok(s.revoked_at);
  });

  test('the row is RETAINED, because financial records reference it', async () => {
    await confirmedBooking(['2A'], 'DLT-95001');
    await q(`UPDATE bookings SET status='CANCELLED_BY_STUDENT' WHERE user_id=$1`, [STUDENT]);
    const id = await mkRequest('ACCOUNT_DELETION');
    await admin.decideRequest(id, 'approve', 'Graduated', ops());
    const { rows: [n] } = await q('SELECT count(*)::int n FROM users WHERE id=$1', [STUDENT]);
    assert.equal(n.n, 1, 'anonymised, not deleted');
    const { rows: [b] } = await q('SELECT count(*)::int n FROM bookings WHERE user_id=$1', [STUDENT]);
    assert.equal(b.n, 1, 'the booking history survives');
  });

  test('deletion is refused while an upcoming confirmed booking exists', async () => {
    await confirmedBooking(['2A'], 'DLT-95002');
    const id = await mkRequest('ACCOUNT_DELETION');
    await assert.rejects(admin.decideRequest(id, 'approve', 'Graduated', ops()),
      /upcoming confirmed booking/);
  });

  test('every decision demands a reason and cannot be taken twice', async () => {
    const id = await mkRequest('GET_NOTIFIED');
    await assert.rejects(admin.decideRequest(id, 'approve', 'ok', ops()), /reason is required/);
    await admin.decideRequest(id, 'approve', 'Added to the notify list', ops());
    await assert.rejects(admin.decideRequest(id, 'approve', 'Again please', ops()), /already approved/);
  });

  test('F-15 \u00b7 the database refuses a second open deletion request', async () => {
    await mkRequest('ACCOUNT_DELETION');
    await assert.rejects(mkRequest('ACCOUNT_DELETION'), /duplicate key/);
  });
});

/* ================================================================= waitlist */

describe('waitlist operations', () => {
  test('lists entries in priority order', async () => {
    const other = (await q(`INSERT INTO users (email,name,role) VALUES ('d@w.in','Diya','STUDENT')
      RETURNING id`)).rows[0].id;
    await q(`INSERT INTO waitlist_entries (trip_id,user_id,position) VALUES ($1,$2,2),($1,$3,1)`,
      [TRIP, STUDENT, other]);
    const list = await admin.listWaitlist(TRIP, ops());
    assert.deepEqual(list.map((e: any) => e.name), ['Diya', 'Aarav']);
  });

  test('move-to-top reorders, demands a reason, and audits before/after', async () => {
    const other = (await q(`INSERT INTO users (email,name,role) VALUES ('d@w.in','Diya','STUDENT')
      RETURNING id`)).rows[0].id;
    await q(`INSERT INTO waitlist_entries (trip_id,user_id,position) VALUES ($1,$2,1)`, [TRIP, other]);
    const { rows: [mine] } = await q(
      `INSERT INTO waitlist_entries (trip_id,user_id,position) VALUES ($1,$2,2) RETURNING id`,
      [TRIP, STUDENT]);
    await assert.rejects(admin.moveWaitlistToTop(mine.id, 'x', ops()), /reason is required/);
    await admin.moveWaitlistToTop(mine.id, 'Medical appointment, verified', ops());
    const list = await admin.listWaitlist(TRIP, ops());
    assert.equal(list[0].name, 'Aarav');
    const [a] = await auditFor('waitlist.reordered');
    assert.equal(a.before_value, 'position 2');
    assert.match(a.reason, /Medical appointment/);
  });

  test('an entry that already holds an offer cannot be reordered', async () => {
    await q(`UPDATE trip_seats SET status='BLOCKED', block_reason='fill' WHERE trip_id=$1`, [TRIP]);
    const { rows: [e] } = await q(
      `INSERT INTO waitlist_entries (trip_id,user_id,position) VALUES ($1,$2,1) RETURNING id`,
      [TRIP, STUDENT]);
    await q(`UPDATE trip_seats SET status='AVAILABLE', block_reason=NULL
              WHERE trip_id=$1 AND seat_number='2B'`, [TRIP]);
    await q('SELECT offer_seat_to_waitlist($1)', [TRIP]);
    await assert.rejects(admin.moveWaitlistToTop(e.id, 'Trying to reorder an offer', ops()),
      /claim_offered, not waiting/i);
  });
});

/* ================================================================= reports */

describe('reports — the server computes every total', () => {
  test('revenue totals come from authoritative rows, not from a caller', async () => {
    await confirmedBooking(['2A'], 'DLT-96001');
    await confirmedBooking(['2B'], 'DLT-96002');
    await q(`INSERT INTO refunds (booking_id,amount,reason)
             SELECT id, 59, 'partial goodwill' FROM bookings WHERE code='DLT-96001'`);
    const out: any = await admin.report('revenue', { tripId: TRIP }, ops());
    assert.equal(out.totals.gross, 518);
    assert.equal(out.totals.refunded, 59);
    assert.equal(out.totals.net, 459, 'net is one definition, computed server-side');
  });

  test('F-22 \u00b7 the bookings report HONOURS the trip filter', async () => {
    await confirmedBooking(['2A'], 'DLT-96003');
    const other = (await q(`INSERT INTO trips (route_id,vehicle_id,departure_at,price,status)
      VALUES ($1,$2, now() + interval '9 days', 259,'OPEN') RETURNING id`, [ROUTE, VEHICLE])).rows[0].id;
    await q(`INSERT INTO bookings (code,boarding_code,trip_id,user_id,status,kind,unit_price,total_amount,contact_phone)
             VALUES ('DLT-96004','WX6004',$1,$2,'CONFIRMED','ONLINE',259,259,'9876543210')`,
      [other, STUDENT]);
    const scoped = await admin.report('bookings', { tripId: TRIP }, ops()) as any[];
    assert.equal(scoped.length, 1, 'the prototype ignored tripId here entirely');
    assert.equal(scoped[0].code, 'DLT-96003');
    assert.equal((await admin.report('bookings', {}, ops()) as any[]).length, 2);
  });

  test('the date filter is enforced in SQL', async () => {
    await confirmedBooking(['2A'], 'DLT-96005');
    const past = new Date(Date.now() - 86400000).toISOString();
    const soon = new Date(Date.now() + 86400000).toISOString();
    assert.equal((await admin.report('bookings', { from: past, to: soon }, ops()) as any[]).length, 0);
    assert.equal((await admin.report('bookings', { from: past }, ops()) as any[]).length, 1);
  });

  test('the trip summary counts capacity, boarding and money correctly', async () => {
    await confirmedBooking(['2A', '2B'], 'DLT-96006');
    await admin.blockSeat(TRIP, '9D', 'Belt torn', ops());
    await q(`UPDATE booking_passengers SET boarding_status='BOARDED' WHERE seat_number='2A'`);
    const [s] = await admin.report('trips', { tripId: TRIP }, ops()) as any[];
    assert.equal(s.capacity, 44);
    assert.equal(s.seats_booked, 2);
    assert.equal(s.seats_blocked, 1);
    assert.equal(s.passengers, 2);
    assert.equal(s.boarded, 1);
    assert.equal(s.gross_rupees, 518);
  });

  test('the no-show report shows only no-shows', async () => {
    await confirmedBooking(['2A', '2B'], 'DLT-96007');
    await q(`UPDATE booking_passengers SET boarding_status='NO_SHOW' WHERE seat_number='2A'`);
    const rows = await admin.report('noshow', { tripId: TRIP }, ops()) as any[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].seatNumber, '2A');
  });

  test('CSV export carries the correct scope and is itself audited', async () => {
    await confirmedBooking(['2A'], 'DLT-96008');
    const out = await admin.exportReport('passengers', { tripId: TRIP }, ops());
    assert.match(out.filename, /^dlt-passengers-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.equal(out.csv.split('\n').length, 2, 'header plus one row');
    assert.match(out.csv, /Passenger 2A/);
    assert.equal((await auditFor('report.exported')).length, 1,
      'walking out with a passenger list leaves a record');
  });

  test('CSV escapes commas and quotes rather than corrupting a row', async () => {
    const b = await confirmedBooking(['2A'], 'DLT-96009');
    await q(`UPDATE booking_passengers SET name='Menon, Aarav "AJ"' WHERE booking_id=$1`, [b.id]);
    const out = await admin.exportReport('passengers', { tripId: TRIP }, ops());
    assert.match(out.csv, /"Menon, Aarav ""AJ"""/);
  });

  test('report.read does not imply report.export', async () => {
    /* Both are ops permissions here, but the split must exist so a future
     * read-only role cannot exfiltrate. */
    assert.equal(await auth.can('BOARDING_STAFF', 'report.read'), false);
    assert.equal(await auth.can('BOARDING_STAFF', 'report.export'), false);
  });

  test('an unknown report kind is refused', async () => {
    await assert.rejects(admin.report('secrets' as any, {}, ops()), /Unknown report/);
  });
});

/* ================================================================= audit */

describe('the audit log (Admin Spec §9–§10)', () => {
  test('records actor, action, target, before, after and reason', async () => {
    await admin.blockSeat(TRIP, '3A', 'Seat belt torn', sup());
    const [a] = await auditFor('seat.blocked');
    assert.equal(a.actor_id, SUPER);
    assert.equal(a.actor_name, 'Super');
    assert.equal(a.actor_role, 'SUPER_ADMIN');
    assert.equal(a.entity_type, 'trip_seat');
    assert.equal(a.before_value, 'AVAILABLE');
    assert.equal(a.after_value, 'BLOCKED');
    assert.equal(a.reason, 'Seat belt torn');
    assert.ok(a.occurred_at);
  });

  test('the actor name is DENORMALISED \u2014 a later rename cannot rewrite history', async () => {
    await admin.blockSeat(TRIP, '3A', 'Seat belt torn', ops());
    await q(`UPDATE users SET name='Someone Else', role='SUPER_ADMIN' WHERE id=$1`, [OPS]);
    const [a] = await auditFor('seat.blocked');
    assert.equal(a.actor_name, 'Ops', 'the log says who they were at the time');
    assert.equal(a.actor_role, 'OPS_ADMIN');
  });

  test('THERE IS NO 600-ENTRY CAP \u2014 the prototype truncated and lost evidence', async () => {
    await q(`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
             SELECT $1, 'test.bulk', 'test', g::text FROM generate_series(1,700) g`, [OPS]);
    const { rows: [n] } = await q(`SELECT count(*)::int n FROM audit_logs WHERE action='test.bulk'`);
    assert.equal(n.n, 700, 'nothing prunes this table');
  });

  test('an ordinary client cannot delete or rewrite audit records', async () => {
    await admin.blockSeat(TRIP, '3A', 'Seat belt torn', ops());
    /* Migration 001 revokes DELETE and UPDATE from PUBLIC. Run as a non-owner
     * role to prove it; as the owner these succeed, which is why the grant
     * matters at deployment. */
    await q(`CREATE ROLE dlt_app_test NOLOGIN`).catch(() => {});
    await q(`GRANT SELECT, INSERT ON audit_logs TO dlt_app_test`);
    /* One transaction PER statement: in PostgreSQL the first failure aborts the
     * whole transaction, so a second assertion inside it would read 25P02
     * ("transaction is aborted") instead of the permission error it is testing.
     * The finally rolls back unconditionally so a poisoned connection can never
     * go back to the pool and break the next test. */
    const c = await pool.connect();
    try {
      for (const sql of ['DELETE FROM audit_logs', `UPDATE audit_logs SET reason='rewritten'`]) {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE dlt_app_test');
        await assert.rejects(c.query(sql), /permission denied/, sql);
        await c.query('ROLLBACK');
      }
    } finally {
      try { await c.query('ROLLBACK'); } catch { /* nothing open */ }
      c.release();
    }
  });

  test('reads filter by entity, actor and action, with keyset paging', async () => {
    await admin.blockSeat(TRIP, '3A', 'Belt torn', ops());
    await admin.blockSeat(TRIP, '3B', 'Belt torn', sup());
    const byActor = await readAudit({ actorId: SUPER });
    assert.ok(byActor.entries.every((e: any) => e.actorId === SUPER));
    const byAction = await readAudit({ action: 'seat.' });
    assert.equal(byAction.entries.length, 2);
    const page = await readAudit({ limit: 1 });
    assert.equal(page.entries.length, 1);
    assert.ok(page.nextCursor);
    const next = await readAudit({ limit: 1, cursor: page.nextCursor! });
    assert.notEqual(next.entries[0].id, page.entries[0].id);
  });

  test('every privileged mutation leaves an entry', async () => {
    const b = await confirmedBooking(['2A'], 'DLT-97001');
    await admin.blockSeat(TRIP, '3A', 'Belt torn', ops());
    await admin.saveVehicle({ name: 'DLT-05', registration: 'TS07 EE 5555', rowCount: 10 }, ops());
    await admin.assignStaff(TRIP, STAFF, 'Evening shift', ops());
    await admin.updateBookingContact(b.id, '9003155218', 'Number changed', ops());
    await admin.setTripStatus(TRIP, 'BOOKING_CLOSED', 'Closing early', ops());
    const { rows } = await q('SELECT DISTINCT action FROM audit_logs');
    const actions = rows.map((r: any) => r.action);
    for (const a of ['seat.blocked', 'vehicle.created', 'staff.assigned',
      'booking.contact_changed', 'trip.status_changed'])
      assert.ok(actions.includes(a), `${a} must be audited`);
  });
});

/* ================================================================= alerts */

describe('operational alerts', () => {
  test('a late settlement surfaces as P0', async () => {
    const b = await confirmedBooking(['2A'], 'DLT-98001');
    await q(`UPDATE bookings SET status='ABANDONED' WHERE id=$1`, [b.id]);
    const alerts = await admin.operationalAlerts(ops());
    const late = alerts.find((a: any) => a.kind === 'LATE_SETTLEMENT');
    assert.ok(late, 'money received against an abandoned booking must be visible');
    assert.equal(late.severity, 'P0');
  });

  test('a stuck refund and a bad signature surface as P1', async () => {
    const b = await confirmedBooking(['2A'], 'DLT-98002');
    await q(`INSERT INTO refunds (booking_id,amount,reason,created_at)
             VALUES ($1,259,'cancelled', now() - interval '2 hours')`, [b.id]);
    await q(`INSERT INTO provider_events (provider_event_id,kind,raw_body,signature_ok)
             VALUES ('evt_bad','payment.captured','{}'::jsonb,false)`);
    const kinds = (await admin.operationalAlerts(ops())).map((a: any) => a.kind);
    assert.ok(kinds.includes('REFUND_STUCK'));
    assert.ok(kinds.includes('BAD_SIGNATURE'));
  });

  test('a boarding trip with no staff assigned is flagged', async () => {
    await q(`UPDATE trips SET status='BOARDING' WHERE id=$1`, [TRIP]);
    const kinds = (await admin.operationalAlerts(ops())).map((a: any) => a.kind);
    assert.ok(kinds.includes('NO_STAFF_ASSIGNED'));
    await admin.assignStaff(TRIP, STAFF, 'Evening shift', ops());
    const after = (await admin.operationalAlerts(ops())).map((a: any) => a.kind);
    assert.ok(!after.includes('NO_STAFF_ASSIGNED'));
  });

  test('alerts are ordered by severity', async () => {
    const b = await confirmedBooking(['2A'], 'DLT-98003');
    await q(`UPDATE bookings SET status='ABANDONED' WHERE id=$1`, [b.id]);
    await q(`UPDATE trips SET status='BOARDING' WHERE id=$1`, [TRIP]);
    const alerts = await admin.operationalAlerts(ops());
    assert.equal(alerts[0].severity, 'P0');
  });

  test('the today view reports trips and alert counts from real rows', async () => {
    await q(`UPDATE trips SET departure_at = now() + interval '2 hours' WHERE id=$1`, [TRIP]);
    await confirmedBooking(['2A'], 'DLT-98004');
    const out = await admin.today(ops());
    assert.equal(out.trips.length, 1);
    assert.equal(out.trips[0].passengers, 1);
    assert.equal(typeof out.alerts.p0, 'number');
  });
});

/* ================================================================= F-12 */

describe('F-12 refund override — preserved from Phase 3/4, not reimplemented', () => {
  test('Super Admin only, explicit amount, capped by money held', async () => {
    const b = await confirmedBooking(['2A'], 'DLT-99001');
    await q(`UPDATE trips SET departure_at = now() + interval '3 hours' WHERE id=$1`, [TRIP]);
    /* inside the 12-hour cutoff the policy refunds nothing */
    await assert.rejects(admin.overrideRefund({ bookingId: b.id, amount: 0,
      reason: 'nothing at all', actorId: SUPER }), /zero-value/);
    await assert.rejects(admin.overrideRefund({ bookingId: b.id, amount: 999,
      reason: 'more than we took', actorId: SUPER }), /more than/);
    const out = await admin.overrideRefund({ bookingId: b.id, amount: 150,
      reason: 'Departure retimed by 90 minutes', cancelBooking: true, actorId: SUPER });
    assert.equal(out.amount, 150);
    assert.equal(out.remainingRefundable, 109);
    const [a] = await auditFor('refund.policy_override');
    assert.match(a.reason, /retimed/);
    assert.equal(a.after_value, '₹150');
  });
});

/* ================================================================= Admin console migration
 *
 * The gaps found migrating DLT Admin.dc.html off dlt-store.js: an admin trip
 * listing (every status, not just what a student may book), the route picker
 * a new draft needs, draft validation without mutating, a rich per-booking
 * detail view, student search, an audited emergency-contact reveal, reviews
 * (schema and permissions already existed — migration 001/003 — nothing had
 * ever called them), and the payment reconciliation list (deliberately
 * without the accept/refund "discrepancy" choice dlt-store.js had — see
 * domain/admin.ts's listPaymentsForReconciliation for why that choice no
 * longer exists to make).
 */

describe('admin console migration · trip listing, routes, draft validation', () => {
  test('listAllTrips includes every status — DRAFT and CANCELLED — unlike the public listing', async () => {
    await q(`UPDATE trips SET status='CANCELLED' WHERE id=$1`,
      [(await q(`INSERT INTO trips (route_id,vehicle_id,departure_at,price,status)
                  VALUES ($1,$2, now() + interval '1 day', 259,'OPEN') RETURNING id`,
        [ROUTE, VEHICLE])).rows[0].id]);
    const rows = await admin.listAllTrips(ops());
    const statuses = rows.map((t: any) => t.status);
    assert.ok(statuses.includes('DRAFT'), 'the draft fixture trip is present');
    assert.ok(statuses.includes('CANCELLED'), 'the cancelled trip is present');
  });

  test('listAllTrips is permission-gated like every other admin read', async () => {
    await assert.rejects(admin.listAllTrips(student()), /cannot perform/);
  });

  test('listRoutes returns the seeded route, for the new-trip form', async () => {
    const rows = await admin.listRoutes(ops());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, 'Woxsen');
  });

  test('validateTripDraft: a properly configured draft is valid, without publishing it', async () => {
    const out = await admin.validateTripDraft(TRIP_DRAFT, ops());
    assert.equal(out.valid, true);
    assert.ok(out.checks.some((c: string) => /vehicle is assigned/.test(c)));
    const { rows: [t] } = await q('SELECT status FROM trips WHERE id=$1', [TRIP_DRAFT]);
    assert.equal(t.status, 'DRAFT', 'validating never mutates the trip');
  });

  test('validateTripDraft: an already-published trip reports why it cannot be validated as a draft', async () => {
    const out = await admin.validateTripDraft(TRIP, ops());
    assert.equal(out.valid, false);
    assert.ok(out.problems.some((p: string) => /not a draft/.test(p)));
  });
});

describe('admin console migration · booking detail', () => {
  test('bookingDetail carries owner, trip/vehicle, passengers and payment — the search list does not', async () => {
    const b = await confirmedBooking(['2A'], 'DLT-97001');
    const out = await admin.bookingDetail(b.id, ops());
    assert.equal(out.owner.studentId, 'WU204118');
    assert.equal(out.trip.vehicle.registration, 'TS07 AA 1111');
    assert.equal(out.passengers.length, 1);
    assert.equal(out.passengers[0].seatNumber, '2A');
    assert.equal(out.payment.status, 'SUCCESS');
  });

  test('the inline audit trail is Super Admin only — OPS_ADMIN gets an empty array, not a 403', async () => {
    const b = await confirmedBooking(['2B'], 'DLT-97002');
    const asOps = await admin.bookingDetail(b.id, ops());
    assert.deepEqual(asOps.auditTrail, []);
    const asSuper = await admin.bookingDetail(b.id, sup());
    assert.ok(Array.isArray(asSuper.auditTrail));
  });

  test('bookingDetail is permission-gated', async () => {
    const b = await confirmedBooking(['2C'], 'DLT-97003');
    await assert.rejects(admin.bookingDetail(b.id, student()), /cannot perform/);
  });

  test('findBookings also matches a passenger name or student ID, not just the booking/boarding code', async () => {
    await confirmedBooking(['2D'], 'DLT-97004');
    const byName = await admin.findBookings({ q: 'Passenger 2D' }, ops());
    assert.equal(byName.length, 1);
    const byStudentId = await admin.findBookings({ q: 'WU2D' }, ops());
    assert.equal(byStudentId.length, 1);
    assert.equal(byStudentId[0].ownerName, 'Aarav', 'the search list now carries the owner\'s name');
  });
});

describe('admin console migration · students and the emergency-contact reveal', () => {
  test('listStudents finds the seeded student by name, email, student ID or phone', async () => {
    assert.equal((await admin.listStudents(ops(), 'Aarav')).length, 1);
    assert.equal((await admin.listStudents(ops(), 'WU204118')).length, 1);
    assert.equal((await admin.listStudents(ops(), 'woxsen.edu.in')).length, 1);
    assert.equal((await admin.listStudents(ops(), 'nobody-matches-this')).length, 0);
  });

  test('emergencyContactAvailable reflects whether one is on file, without disclosing it', async () => {
    const [before] = await admin.listStudents(ops(), 'Aarav');
    assert.equal(before.emergencyContactAvailable, false);
    await q(`UPDATE student_profiles SET emergency_contact_name='Priya', emergency_contact_phone='9123456789'
              WHERE user_id=$1`, [STUDENT]);
    const [after] = await admin.listStudents(ops(), 'Aarav');
    assert.equal(after.emergencyContactAvailable, true);
    assert.deepEqual(Object.keys(after).sort(),
      ['bookings', 'email', 'emailVerified', 'emergencyContactAvailable', 'id', 'name', 'phone', 'studentId'].sort(),
      'the roster carries only that a contact exists, never the contact itself');
  });

  test('revealEmergencyContact is Super Admin only — OPS_ADMIN, which holds student.read, is still refused', async () => {
    await assert.rejects(admin.revealEmergencyContact(STUDENT, 'urgent', ops()), /cannot perform/);
  });

  test('revealEmergencyContact requires a reason, returns the contact, and audits WITHOUT the PII', async () => {
    await q(`UPDATE student_profiles SET emergency_contact_name='Priya', emergency_contact_phone='9123456789',
              emergency_contact_relation='Sister' WHERE user_id=$1`, [STUDENT]);
    await assert.rejects(admin.revealEmergencyContact(STUDENT, 'no', sup()), /reason/);
    const c = await admin.revealEmergencyContact(STUDENT, 'Passenger taken ill on the 17:30 departure', sup());
    assert.equal(c!.name, 'Priya');
    assert.equal(c!.relation, 'Sister');
    const [a] = await auditFor('student.emergency_contact_revealed');
    assert.equal(a.before_value, null);
    assert.equal(a.after_value, null);
    assert.match(a.reason, /taken ill/);
    assert.doesNotMatch(JSON.stringify(a), /Priya|9123456789/,
      'the contact itself must never land in the audit trail — audit.read is far broader than this reveal permission');
  });

  test('revealEmergencyContact on a student with none on file returns null, not an error', async () => {
    const c = await admin.revealEmergencyContact(STUDENT, 'checking on file', sup());
    assert.equal(c, null);
  });
});

describe('admin console migration · reviews (schema and permissions already existed; nothing used them)', () => {
  async function seedReview(rating = 4) {
    const b = await confirmedBooking(['3A'], 'DLT-96001');
    const { rows: [r] } = await q(
      `INSERT INTO reviews (trip_id, booking_id, user_id, rating, comment)
       VALUES ($1,$2,$3,$4,'Good trip') RETURNING id`, [TRIP, b.id, STUDENT, rating]);
    return r.id;
  }

  test('listReviews is feedback.read, moderateReview is feedback.moderate — distinct permissions', async () => {
    await seedReview();
    assert.equal((await admin.listReviews(ops())).length, 1);
    await assert.rejects(admin.listReviews(student()), /cannot perform/);
  });

  test('a review starts VISIBLE, can be hidden, unhidden, or marked resolved — three real states, not two', async () => {
    const id = await seedReview();
    let [row] = await admin.listReviews(ops());
    assert.equal(row.status, 'VISIBLE');

    await admin.moderateReview(id, 'hide', ops());
    [row] = await admin.listReviews(ops());
    assert.equal(row.status, 'HIDDEN');

    await admin.moderateReview(id, 'unhide', ops());
    [row] = await admin.listReviews(ops());
    assert.equal(row.status, 'VISIBLE');

    await admin.moderateReview(id, 'resolve', ops());
    [row] = await admin.listReviews(ops());
    assert.equal(row.status, 'RESOLVED');
    const [a] = await auditFor('review.resolved');
    assert.equal(a.after_value, 'RESOLVED');
  });
});

describe('admin console migration · payment reconciliation — Super Admin only, no discrepancy override', () => {
  test('listPaymentsForReconciliation is payment.admin — narrower than payment.read/payment.reconcile, which OPS_ADMIN holds', async () => {
    await confirmedBooking(['3B'], 'DLT-95001');
    const rows = await admin.listPaymentsForReconciliation(sup());
    assert.ok(rows.length >= 1);
    await assert.rejects(admin.listPaymentsForReconciliation(ops()), /cannot perform/,
      'OPS_ADMIN has payment.read/payment.reconcile for its own narrower needs, not the full list');
  });
});

describe('admin console migration · dashboard summary', () => {
  test('dashboardSummary aggregates real report_trip_summary rows — no total is invented', async () => {
    await q(`UPDATE trips SET departure_at = now() + interval '2 hours' WHERE id=$1`, [TRIP]);
    await confirmedBooking(['3C'], 'DLT-94001');
    const out = await admin.dashboardSummary(ops());
    assert.equal(out.tripsToday, 1);
    assert.equal(out.passengers, 1);
    assert.ok(Array.isArray(out.alerts));
    assert.ok(Array.isArray(out.activity));
  });
});
