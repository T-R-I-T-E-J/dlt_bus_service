/* DLT · test/boarding.test.ts — the boarding validation chain on the server.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STATUS: WRITTEN — NOT EXECUTED — NOT VERIFIED.
 *
 * No PostgreSQL and no Node runtime exist where this was authored. Nothing below
 * has produced a result.
 *
 * Unlike the payment tests, NOTHING here is provider-simulated: boarding
 * involves no third party. These tests exercise our own rules, our own
 * constraints and real row locks, so once run they are genuine verification of
 * the chain — with one exception noted at the end of the file, which is the part
 * only a physical device can answer.
 *
 * Run:
 *   createdb dlt_test
 *   export DATABASE_URL=postgres://localhost/dlt_test
 *   for f in backend/migrations/00*.sql; do psql "$DATABASE_URL" -f "$f"; done
 *   npm ci
 *   node --test --experimental-strip-types backend/test/boarding.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import * as boarding from '../src/domain/boarding.ts';
import { resetTables } from './_reset.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const q = (sql: string, a: unknown[] = []) => pool.query(sql, a);

let TRIP_A: string, TRIP_B: string, STAFF_A: string, STAFF_UNASSIGNED: string,
    OPS: string, SUPER: string, STUDENT: string;

const staffA = () => ({ userId: STAFF_A, role: 'BOARDING_STAFF', name: 'Door A' });
const unassigned = () => ({ userId: STAFF_UNASSIGNED, role: 'BOARDING_STAFF', name: 'Spare' });
const ops = () => ({ userId: OPS, role: 'OPS_ADMIN', name: 'Ops' });
const student = () => ({ userId: STUDENT, role: 'STUDENT', name: 'Aarav' });

/** A confirmed booking with N passengers on `trip`, returning tokens+codes. */
async function confirmedBooking(trip: string, seats: string[], code: string) {
  const { rows: [b] } = await q(
    `INSERT INTO bookings (code, boarding_code, trip_id, user_id, status, kind,
                           unit_price, total_amount, contact_phone)
     VALUES ($1,$2,$3,$4,'CONFIRMED','ONLINE',259,$5,'9876543210') RETURNING *`,
    [code, 'WX' + code.slice(-4), trip, STUDENT, 259 * seats.length]);
  await q(`INSERT INTO payments (booking_id, amount, status, provider, provider_payment_id)
           VALUES ($1,$2,'SUCCESS','RAZORPAY',$3)`, [b.id, b.total_amount, 'pay_' + code]);
  const out: any = { booking: b, passengers: [] as any[] };
  for (const s of seats) {
    const { rows: [seat] } = await q(
      `UPDATE trip_seats SET status='BOOKED', booking_id=$1, hold_by=NULL, hold_expires_at=NULL
        WHERE trip_id=$2 AND seat_number=$3 RETURNING id`, [b.id, trip, s]);
    const { rows: [p] } = await q(
      `INSERT INTO booking_passengers (booking_id, trip_seat_id, name, student_id, phone,
                                       seat_number, seat_type)
       VALUES ($1,$2,$3,$4,'9876543210',$5,'AISLE') RETURNING *`,
      [b.id, seat.id, `Passenger ${s}`, 'WU' + s, s]);
    const token = `dlt.${code}${s}`.toLowerCase();
    await q(`INSERT INTO boarding_passes (passenger_id, booking_id, trip_id, qr_token)
             VALUES ($1,$2,$3,$4)`, [p.id, b.id, trip, token]);
    out.passengers.push({ ...p, token });
  }
  return out;
}

