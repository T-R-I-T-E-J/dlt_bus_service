/* DLT · test/seats.concurrency.test.ts
 *
 * The tests that matter most in the whole backend, and the ones that cannot be
 * faked. Each uses TWO SEPARATE POSTGRES CONNECTIONS held open simultaneously,
 * because the question being asked is what happens when two transactions
 * overlap. A single connection, a mock, or a Promise.all over one pool client
 * would all answer a different and easier question.
 *
 * The evidence being gathered is not merely "one of them failed". It is:
 *   1. the loser BLOCKS while the winner's transaction is open, and
 *   2. the loser then gets a DETERMINISTIC conflict, and
 *   3. exactly one allocation exists afterwards.
 * A check-then-act race can produce (2) and (3) by luck. Only a real row lock
 * produces (1), so (1) is asserted explicitly wherever it applies.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * STATUS: WRITTEN — NOT EXECUTED — NOT VERIFIED.
 *
 * There is no PostgreSQL, no Node runtime and no package installer in the
 * environment where this was authored. Nothing below has produced a result.
 *
 * To run, on a machine that has them:
 *
 *   createdb dlt_test
 *   export DATABASE_URL=postgres://localhost/dlt_test
 *   psql "$DATABASE_URL" -f backend/migrations/001_init.sql
 *   psql "$DATABASE_URL" -f backend/migrations/002_seat_allocation.sql
 *   psql "$DATABASE_URL" -f backend/migrations/003_auth.sql
 *   psql "$DATABASE_URL" -f backend/migrations/004_seats_waitlist.sql
 *   npm ci
 *   node --test --experimental-strip-types backend/test/seats.concurrency.test.ts
 *
 * Report the output as the verification. Until then this file is a claim.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import * as seats from '../src/domain/seats.ts';
import { resetTables } from './_reset.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const q = (sql: string, args: unknown[] = []) => pool.query(sql, args);

let TRIP: string, ALICE: string, BOB: string, CAROL: string;

/** True if the promise has still not settled after `ms`. This is how "B is
 *  BLOCKED on A's row lock" is asserted: a check-then-act race would return
 *  immediately (settled), a real lock makes B wait. Attaching the handlers
 *  before the delay matters — a rejection must not go unhandled. */
async function stillPending(p: Promise<unknown>, ms = 300): Promise<boolean> {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(r => setTimeout(r, ms));
  return !settled;
}

async function seed() {
  await resetTables(pool, `users, trips, routes, vehicles, trip_seats, bookings,
    booking_passengers, waitlist_entries, payments, refunds, audit_logs,
    sessions, user_credentials, student_profiles`);
  const mk = async (email: string, name: string) =>
    (await q(`INSERT INTO users (email,name,role) VALUES ($1,$2,'STUDENT') RETURNING id`, [email, name])).rows[0].id;
  ALICE = await mk('alice@woxsen.edu.in', 'Alice');
  BOB = await mk('bob@woxsen.edu.in', 'Bob');
  CAROL = await mk('carol@woxsen.edu.in', 'Carol');

  const r = (await q(`INSERT INTO routes (code,origin,destination,duration_min)
    VALUES ('WX-MYP','Woxsen','Miyapur Metro',75) RETURNING id`)).rows[0].id;
  const v = (await q(`INSERT INTO vehicles (name,registration,row_count)
    VALUES ('DLT-01','TS07 AA 1111',11) RETURNING id`)).rows[0].id;
  TRIP = (await q(`INSERT INTO trips (route_id,vehicle_id,departure_at,price,status)
    VALUES ($1,$2, now() + interval '2 days', 259, 'OPEN') RETURNING id`, [r, v])).rows[0].id;
  await q('SELECT materialise_trip_seats($1)', [TRIP]);
}

const seatRow = (n: string) =>
  q('SELECT * FROM trip_seats WHERE trip_id=$1 AND seat_number=$2', [TRIP, n]).then(r => r.rows[0]);

before(async () => {
  const { rows: [v] } = await q('SHOW server_version_num');
  assert.ok(Number(v.server_version_num) >= 150000, 'PostgreSQL 15+ required');
});
after(async () => { await pool.end(); });
beforeEach(seed);

/* ================================================================= holds */

describe('two devices, one seat', () => {
  test('THE CORE GUARANTEE · B blocks while A holds the row, then loses deterministically', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      const won = await a.query('SELECT * FROM hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '2B', ALICE]);
      assert.equal(won.rows[0].status, 'HELD');

      await b.query('BEGIN');
      const bTries = b.query('SELECT * FROM hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '2B', BOB]);

      // (1) B must be WAITING on A's row lock, not answered already
      assert.equal(await stillPending(bTries), true,
        'B returned before A committed — the FOR UPDATE row lock is missing');

      await a.query('COMMIT');

      // (2) and then lose, with a conflict a client can act on
      await assert.rejects(bTries, (e: any) => {
        assert.equal(e.code, '23505', 'the loser must get unique_violation, not a generic error');
        assert.match(e.message, /seat 2B is held/);
        return true;
      });
      await b.query('ROLLBACK');

      // (3) exactly one holder
      const s = await seatRow('2B');
      assert.equal(s.status, 'HELD');
      assert.equal(s.hold_by, ALICE);
    } finally { a.release(); b.release(); }
  });

  test('the loser is the one who arrives second, whichever that is', async () => {
    /* seed() runs first and reassigns ALICE/BOB, so first/second must be read
     * AFTER it — not destructured from a pair built beforehand. */
    for (const swap of [false, true]) {
      await seed();
      const [first, second] = swap ? [BOB, ALICE] : [ALICE, BOB];
      const a = await pool.connect(), b = await pool.connect();
      try {
        await a.query('BEGIN');
        await a.query('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '4C', first]);
        await b.query('BEGIN');
        const loser = b.query('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '4C', second]);
        await a.query('COMMIT');
        await assert.rejects(loser);
        await b.query('ROLLBACK');
        assert.equal((await seatRow('4C')).hold_by, first);
      } finally { a.release(); b.release(); }
    }
  });

  test('if the winner rolls back, the seat is genuinely free for the other', async () => {
    const a = await pool.connect(), b = await pool.connect();
    try {
      await a.query('BEGIN');
      await a.query('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '5A', ALICE]);
      await b.query('BEGIN');
      const bTries = b.query('SELECT * FROM hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '5A', BOB]);
      await a.query('ROLLBACK');
      const got = await bTries;                    // B now succeeds
      assert.equal(got.rows[0].hold_by, BOB);
      await b.query('COMMIT');
      assert.equal((await seatRow('5A')).hold_by, BOB);
    } finally { a.release(); b.release(); }
  });

  test('different seats do not contend', async () => {
    const a = await pool.connect(), b = await pool.connect();
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      await a.query('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '6A', ALICE]);
      await b.query('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '6B', BOB]);   // must not block
      await a.query('COMMIT'); await b.query('COMMIT');
      assert.equal((await seatRow('6A')).hold_by, ALICE);
      assert.equal((await seatRow('6B')).hold_by, BOB);
    } finally { a.release(); b.release(); }
  });

  test('ten devices race for one seat: exactly one wins', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '7D', i % 2 ? ALICE : BOB])));
    /* Alice and Bob alternate, so renewals by the same holder also succeed —
     * what must be impossible is BOTH of them holding it. */
    const s = await seatRow('7D');
    assert.equal(s.status, 'HELD');
    assert.ok([ALICE, BOB].includes(s.hold_by));
    const { rows } = await q(
      `SELECT count(*)::int n FROM trip_seats WHERE trip_id=$1 AND seat_number='7D'`, [TRIP]);
    assert.equal(rows[0].n, 1, 'one seat row, always');
    assert.ok(results.some(r => r.status === 'rejected'), 'the other holder must have been refused');
  });
});

/* ================================================================= expiry */

/* ================================================================= §12 cap */