async function seed() {
  await resetTables(pool, `users, trips, routes, vehicles, trip_seats, bookings, booking_passengers,
    payments, refunds, boarding_passes, boarding_events, trip_staff, audit_logs,
    provider_events`);
  const mk = async (e: string, n: string, r: string) =>
    (await q(`INSERT INTO users (email,name,role,phone) VALUES ($1,$2,$3,'9876543210') RETURNING id`,
      [e, n, r])).rows[0].id;
  STAFF_A = await mk('doora@dlt.co.in', 'Door A', 'BOARDING_STAFF');
  STAFF_UNASSIGNED = await mk('spare@dlt.co.in', 'Spare', 'BOARDING_STAFF');
  OPS = await mk('ops@dlt.co.in', 'Ops', 'OPS_ADMIN');
  SUPER = await mk('super@dlt.co.in', 'Super', 'SUPER_ADMIN');
  STUDENT = await mk('aarav@woxsen.edu.in', 'Aarav', 'STUDENT');

  const r = (await q(`INSERT INTO routes (code,origin,destination,duration_min)
    VALUES ('WX-MYP','Woxsen','Miyapur',75) RETURNING id`)).rows[0].id;
  const v = (await q(`INSERT INTO vehicles (name,registration,row_count)
    VALUES ('DLT-01','TS07 AA 1111',11) RETURNING id`)).rows[0].id;
  TRIP_A = (await q(`INSERT INTO trips (route_id,vehicle_id,departure_at,price,status)
    VALUES ($1,$2, now() + interval '30 minutes', 259,'BOARDING') RETURNING id`, [r, v])).rows[0].id;
  TRIP_B = (await q(`INSERT INTO trips (route_id,vehicle_id,departure_at,price,status)
    VALUES ($1,$2, now() + interval '4 hours', 259,'OPEN') RETURNING id`, [r, v])).rows[0].id;
  await q('SELECT materialise_trip_seats($1)', [TRIP_A]);
  await q('SELECT materialise_trip_seats($1)', [TRIP_B]);
  await q(`INSERT INTO trip_staff (trip_id,user_id,assigned_by) VALUES ($1,$2,$3)`,
    [TRIP_A, STAFF_A, OPS]);
}

const eventsFor = async (paxId: string) =>
  (await q(`SELECT result, method, reason FROM boarding_events WHERE passenger_id=$1
            ORDER BY occurred_at`, [paxId])).rows;
const statusOf = async (paxId: string) =>
  (await q('SELECT boarding_status FROM booking_passengers WHERE id=$1', [paxId])).rows[0].boarding_status;

after(async () => { await pool.end(); });
beforeEach(seed);

/* ================================================================= happy path */

describe('scanning a valid pass', () => {
  test('boards the passenger and records the event', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-10001');
    const out = await boarding.scan({ code: bk.passengers[0].token }, staffA());
    assert.equal(out.result, 'VALID');
    assert.match(out.detail, /seat 2B/);
    assert.equal(out.passenger!.bookingCode, 'DLT-10001');
    assert.equal(await statusOf(bk.passengers[0].id), 'BOARDED');
    assert.deepEqual((await eventsFor(bk.passengers[0].id)).map(e => e.result), ['VALID']);
  });

  test('a complimentary booking boards \u2014 NOT_APPLICABLE is a legitimate payment state', async () => {
    const { rows: [b] } = await q(
      `INSERT INTO bookings (code,boarding_code,trip_id,status,kind,unit_price,total_amount,
                             contact_phone,manual_reason)
       VALUES ('DLT-10009','WX0009',$1,'CONFIRMED','MANUAL_COMPLIMENTARY',0,0,'9876543210','escort')
       RETURNING *`, [TRIP_A]);
    await q(`INSERT INTO payments (booking_id,amount,status,provider)
             VALUES ($1,0,'NOT_APPLICABLE','NONE_COMPLIMENTARY')`, [b.id]);
    const { rows: [seat] } = await q(
      `UPDATE trip_seats SET status='BOOKED', booking_id=$1 WHERE trip_id=$2 AND seat_number='3A'
        RETURNING id`, [b.id, TRIP_A]);
    const { rows: [p] } = await q(
      `INSERT INTO booking_passengers (booking_id,trip_seat_id,name,student_id,seat_number,seat_type)
       VALUES ($1,$2,'Escort Officer','STAFF1','3A','WINDOW') RETURNING id`, [b.id, seat.id]);
    await q(`INSERT INTO boarding_passes (passenger_id,booking_id,trip_id,qr_token)
             VALUES ($1,$2,$3,'dlt.comp1')`, [p.id, b.id, TRIP_A]);
    assert.equal((await boarding.scan({ code: 'dlt.comp1' }, staffA())).result, 'VALID');
  });
});

/* ================================================================= the chain */

describe('the validation chain, in its documented order', () => {
  test('an unrecognised code is INVALID and still logged', async () => {
    const out = await boarding.scan({ code: 'not-a-real-code' }, staffA());
    assert.equal(out.result, 'INVALID');
    assert.match(out.detail, /not a DLT boarding pass, boarding code or booking ID/);
    const { rows } = await q(`SELECT result, token_prefix FROM boarding_events`);
    assert.equal(rows.length, 1, 'a refused attempt is evidence and must be recorded');
    assert.equal(rows[0].result, 'INVALID');
  });

  test('F-28 \u00b7 only a token PREFIX is stored, never the whole token', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-10002');
    const token = bk.passengers[0].token;
    await boarding.scan({ code: token }, staffA());
    const { rows: [e] } = await q(`SELECT token_prefix FROM boarding_events`);
    assert.ok(e.token_prefix.length <= 12);
    assert.notEqual(e.token_prefix, token);
  });

  test('WRONG TRIP \u00b7 a pass for another departure is refused', async () => {
    const bk = await confirmedBooking(TRIP_B, ['2B'], 'DLT-10003');
    const out = await boarding.scan({ code: bk.passengers[0].token }, staffA());
    assert.equal(out.result, 'INVALID');
    assert.match(out.detail, /not the trip you are boarding/);
    assert.equal(await statusOf(bk.passengers[0].id), 'NOT_BOARDED');
    assert.equal((await eventsFor(bk.passengers[0].id))[0].reason, 'wrong trip');
  });

  test('CANCELLED booking is refused', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-10004');
    await q(`UPDATE bookings SET status='CANCELLED_BY_STUDENT' WHERE id=$1`, [bk.booking.id]);
    const out = await boarding.scan({ code: bk.passengers[0].token }, staffA());
    assert.equal(out.result, 'INVALID');
    assert.match(out.detail, /is cancelled/);
  });

  test('a VOIDED pass is refused', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-10005');
    await q(`UPDATE boarding_passes SET status='VOID', voided_at=now() WHERE passenger_id=$1`,
      [bk.passengers[0].id]);
    const out = await boarding.scan({ code: bk.passengers[0].token }, staffA());
    assert.equal(out.result, 'INVALID');
    assert.match(out.detail, /voided/);
  });

  test('a REFUNDED seat is refused', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-10006');
    await q(`INSERT INTO refunds (booking_id,amount,reason,status)
             VALUES ($1,259,'cancelled outside cutoff','REFUNDED')`, [bk.booking.id]);
    await q(`UPDATE booking_passengers SET boarding_status='CANCELLED' WHERE id=$1`,
      [bk.passengers[0].id]);
    const out = await boarding.scan({ code: bk.passengers[0].token }, staffA());
    assert.equal(out.result, 'INVALID');
    assert.match(out.detail, /refunded/);
  });

  test('an UNPAID booking is refused', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-10007');
    await q(`UPDATE payments SET status='FAILED' WHERE booking_id=$1`, [bk.booking.id]);
    const out = await boarding.scan({ code: bk.passengers[0].token }, staffA());
    assert.equal(out.result, 'INVALID');
    assert.match(out.detail, /Payment for DLT-10007 is failed/);
  });

  test('a COMPLETED journey is refused — staff lose the scope with the journey', async () => {
    /* assigned_trip_for() resolves the ONE departure a staff member is currently
     * working: OPEN, BOOKING_CLOSED or BOARDING. A completed journey is not one
     * of them, so a BOARDING_STAFF scanning after the trip ends is refused at
     * the authorization boundary, before the verdict chain runs.
     *
     * That is deliberate and it is kept. Widening assigned_trip_for() to
     * terminal states would make it ambiguous which of a staff member's many
     * historical assignments it should return, inside the one function whose
     * contract is "the single trip you may act on" — a bad trade for a nicer
     * message. Fail closed, and refuse. */
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-10008');
    await q(`UPDATE trips SET status='COMPLETED', pinned_status='COMPLETED' WHERE id=$1`, [TRIP_A]);
    await assert.rejects(
      boarding.scan({ code: bk.passengers[0].token }, staffA()),
      (e: any) => {
        assert.equal(e.code, 'FORBIDDEN');
        assert.match(e.message, /not assigned to a trip/);
        return true;
      });
  });

  test('a COMPLETED journey reports the precise reason to ops, who are not scoped', async () => {
    /* Ops carry the trip themselves rather than inheriting it from an
     * assignment, so they DO reach the chain and get the actionable verdict.
     * This is what keeps the completed-journey check covered. */
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-10009');
    await q(`UPDATE trips SET status='COMPLETED', pinned_status='COMPLETED' WHERE id=$1`, [TRIP_A]);
    const out = await boarding.scan({ code: bk.passengers[0].token, tripId: TRIP_A }, ops());
    assert.equal(out.result, 'INVALID');
    assert.match(out.detail, /already complete/);
  });

  test('ALREADY BOARDED on a second scan, and it reports when', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-10010');
    await boarding.scan({ code: bk.passengers[0].token }, staffA());
    const out = await boarding.scan({ code: bk.passengers[0].token }, staffA());
    assert.equal(out.result, 'ALREADY BOARDED');
    assert.match(out.detail, /boarded at \d\d:\d\d/);
    assert.deepEqual((await eventsFor(bk.passengers[0].id)).map(e => e.result),
      ['VALID', 'ALREADY BOARDED'], 'both attempts are logged');
  });

  test('a DENIED passenger cannot then board by scanning', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-10011');
    await boarding.denyBoarding(bk.passengers[0].id, 'No student ID at the door', ops());
    const out = await boarding.scan({ code: bk.passengers[0].token }, staffA());
    assert.equal(out.result, 'INVALID');
    assert.match(out.detail, /was denied boarding/);
  });

  test('ORDER MATTERS \u00b7 a cancelled booking on the wrong trip reports the trip first', async () => {
    /* Both are true. The prototype reported wrong-trip first, because that is
     * what the staff member can act on at the door. */
    const bk = await confirmedBooking(TRIP_B, ['2B'], 'DLT-10012');
    await q(`UPDATE bookings SET status='CANCELLED_BY_DLT' WHERE id=$1`, [bk.booking.id]);
    const out = await boarding.scan({ code: bk.passengers[0].token }, staffA());
    assert.match(out.detail, /not the trip you are boarding/);
  });
});