describe('the booking cap is five seats (spec §12)', () => {
  test('a student may hold five seats, and is refused the sixth', async () => {
    for (const s of ['1A', '1B', '1C', '1D', '2A'])
      await seats.holdSeat(TRIP, s, { userId: ALICE });
    await assert.rejects(seats.holdSeat(TRIP, '2B', { userId: ALICE }),
      /up to 5 seats/, 'the sixth is refused by the domain');
  });

  test('the DATABASE refuses a sixth passenger too — not only the domain', async () => {
    /* The cap has two authoritative homes: the basket check while holding, and
     * create_booking_from_holds while converting. Migration 012 moved both. A
     * caller that bypassed the domain must still be refused. */
    const five = ['3A', '3B', '3C', '3D', '4A'];
    for (const s of five) await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, s, BOB]);
    const pax = (arr: string[]) => JSON.stringify(arr.map((s, i) => ({
      seatNumber: s, name: `Passenger ${i + 1}`, studentId: `WU20000${i}`, phone: '9876543210' })));

    const ok = await q(
      'SELECT * FROM create_booking_from_holds($1,$2::uuid,NULL,$3,$4::jsonb)',
      [TRIP, BOB, '9876543210', pax(five)]);
    assert.equal(ok.rows.length, 1, 'five seats convert into a booking');

    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '4B', CAROL]);
    await assert.rejects(
      q('SELECT * FROM create_booking_from_holds($1,$2::uuid,NULL,$3,$4::jsonb)',
        [TRIP, CAROL, '9876543210', pax(['4B', '4C', '4D', '5A', '5B', '5C'])]),
      /up to 5 passengers in one booking/);
  });

  test('the cap is per holder — it does not leak between students', async () => {
    for (const s of ['6A', '6B', '6C', '6D', '7A'])
      await seats.holdSeat(TRIP, s, { userId: ALICE });
    /* Alice is full; Bob is not affected by that. */
    await assert.rejects(seats.holdSeat(TRIP, '7B', { userId: ALICE }), /up to 5 seats/);
    const s = await seats.holdSeat(TRIP, '7B', { userId: BOB });
    assert.equal(s.status, 'HELD');
  });

  test('a full basket still cannot take a seat another student holds', async () => {
    await seats.holdSeat(TRIP, '8A', { userId: BOB });
    for (const s of ['8B', '8C', '8D', '9A'])
      await seats.holdSeat(TRIP, s, { userId: ALICE });
    /* Alice has four; the fifth is allowed by the cap but is not hers to take. */
    await assert.rejects(seats.holdSeat(TRIP, '8A', { userId: ALICE }), /8A/);
    assert.equal((await seatRow('8A')).hold_by, BOB, 'ownership is unchanged');
  });
});