/* ================================================================= F-11 */

describe('F-11 \u00b7 identifier resolution, one validation path', () => {
  test('a boarding code boards, and is logged as CODE not SCAN', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-20001');
    const out = await boarding.scan({ code: bk.booking.boarding_code }, staffA());
    assert.equal(out.result, 'VALID');
    assert.equal((await eventsFor(bk.passengers[0].id))[0].method, 'CODE');
  });

  test('a booking ID boards too', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-20002');
    assert.equal((await boarding.scan({ code: 'DLT-20002' }, staffA())).result, 'VALID');
  });

  test('codes are case- and space-insensitive \u2014 typed at a dark bus door', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-20003');
    const code = bk.booking.boarding_code.toLowerCase();
    assert.equal((await boarding.scan({ code: ` ${code} ` }, staffA())).result, 'VALID');
  });

  test('a typed code runs the SAME chain \u2014 wrong trip is still refused', async () => {
    const bk = await confirmedBooking(TRIP_B, ['2B'], 'DLT-20004');
    const out = await boarding.scan({ code: bk.booking.boarding_code }, staffA());
    assert.equal(out.result, 'INVALID');
    assert.match(out.detail, /not the trip you are boarding/);
  });

  test('a typed code on an unpaid booking is refused identically', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-20005');
    await q(`UPDATE payments SET status='PENDING' WHERE booking_id=$1`, [bk.booking.id]);
    assert.equal((await boarding.scan({ code: 'WX0005' }, staffA())).result, 'INVALID');
  });
});

/* ================================================================= CHOOSE */

describe('multi-passenger CHOOSE', () => {
  test('a code for several travellers asks rather than guessing', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2A', '2B', '2C'], 'DLT-30001');
    const out = await boarding.scan({ code: bk.booking.boarding_code }, staffA());
    assert.equal(out.result, 'CHOOSE');
    assert.equal(out.passengers!.length, 3);
    assert.equal(out.bookingCode, 'DLT-30001');
    /* CHOOSE is a question: nothing boarded, nothing logged. */
    assert.equal((await q('SELECT count(*)::int n FROM boarding_events')).rows[0].n, 0);
    for (const p of bk.passengers) assert.equal(await statusOf(p.id), 'NOT_BOARDED');
  });

  test('the follow-up boards exactly the chosen passenger', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2A', '2B'], 'DLT-30002');
    const chosen = bk.passengers[1];
    const out = await boarding.scan(
      { code: bk.booking.boarding_code, passengerId: chosen.id }, staffA());
    assert.equal(out.result, 'VALID');
    assert.equal(out.passenger!.seatNumber, chosen.seat_number);
    assert.equal(await statusOf(chosen.id), 'BOARDED');
    assert.equal(await statusOf(bk.passengers[0].id), 'NOT_BOARDED', 'only one boards');
  });

  test('a single-passenger booking never asks', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-30003');
    assert.equal((await boarding.scan({ code: 'WX0003' }, staffA())).result, 'VALID');
  });

  test('a passenger id from a different booking is refused', async () => {
    const a = await confirmedBooking(TRIP_A, ['2A', '2B'], 'DLT-30004');
    const b = await confirmedBooking(TRIP_A, ['4A'], 'DLT-30005');
    const out = await boarding.scan(
      { code: a.booking.boarding_code, passengerId: b.passengers[0].id }, staffA());
    assert.equal(out.result, 'INVALID');
    assert.match(out.detail, /matches that choice/);
  });

  test('a passenger with no pass issued is refused by name', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2A', '2B'], 'DLT-30006');
    await q('DELETE FROM boarding_passes WHERE passenger_id=$1', [bk.passengers[0].id]);
    const out = await boarding.scan(
      { code: bk.booking.boarding_code, passengerId: bk.passengers[0].id }, staffA());
    assert.equal(out.result, 'INVALID');
    assert.match(out.detail, /No boarding pass has been issued/);
  });
});

/* ================================================================= F-19 */