describe('hold expiry', () => {
  test('an expired hold reads as available before any sweeper runs', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '3A', ALICE]);
    await q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 second'
              WHERE trip_id=$1 AND seat_number='3A'`, [TRIP]);
    const { rows: [v] } = await q(
      `SELECT status FROM trip_seat_view WHERE trip_id=$1 AND seat_number='3A'`, [TRIP]);
    assert.equal(v.status, 'AVAILABLE', 'the view must not show a lapsed hold as taken');
  });

  test('a competing student can take the seat once the hold lapses', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '3B', ALICE]);
    await assert.rejects(q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '3B', BOB]));
    await q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 second'
              WHERE trip_id=$1 AND seat_number='3B'`, [TRIP]);
    const { rows: [s] } = await q('SELECT * FROM hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '3B', BOB]);
    assert.equal(s.hold_by, BOB);
  });

  test('the holder may renew their own hold, and renewal extends the clock', async () => {
    const first = (await q('SELECT * FROM hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '3C', ALICE])).rows[0];
    await new Promise(r => setTimeout(r, 1100));
    const second = (await q('SELECT * FROM hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '3D', ALICE])).rows[0];
    const renew = (await q('SELECT * FROM hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '3C', ALICE])).rows[0];
    assert.ok(new Date(renew.hold_expires_at) > new Date(first.hold_expires_at));
    assert.ok(second);
  });

  test('the sweeper releases lapsed holds and abandons their bookings', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '8A', ALICE]);
    const bk = (await q(
      `INSERT INTO bookings (code,boarding_code,trip_id,user_id,status,unit_price,total_amount,hold_expires_at)
       VALUES ('DLT-1','WX1',$1,$2,'PAYMENT_PENDING',259,259, now() - interval '1 minute')
       RETURNING id`, [TRIP, ALICE])).rows[0].id;
    await q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 minute'
              WHERE trip_id=$1 AND seat_number='8A'`, [TRIP]);

    const { rows: [r] } = await q('SELECT * FROM sweep_expired_holds()');
    assert.ok(r.seats_released >= 1);
    assert.ok(r.bookings_abandoned >= 1);
    assert.equal((await seatRow('8A')).status, 'AVAILABLE');
    const { rows: [b] } = await q('SELECT status FROM bookings WHERE id=$1', [bk]);
    assert.equal(b.status, 'ABANDONED');
  });
});

/* ================================================================= guests */

describe('guest holds (F-08, F-09)', () => {
  test('a browser with no account can hold a seat', async () => {
    const { rows: [s] } = await q('SELECT * FROM hold_seat($1,$2,NULL,$3)', [TRIP, '9A', 'guest-1']);
    assert.equal(s.status, 'HELD');
    assert.equal(s.hold_by, null);
    assert.equal(s.hold_guest_token, 'guest-1');
  });

  test('a guest and a student compete on equal terms', async () => {
    await q('SELECT hold_seat($1,$2,NULL,$3)', [TRIP, '9B', 'guest-1']);
    await assert.rejects(q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '9B', ALICE]));
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '9C', ALICE]);
    await assert.rejects(q('SELECT hold_seat($1,$2,NULL,$3)', [TRIP, '9C', 'guest-1']));
  });

  test('two different guests cannot share a seat', async () => {
    await q('SELECT hold_seat($1,$2,NULL,$3)', [TRIP, '9D', 'guest-1']);
    await assert.rejects(q('SELECT hold_seat($1,$2,NULL,$3)', [TRIP, '9D', 'guest-2']));
  });

  test('a guest may renew their own hold', async () => {
    const a = (await q('SELECT * FROM hold_seat($1,$2,NULL,$3)', [TRIP, '10A', 'g'])).rows[0];
    const b = (await q('SELECT * FROM hold_seat($1,$2,NULL,$3)', [TRIP, '10A', 'g'])).rows[0];
    assert.ok(new Date(b.hold_expires_at) >= new Date(a.hold_expires_at));
  });

  test('a hold needs exactly one holder', async () => {
    await assert.rejects(q('SELECT hold_seat($1,$2,NULL,NULL)', [TRIP, '10B']));
    await assert.rejects(q('SELECT hold_seat($1,$2,$3::uuid,$4)', [TRIP, '10B', ALICE, 'g']));
  });

  test('THE DEFECT · a lapsed GUEST hold sweeps, clearing the token with it', async () => {
    /* The sweeper predates hold_guest_token and cleared only hold_by, so an
     * AVAILABLE row kept its token and trip_seats_allocation_coherent rejected
     * the update. Every expired guest hold leaked, and because the public trip
     * list sweeps inline, GET /trips answered 500 for everyone. The sweeper test
     * above uses a signed-in holder, which is why this went unseen.
     * Fixed in migration 011. */
    await q('SELECT hold_seat($1,$2,NULL,$3)', [TRIP, '10C', 'lapsing-guest']);
    await q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 minute'
              WHERE trip_id=$1 AND seat_number='10C'`, [TRIP]);

    const { rows: [r] } = await q('SELECT * FROM sweep_expired_holds()');
    assert.ok(r.seats_released >= 1, 'the guest seat must actually be released');

    const s = await seatRow('10C');
    assert.equal(s.status, 'AVAILABLE');
    assert.equal(s.hold_guest_token, null, 'an AVAILABLE seat may not carry a holder');
    assert.equal(s.hold_by, null);
    assert.equal(s.hold_expires_at, null);
  });
});

/* ================================================================= release */

describe('release (F-20)', () => {
  test('a student releases only their own seat', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '11A', ALICE]);
    const { rows: [no] } = await q('SELECT release_seat($1,$2,$3::uuid,NULL) AS ok', [TRIP, '11A', BOB]);
    assert.equal(no.ok, false, 'Bob must not be able to free Alice\u2019s seat');
    assert.equal((await seatRow('11A')).status, 'HELD');
    const { rows: [yes] } = await q('SELECT release_seat($1,$2,$3::uuid,NULL) AS ok', [TRIP, '11A', ALICE]);
    assert.equal(yes.ok, true);
    assert.equal((await seatRow('11A')).status, 'AVAILABLE');
  });

  test('releasing the whole basket frees only that holder\u2019s seats', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '1A', ALICE]);
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '1B', ALICE]);
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '1C', BOB]);
    const { rows: [r] } = await q('SELECT release_all_held($1,$2::uuid,NULL) AS n', [TRIP, ALICE]);
    assert.equal(r.n, 2);
    assert.equal((await seatRow('1C')).hold_by, BOB);
  });
});