describe('F-19 \u00b7 trip assignment cannot be bypassed', () => {
  test('a client-supplied trip id is DISCARDED for boarding staff', async () => {
    const bk = await confirmedBooking(TRIP_B, ['2B'], 'DLT-40001');
    /* staff posts TRIP_B, hoping to board a TRIP_B pass. Their assignment is A. */
    const out = await boarding.scan({ code: bk.passengers[0].token, tripId: TRIP_B }, staffA());
    assert.equal(out.result, 'INVALID', 'the posted trip must not widen their scope');
    assert.match(out.detail, /not the trip you are boarding/);
  });

  test('unassigned staff cannot scan at all', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-40002');
    await assert.rejects(boarding.scan({ code: bk.passengers[0].token }, unassigned()),
      /not assigned to a trip/);
  });

  test('reassignment changes scope immediately', async () => {
    const onB = await confirmedBooking(TRIP_B, ['2B'], 'DLT-40003');
    assert.equal((await boarding.scan({ code: onB.passengers[0].token }, staffA())).result, 'INVALID');
    await q('DELETE FROM trip_staff WHERE user_id=$1', [STAFF_A]);
    await q(`INSERT INTO trip_staff (trip_id,user_id,assigned_by) VALUES ($1,$2,$3)`,
      [TRIP_B, STAFF_A, OPS]);
    assert.equal((await boarding.scan({ code: onB.passengers[0].token }, staffA())).result, 'VALID');
  });

  test('ops are not scoped by assignment and may board any trip', async () => {
    const onB = await confirmedBooking(TRIP_B, ['2B'], 'DLT-40004');
    assert.equal((await boarding.scan({ code: onB.passengers[0].token }, ops())).result, 'VALID');
  });

  test('ops may still scope a desk scan to one trip', async () => {
    const onB = await confirmedBooking(TRIP_B, ['2B'], 'DLT-40005');
    const out = await boarding.scan({ code: onB.passengers[0].token, tripId: TRIP_A }, ops());
    assert.equal(out.result, 'INVALID');
    assert.match(out.detail, /not the trip you are boarding/);
  });

  test('the scanner context reports the derived trip, not a guess', async () => {
    await confirmedBooking(TRIP_A, ['2A', '2B'], 'DLT-40006');
    const ctx = await boarding.scannerContext(staffA());
    assert.equal(ctx.assigned, true);
    assert.equal(ctx.trip.id, TRIP_A);
    assert.equal(ctx.canChooseTrip, false);
    assert.equal(ctx.trip.expected, 2);
    const spare = await boarding.scannerContext(unassigned());
    assert.equal(spare.assigned, false);
  });
});

/* ================================================================= concurrency */

describe('two scanners, one pass', () => {
  test('THE GUARANTEE \u00b7 simultaneous scans produce one VALID and one ALREADY BOARDED', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-50001');
    const token = bk.passengers[0].token;
    const [a, b] = await Promise.all([
      boarding.scan({ code: token }, staffA()),
      boarding.scan({ code: token }, ops()),
    ]);
    const results = [a.result, b.result].sort();
    assert.deepEqual(results, ['ALREADY BOARDED', 'VALID'],
      'a passenger must never board twice, however close the scans');
    const valid = (await eventsFor(bk.passengers[0].id)).filter(e => e.result === 'VALID');
    assert.equal(valid.length, 1, 'exactly one VALID event');
  });

  test('the row lock serialises: the loser BLOCKS rather than reading stale state', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-50002');
    const c1 = await pool.connect(), c2 = await pool.connect();
    try {
      await c1.query('BEGIN');
      await c1.query(`SELECT * FROM booking_passengers WHERE id=$1 FOR UPDATE`, [bk.passengers[0].id]);
      await c2.query('BEGIN');
      const blocked = c2.query(
        `SELECT * FROM board_by_pass(
           (SELECT id FROM boarding_passes WHERE passenger_id=$1),
           $2,'OPS_ADMIN'::user_role,NULL,'SCAN','x')`, [bk.passengers[0].id, OPS]);
      let settled = false;
      blocked.then(() => { settled = true; }, () => { settled = true; });
      await new Promise(r => setTimeout(r, 300));
      assert.equal(settled, false, 'without the row lock this would have answered already');
      await c1.query('ROLLBACK');
      await blocked;
      await c2.query('COMMIT');
    } finally { c1.release(); c2.release(); }
  });
});

/* ================================================================= permissions */

describe('least privilege', () => {
  test('a student cannot scan, board, deny or read a manifest', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-60001');
    await assert.rejects(boarding.scan({ code: bk.passengers[0].token }, student()), /cannot perform/);
    await assert.rejects(boarding.manualBoard(bk.passengers[0].id, 'let me on', student()), /cannot perform/);
    await assert.rejects(boarding.denyBoarding(bk.passengers[0].id, 'reasons', student()), /cannot perform/);
    await assert.rejects(boarding.manifest(TRIP_A, student()), /cannot perform/);
  });

  test('boarding staff can scan and read, but cannot board by hand or deny', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-60002');
    assert.equal((await boarding.scan({ code: bk.passengers[0].token }, staffA())).result, 'VALID');
    await assert.rejects(boarding.manualBoard(bk.passengers[0].id, 'camera broken', staffA()),
      /cannot perform/);
    await assert.rejects(boarding.denyBoarding(bk.passengers[0].id, 'no ID', staffA()), /cannot perform/);
    await assert.rejects(boarding.confirmNoShow(bk.passengers[0].id, 'never came', staffA()),
      /cannot perform/);
  });

  test('manual actions all demand a reason', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-60003');
    const p = bk.passengers[0].id;
    await assert.rejects(boarding.manualBoard(p, '', ops()), /reason is required/);
    await assert.rejects(boarding.denyBoarding(p, 'ok', ops()), /reason is required/);
    await assert.rejects(boarding.confirmNoShow(p, '   ', ops()), /reason is required/);
  });
});

/* ================================================================= manual paths */

describe('manual boarding, denial and no-show', () => {
  test('manual boarding is audited with its reason', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-70001');
    await boarding.manualBoard(bk.passengers[0].id, 'Camera failed, ID checked by hand', ops());
    assert.equal(await statusOf(bk.passengers[0].id), 'BOARDED');
    const { rows: [a] } = await q(
      `SELECT action, reason, before_value, after_value FROM audit_logs WHERE action='boarding.manual'`);
    assert.match(a.reason, /Camera failed/);
    assert.equal(a.after_value, 'BOARDED');
    assert.equal((await eventsFor(bk.passengers[0].id))[0].method, 'MANUAL');
  });

  test('manual boarding refuses somebody already boarded', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-70002');
    await boarding.scan({ code: bk.passengers[0].token }, staffA());
    await assert.rejects(boarding.manualBoard(bk.passengers[0].id, 'double check', ops()),
      /already boarded/);
  });

  test('denial voids the pass and is a distinct state, not a cancellation', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-70003');
    await boarding.denyBoarding(bk.passengers[0].id, 'Intoxicated at the door', ops());
    assert.equal(await statusOf(bk.passengers[0].id), 'DENIED_BOARDING');
    const { rows: [pass] } = await q('SELECT status FROM boarding_passes WHERE passenger_id=$1',
      [bk.passengers[0].id]);
    assert.equal(pass.status, 'VOID');
    const { rows: [b] } = await q('SELECT status FROM bookings WHERE id=$1', [bk.booking.id]);
    assert.equal(b.status, 'CONFIRMED', 'denial is not a cancellation');
    const { rows: [seat] } = await q(
      `SELECT status FROM trip_seats WHERE booking_id=$1`, [bk.booking.id]);
    assert.equal(seat.status, 'BOOKED', 'the seat is not resold');
    const { rows: [r] } = await q('SELECT count(*)::int n FROM refunds WHERE booking_id=$1',
      [bk.booking.id]);
    assert.equal(r.n, 0, 'no automatic refund');
  });

  test('a no-show is recorded without a refund, and cannot follow boarding', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2A', '2B'], 'DLT-70004');
    await boarding.confirmNoShow(bk.passengers[0].id, 'Did not arrive by departure', ops());
    assert.equal(await statusOf(bk.passengers[0].id), 'NO_SHOW');
    assert.equal((await q('SELECT count(*)::int n FROM refunds')).rows[0].n, 0);
    await boarding.scan({ code: bk.passengers[1].token }, staffA());
    await assert.rejects(boarding.confirmNoShow(bk.passengers[1].id, 'mistake', ops()),
      /boarded \u2014 that is not a no-show/);
  });
});