/* ================================================================= allocation */

describe('allocation and the late-settlement defect (F-01)', () => {
  async function bookingFor(user: string, code: string, status = 'PAYMENT_PENDING') {
    return (await q(
      `INSERT INTO bookings (code,boarding_code,trip_id,user_id,status,unit_price,total_amount,hold_expires_at)
       VALUES ($1,$2,$3,$4,$5,259,259, now() + interval '10 minutes') RETURNING id`,
      [code, code.replace('DLT-', 'WX'), TRIP, user, status])).rows[0].id;
  }

  test('a held seat allocates to its holder\u2019s booking, idempotently', async () => {
    const seat = (await q('SELECT * FROM hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '2A', ALICE])).rows[0];
    const bk = await bookingFor(ALICE, 'DLT-2001');
    const one = (await q('SELECT * FROM allocate_seat_to_booking($1,$2)', [seat.id, bk])).rows[0];
    const two = (await q('SELECT * FROM allocate_seat_to_booking($1,$2)', [seat.id, bk])).rows[0];
    assert.equal(one.status, 'BOOKED');
    assert.equal(two.booking_id, bk);
  });

  test('a booking cannot allocate a seat held by somebody else', async () => {
    const seat = (await q('SELECT * FROM hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '2C', ALICE])).rows[0];
    const bobs = await bookingFor(BOB, 'DLT-2002');
    await assert.rejects(q('SELECT allocate_seat_to_booking($1,$2)', [seat.id, bobs]),
      (e: any) => e.code === '23505');
  });

  test('THE REPRODUCED DEFECT · a late settlement cannot resurrect an abandoned booking', async () => {
    // Alice holds 2D, starts paying, then walks away
    const seat = (await q('SELECT * FROM hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '2D', ALICE])).rows[0];
    const alices = await bookingFor(ALICE, 'DLT-2003');
    await q(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id=$1`, [alices]);
    await q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 minute' WHERE id=$1`, [seat.id]);
    await q('SELECT sweep_expired_holds()');
    assert.equal((await seatRow('2D')).status, 'AVAILABLE');

    // Bob takes the freed seat and pays properly
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '2D', BOB]);
    const bobs = await bookingFor(BOB, 'DLT-2004');
    await q('SELECT allocate_seat_to_booking($1,$2)', [seat.id, bobs]);

    // Alice's acquirer webhook finally lands
    await assert.rejects(q('SELECT allocate_seat_to_booking($1,$2)', [seat.id, alices]),
      (e: any) => { assert.match(e.message, /ABANDONED/); return true; });

    const s = await seatRow('2D');
    assert.equal(s.booking_id, bobs, 'the seat belongs to the student who actually paid');
    const { rows: [n] } = await q(
      `SELECT count(*)::int n FROM trip_seats WHERE trip_id=$1 AND seat_number='2D' AND status='BOOKED'`, [TRIP]);
    assert.equal(n.n, 1, 'never two allocations of one seat');
  });

  test('the unique index is a backstop even if a code path forgets the function', async () => {
    const seat = (await q('SELECT * FROM hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '2A', ALICE])).rows[0];
    const bk = await bookingFor(ALICE, 'DLT-2005');
    await q('SELECT allocate_seat_to_booking($1,$2)', [seat.id, bk]);
    await assert.rejects(q(
      `INSERT INTO trip_seats (trip_id,seat_number,seat_row,seat_type,status,booking_id)
       VALUES ($1,'2A',2,'WINDOW','BOOKED',$2)`, [TRIP, bk]),
      (e: any) => e.code === '23505');
  });

  test('two bookings settling for the same seat at once: one wins', async () => {
    const seat = (await q('SELECT * FROM hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '11D', ALICE])).rows[0];
    const b1 = await bookingFor(ALICE, 'DLT-2006');
    const b2 = await bookingFor(ALICE, 'DLT-2007');
    const results = await Promise.allSettled([
      q('SELECT allocate_seat_to_booking($1,$2)', [seat.id, b1]),
      q('SELECT allocate_seat_to_booking($1,$2)', [seat.id, b2]),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  });
});

/* ================================================================= waitlist */

describe('waitlist (F-02)', () => {
  async function fillTrip() {
    await q(`UPDATE trip_seats SET status='BLOCKED', block_reason='test fill' WHERE trip_id=$1`, [TRIP]);
  }
  const wl = async (user: string, pos: number) => (await q(
    `INSERT INTO waitlist_entries (trip_id,user_id,position) VALUES ($1,$2,$3) RETURNING id`,
    [TRIP, user, pos])).rows[0].id;

  test('an offer RESERVES a real seat, it does not merely announce one', async () => {
    await fillTrip();
    const e = await wl(ALICE, 1);
    await q(`UPDATE trip_seats SET status='AVAILABLE', block_reason=NULL
              WHERE trip_id=$1 AND seat_number='2B'`, [TRIP]);
    const { rows: [off] } = await q('SELECT * FROM offer_seat_to_waitlist($1)', [TRIP]);
    assert.equal(off.id, e);
    assert.equal(off.status, 'CLAIM_OFFERED');
    const s = await seatRow('2B');
    assert.equal(s.status, 'HELD', 'the seat must leave the sale for the offer window');
    assert.equal(s.hold_by, ALICE);
  });

  test('nobody else can take the reserved seat during the window', async () => {
    await fillTrip();
    await wl(ALICE, 1);
    await q(`UPDATE trip_seats SET status='AVAILABLE', block_reason=NULL
              WHERE trip_id=$1 AND seat_number='2B'`, [TRIP]);
    await q('SELECT offer_seat_to_waitlist($1)', [TRIP]);
    await assert.rejects(q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '2B', BOB]));
  });

  /* CONCURRENCY DEFECT found under real HTTP load-testing (10-20 concurrent
   * joins on one trip): joinWaitlist's position read (SELECT max(position)+1,
   * no lock) let two transactions compute and insert the same "next" before
   * either committed. Reproduced live: 3 of 5 concurrent joins on one trip
   * landed on position 1. Fixed in domain/seats.ts (a FOR UPDATE lock on the
   * trip row, serialising joins per trip) with waitlist_position_unique_per_trip
   * (migration 017) as a backstop. This pins both down so neither can regress
   * silently — position is a real ordering guarantee students are shown
   * ("you are #3"), even though offer_seat_to_waitlist's own
   * ORDER BY (position, created_at) FOR UPDATE SKIP LOCKED meant this was
   * never a seat-safety defect, only a display/fairness one. */
  test('THE REPRODUCED DEFECT · many concurrent joins never collide on position', async () => {
    const n = 12;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { rows: [u] } = await q(
        `INSERT INTO users (email,name,role,phone) VALUES ($1,$2,'STUDENT','9876543210') RETURNING id`,
        [`wlrace${i}@woxsen.edu.in`, `WL Race ${i}`]);
      ids.push(u.id);
    }
    const entries = await Promise.all(ids.map((userId) => seats.joinWaitlist(TRIP, userId, 1)));
    const positions = entries.map((e) => e.position).sort((a, b) => a - b);
    assert.deepEqual(positions, Array.from({ length: n }, (_, i) => i + 1),
      'every concurrent joiner must land on a distinct, sequential position');
  });

  test('the offered student claims it and gets a normal basket', async () => {
    await fillTrip();
    const e = await wl(ALICE, 1);
    await q(`UPDATE trip_seats SET status='AVAILABLE', block_reason=NULL
              WHERE trip_id=$1 AND seat_number='2B'`, [TRIP]);
    await q('SELECT offer_seat_to_waitlist($1)', [TRIP]);
    const { rows: [s] } = await q('SELECT * FROM claim_waitlist_offer($1,$2)', [e, ALICE]);
    assert.equal(s.seat_number, '2B');
    assert.equal(s.hold_by, ALICE);
    const { rows: [w] } = await q('SELECT status FROM waitlist_entries WHERE id=$1', [e]);
    assert.equal(w.status, 'CLAIMED');
  });

  test('another student cannot claim somebody else\u2019s offer', async () => {
    await fillTrip();
    const e = await wl(ALICE, 1);
    await q(`UPDATE trip_seats SET status='AVAILABLE', block_reason=NULL
              WHERE trip_id=$1 AND seat_number='2B'`, [TRIP]);
    await q('SELECT offer_seat_to_waitlist($1)', [TRIP]);
    await assert.rejects(q('SELECT claim_waitlist_offer($1,$2)', [e, BOB]),
      (err: any) => err.code === '42501');
  });

  test('an expired offer releases the seat and re-offers to the next student', async () => {
    await fillTrip();
    const e1 = await wl(ALICE, 1);
    const e2 = await wl(BOB, 2);
    await q(`UPDATE trip_seats SET status='AVAILABLE', block_reason=NULL
              WHERE trip_id=$1 AND seat_number='2B'`, [TRIP]);
    await q('SELECT offer_seat_to_waitlist($1)', [TRIP]);
    await q(`UPDATE waitlist_entries SET offer_expires_at = now() - interval '1 minute' WHERE id=$1`, [e1]);

    const { rows: [n] } = await q('SELECT expire_waitlist_offers() AS n');
    assert.equal(n.n, 1);
    const { rows: [a] } = await q('SELECT status FROM waitlist_entries WHERE id=$1', [e1]);
    const { rows: [b] } = await q('SELECT status, reserved_seat_id FROM waitlist_entries WHERE id=$1', [e2]);
    assert.equal(a.status, 'EXPIRED');
    assert.equal(b.status, 'CLAIM_OFFERED', 'the next student must be offered it automatically');
    assert.ok(b.reserved_seat_id);
  });

  test('an expired offer cannot be claimed', async () => {
    await fillTrip();
    const e = await wl(ALICE, 1);
    await q(`UPDATE trip_seats SET status='AVAILABLE', block_reason=NULL
              WHERE trip_id=$1 AND seat_number='2B'`, [TRIP]);
    await q('SELECT offer_seat_to_waitlist($1)', [TRIP]);
    await q(`UPDATE waitlist_entries SET offer_expires_at = now() - interval '1 minute' WHERE id=$1`, [e]);
    await assert.rejects(q('SELECT claim_waitlist_offer($1,$2)', [e, ALICE]), /expired/);
  });

  test('declining passes the seat straight to the next student', async () => {
    await fillTrip();
    const e1 = await wl(ALICE, 1);
    const e2 = await wl(BOB, 2);
    await q(`UPDATE trip_seats SET status='AVAILABLE', block_reason=NULL
              WHERE trip_id=$1 AND seat_number='2B'`, [TRIP]);
    await q('SELECT offer_seat_to_waitlist($1)', [TRIP]);
    await q('SELECT decline_waitlist_offer($1,$2)', [e1, ALICE]);
    const { rows: [b] } = await q('SELECT status FROM waitlist_entries WHERE id=$1', [e2]);
    assert.equal(b.status, 'CLAIM_OFFERED');
  });

  test('two concurrent offer runs never offer the same seat twice', async () => {
    await fillTrip();
    await wl(ALICE, 1);
    await wl(BOB, 2);
    await q(`UPDATE trip_seats SET status='AVAILABLE', block_reason=NULL
              WHERE trip_id=$1 AND seat_number='2B'`, [TRIP]);
    await Promise.allSettled([
      q('SELECT offer_seat_to_waitlist($1)', [TRIP]),
      q('SELECT offer_seat_to_waitlist($1)', [TRIP]),
    ]);
    const { rows: [n] } = await q(
      `SELECT count(*)::int n FROM waitlist_entries WHERE trip_id=$1 AND status='CLAIM_OFFERED'`, [TRIP]);
    assert.equal(n.n, 1, 'one free seat can only be offered to one student');
  });

  test('one active waitlist entry per student per trip', async () => {
    await wl(ALICE, 1);
    await assert.rejects(wl(ALICE, 2), (e: any) => e.code === '23505');
  });
});

/* ================================================================= trip rules */

describe('trip state', () => {
  test('seats cannot be held once booking closes', async () => {
    await q(`UPDATE trips SET status='BOOKING_CLOSED' WHERE id=$1`, [TRIP]);
    await assert.rejects(q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '2B', ALICE]),
      (e: any) => e.code === '23514');
  });

  test('a blocked seat is not holdable', async () => {
    await q(`UPDATE trip_seats SET status='BLOCKED', block_reason='water damage'
              WHERE trip_id=$1 AND seat_number='2B'`, [TRIP]);
    await assert.rejects(q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '2B', ALICE]));
  });

  test('the seat map cannot be rebuilt while seats are sold', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '2B', ALICE]);
    await assert.rejects(q('SELECT materialise_trip_seats($1)', [TRIP]), /already held or booked/);
  });
});