/* ================================================================= manifest */

describe('manifest', () => {
  test('boarding staff NEVER receive a phone number', async () => {
    await confirmedBooking(TRIP_A, ['2A', '2B'], 'DLT-80001');
    const asStaff = await boarding.manifest(null, staffA());
    assert.ok(asStaff.passengers.every((p: any) => p.phone === null),
      'least privilege is enforced in the projection, not by a caller remembering');
    const asOps = await boarding.manifest(TRIP_A, ops());
    assert.ok(asOps.passengers.every((p: any) => p.phone === '9876543210'));
  });

  test('staff get their ASSIGNED trip whatever id they ask for', async () => {
    await confirmedBooking(TRIP_A, ['2A'], 'DLT-80002');
    await confirmedBooking(TRIP_B, ['2A'], 'DLT-80003');
    const m = await boarding.manifest(TRIP_B, staffA());       // asks for B, assigned to A
    assert.equal(m.trip.id, TRIP_A);
  });

  test('counts reflect boarding progress', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2A', '2B', '2C'], 'DLT-80004');
    await boarding.scan({ code: bk.passengers[0].token }, staffA());
    await boarding.denyBoarding(bk.passengers[1].id, 'No student ID', ops());
    const m = await boarding.manifest(null, staffA());
    assert.deepEqual(m.counts, { expected: 3, boarded: 1, denied: 1, noShow: 0, awaiting: 1 });
  });

  test('only CONFIRMED bookings appear', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2A'], 'DLT-80005');
    await q(`UPDATE bookings SET status='CANCELLED_BY_STUDENT' WHERE id=$1`, [bk.booking.id]);
    assert.equal((await boarding.manifest(null, staffA())).passengers.length, 0);
  });

  test('seats sort numerically, as staff read them', async () => {
    await confirmedBooking(TRIP_A, ['2A', '10A', '1A'], 'DLT-80006');
    const m = await boarding.manifest(null, staffA());
    assert.deepEqual(m.passengers.map((p: any) => p.seatNumber), ['1A', '2A', '10A'],
      'text sorting would put 10A second');
  });

  test('the event log includes refused attempts', async () => {
    const bk = await confirmedBooking(TRIP_A, ['2B'], 'DLT-80007');
    await boarding.scan({ code: 'garbage' }, staffA());
    await boarding.scan({ code: bk.passengers[0].token }, staffA());
    const events = await boarding.boardingEvents(TRIP_A, ops());
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e: any) => e.result).sort(), ['INVALID', 'VALID']);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * WHAT THESE TESTS CANNOT COVER, AND WHY IT STILL MATTERS
 *
 * Everything above is server-side and, once run, is real verification. What
 * remains untestable anywhere but at an actual coach door:
 *
 *  · CAMERA DECODE. Whether a phone camera reads a DLT symbol in evening light,
 *    at arm's length, on a lit screen, with a queue moving. The decoder is
 *    proved in software; optics are not.
 *  · HARDWARE SCANNERS. No third-party or hardware reader has been put in front
 *    of a DLT pass.
 *  · NETWORK AT THE STOP. Every scan is now a server round trip. The prototype
 *    validated in the page and could not fail this way. If the coach door has no
 *    signal, boarding stops. THIS IS A NEW OPERATIONAL RISK CREATED BY THIS
 *    PHASE and it needs an answer before launch — a decision, not code:
 *    guaranteed connectivity, a tethered device, or a documented paper fallback
 *    using the manifest. An offline queue is NOT an option: it would make the
 *    browser the authority again and reintroduce F-01.
 * ───────────────────────────────────────────────────────────────────────────── */
