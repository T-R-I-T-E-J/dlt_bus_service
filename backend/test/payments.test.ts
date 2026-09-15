/* DLT · test/payments.test.ts — the booking and payment state machine.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STATUS: WRITTEN — NOT EXECUTED — NOT VERIFIED.
 *
 * TWO SEPARATE CLAIMS ARE AT STAKE, AND THEY MUST NOT BE CONFLATED:
 *
 *   1. Our handling is correct GIVEN Razorpay's documented payload and
 *      signature scheme. These tests can establish that — once run.
 *
 *   2. Razorpay actually behaves as documented. These tests CANNOT establish
 *      that. They run against `createFakeRazorpay`, which signs with the scheme
 *      read from Razorpay's documentation during this migration. Documented is
 *      better than the previous position (which was assumed), but it is still
 *      not observed: if the live payload differs, every test below passes and
 *      production fails.
 *
 * Tests marked [provider-simulated] rest on claim (2). Do not describe them as
 * Razorpay verification. What verifies Razorpay is a TEST-mode transaction whose
 * webhook is accepted, plus a tampered webhook that is rejected.
 *
 * PROVIDER-INDEPENDENT tests carry no such caveat: booking creation, seat
 * consumption, repricing, the refund cap, cancellation policy, complimentary
 * bookings and the waitlist path exercise our own rules and constraints only.
 *
 * Run:
 *   createdb dlt_test
 *   export DATABASE_URL=postgres://localhost/dlt_test
 *   for f in backend/migrations/00*.sql; do psql "$DATABASE_URL" -f "$f"; done
 *   npm ci
 *   node --test --experimental-strip-types backend/test/payments.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createHmac } from 'node:crypto';
import { createFakeRazorpay } from '../src/integrations/razorpay/index.ts';
import * as pay from '../src/domain/payments.ts';
import * as seats from '../src/domain/seats.ts';
import type { Actor } from '../src/domain/authz.ts';
import type { PaymentProvider } from '../src/domain/payment-provider.ts';
import { resetTables } from './_reset.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const q = (sql: string, a: unknown[] = []) => pool.query(sql, a);
const rp = createFakeRazorpay('test-webhook-secret');

let TRIP: string, ALICE: string, BOB: string, SUPER: string;
const FARE = 259;

/* The domain now takes an Actor ({ userId, role }), never a bare user-id string.
 * ALICE/BOB/SUPER remain the raw ids (used in SQL and as booking holders); A()
 * wraps one for the guard. Ownership is by userId; role only drives the
 * permission fallback, so STUDENT is the right default for the owners. */
const A = (userId: string, role = 'STUDENT'): Actor => ({ userId, role });

async function fixtureSql(sql: string, args: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL session_replication_role = replica`);
    const out = await c.query(sql, args);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

function nonIdempotentOrderProvider(): PaymentProvider & { orderCalls: () => number } {
  let calls = 0;
  return {
    name: 'RAZORPAY',
    orderCalls: () => calls,
    async createOrder(i) {
      calls += 1;
      const id = `order_LIVE_LIKE_${calls}`;
      return { providerOrderId: id, checkoutHandle: id, providerStatus: 'created' };
    },
    async fetchOrder(providerOrderId) {
      return {
        providerOrderId,
        kind: 'IGNORED',
        providerStatus: 'created',
        amountRupees: FARE,
        paymentId: null,
      };
    },
    async createRefund() {
      return { providerRefundId: 'rfnd_unused', providerStatus: 'pending', kind: 'IGNORED', acquirerReference: null };
    },
    verifyAndParseWebhook() { throw new Error('not used'); },
    verifyCheckoutHandback() { return false; },
  };
}

async function seed() {
  await resetTables(pool, `users, trips, routes, vehicles, trip_seats, bookings, booking_passengers,
    payments, refunds, provider_events, boarding_passes, waitlist_entries,
    idempotency_keys, notification_requests, audit_logs`);
  const mk = async (e: string, n: string, r = 'STUDENT') =>
    (await q(`INSERT INTO users (email,name,role,phone) VALUES ($1,$2,$3,'9876543210') RETURNING id`,
      [e, n, r])).rows[0].id;
  ALICE = await mk('alice@woxsen.edu.in', 'Alice');
  BOB = await mk('bob@woxsen.edu.in', 'Bob');
  SUPER = await mk('super@dlt.co.in', 'Super', 'SUPER_ADMIN');
  const r = (await q(`INSERT INTO routes (code,origin,destination,duration_min)
    VALUES ('WX-MYP','Woxsen','Miyapur',75) RETURNING id`)).rows[0].id;
  /* 14 rows: tests reference seats through 14D. */
  const v = (await q(`INSERT INTO vehicles (name,registration,row_count)
    VALUES ('DLT-01','TS07 AA 1111',14) RETURNING id`)).rows[0].id;
  TRIP = (await q(`INSERT INTO trips (route_id,vehicle_id,departure_at,price,status)
    VALUES ($1,$2, now() + interval '3 days', $3,'DRAFT') RETURNING id`, [r, v, FARE])).rows[0].id;
  await q('SELECT materialise_trip_seats($1)', [TRIP]);
  await q("UPDATE trips SET status='OPEN' WHERE id=$1", [TRIP]);
  rp.orders.clear();
}

/** A booking with `seats` held-and-consumed, ready to pay. */
async function booked(user: string, seats: string[]) {
  for (const s of seats) await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, s, user]);
  return pay.createBooking({
    tripId: TRIP, holder: { userId: user }, contactPhone: '9876543210',
    idempotencyKey: `k-${user}-${seats.join('')}-${Math.random()}`,
    passengers: seats.map((s, i) => ({ seatNumber: s, name: `Passenger ${i + 1}`, studentId: `WU10000${i}` })),
  });
}

/** [provider-simulated] Deliver a webhook shaped the way Razorpay documents:
 *  `{ event, payload: { payment: { entity } } }`, amounts in PAISE, signed as a
 *  hex HMAC-SHA256 over the raw body, with a unique x-razorpay-event-id. */
async function deliver(paymentId: string, outcome: 'captured' | 'failed', opts: {
  amountRupees?: number; eventId?: string; providerPaymentId?: string } = {}) {
  const { rows: [p] } = await q('SELECT * FROM payments WHERE id=$1', [paymentId]);
  const rupees = opts.amountRupees ?? p.amount;
  const payload = {
    event: outcome === 'captured' ? 'payment.captured' : 'payment.failed',
    payload: { payment: { entity: {
      id: opts.providerPaymentId ?? `pay_TEST${paymentId.slice(0, 8)}`,
      order_id: p.provider_order_id,
      status: outcome,
      amount: Math.round(rupees * 100),          // PAISE, as Razorpay sends
      currency: 'INR',
      error_description: outcome === 'failed' ? 'card declined by issuer' : null,
    } } },
  };
  const eventId = opts.eventId ?? `evt_${paymentId}_${outcome}`;
  const { raw, headers } = rp.signedWebhook(payload, eventId);
  const event = rp.verifyAndParseWebhook(raw, headers);
  const out = await pay.recordWebhook(event, true);
  await pay.processPendingEvents(rp);
  return out;
}

/** [provider-simulated] A refund outcome webhook. */
async function deliverRefund(refundId: string, providerRefundId: string,
  status: 'processed' | 'failed', eventId?: string) {
  const payload = {
    event: `refund.${status}`,
    payload: { refund: { entity: {
      id: providerRefundId, status, amount: 100, currency: 'INR',
      acquirer_data: { arn: 'ARN12345' },
    } } },
  };
  const { raw, headers } = rp.signedWebhook(payload, eventId ?? `evt_rfnd_${providerRefundId}`);
  const out = await pay.recordWebhook(rp.verifyAndParseWebhook(raw, headers), true);
  await pay.processPendingEvents(rp);
  return out;
}

const money = async (id: string) =>
  (await q('SELECT * FROM booking_money WHERE booking_id=$1', [id])).rows[0];
const seatOf = async (n: string) =>
  (await q('SELECT * FROM trip_seats WHERE trip_id=$1 AND seat_number=$2', [TRIP, n])).rows[0];

after(async () => { await pool.end(); });
beforeEach(seed);

/* ================================================================= creation */

describe('booking creation', () => {
  test('turns a basket of holds into a PAYMENT_PENDING booking at the frozen fare', async () => {
    const b = await booked(ALICE, ['2A', '2B']);
    assert.equal(b.status, 'PAYMENT_PENDING');
    assert.equal(b.totalAmount, FARE * 2);
    assert.equal(b.unitPrice, FARE);
    assert.equal(b.passengers.length, 2);
    assert.match(b.code, /^DLT-\d{5}$/);
    assert.match(b.boardingCode, /^WX\d{4}$/);
  });

  test('refuses seats that are not the caller\u2019s hold', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '3A', BOB]);
    await assert.rejects(pay.createBooking({
      tripId: TRIP, holder: { userId: ALICE }, contactPhone: '9876543210',
      idempotencyKey: 'k1', passengers: [{ seatNumber: '3A', name: 'Alice A', studentId: 'WU0001' }],
    }), /hold on seat 3A has gone/);
  });

  test('refuses a lapsed hold', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '3B', ALICE]);
    await q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 min'
              WHERE trip_id=$1 AND seat_number='3B'`, [TRIP]);
    await assert.rejects(pay.createBooking({
      tripId: TRIP, holder: { userId: ALICE }, contactPhone: '9876543210',
      idempotencyKey: 'k2', passengers: [{ seatNumber: '3B', name: 'Alice A', studentId: 'WU0001' }],
    }));
  });

  test('§5 · the same Idempotency-Key returns the same booking, not a second one', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '4A', ALICE]);
    const args = { tripId: TRIP, holder: { userId: ALICE }, contactPhone: '9876543210',
      idempotencyKey: 'same-key',
      passengers: [{ seatNumber: '4A', name: 'Alice A', studentId: 'WU0001' }] };
    const first = await pay.createBooking(args);
    const second = await pay.createBooking(args);
    assert.equal(first.id, second.id);
    const { rows } = await q('SELECT count(*)::int n FROM bookings');
    assert.equal(rows[0].n, 1);
  });

  test('validates contact and passenger details server-side', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '4B', ALICE]);
    await assert.rejects(pay.createBooking({ tripId: TRIP, holder: { userId: ALICE },
      contactPhone: '12345', idempotencyKey: 'k3',
      passengers: [{ seatNumber: '4B', name: 'Alice A', studentId: 'WU0001' }] }), /mobile/);
  });

  /* THE REPRODUCED DEFECT, found under real failure-mode testing simulating a
   * browser refresh mid-checkout: the client's in-memory idempotency key is
   * lost on refresh, so a retry carries a DIFFERENT key against seats the
   * SAME holder still legitimately holds. That is NOT the same-key replay
   * case above — create_booking_from_holds let a second booking through,
   * silently overwriting trip_seats.booking_id and orphaning the first.
   * Reproduced live: two distinct booking codes, one seat. Fixed in
   * migration 018: a seat already claimed by an existing PAYMENT_PENDING
   * booking now refuses a second one, by name, rather than orphaning it. */
  test('THE REPRODUCED DEFECT · a second booking with a NEW key on an already-booked-pending held seat is refused', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '5A', ALICE]);
    const first = await pay.createBooking({
      tripId: TRIP, holder: { userId: ALICE }, contactPhone: '9876543210',
      idempotencyKey: 'refresh-key-A',
      passengers: [{ seatNumber: '5A', name: 'Alice A', studentId: 'WU0001' }],
    });
    assert.equal(first.status, 'PAYMENT_PENDING');

    await assert.rejects(pay.createBooking({
      tripId: TRIP, holder: { userId: ALICE }, contactPhone: '9876543210',
      idempotencyKey: 'refresh-key-B',   // a genuinely different key — not a replay
      passengers: [{ seatNumber: '5A', name: 'Alice A', studentId: 'WU0001' }],
    }), new RegExp(first.code));

    const s = await seatOf('5A');
    assert.equal(s.booking_id, first.id, 'the first booking must still own the seat');
    const { rows } = await q('SELECT count(*)::int n FROM bookings WHERE id <> $1', [first.id]);
    assert.equal(rows[0].n, 0, 'no orphaned second booking was created');
  });
});

/* ================================================================= happy path */

describe('payment success [provider-simulated]', () => {
  test('confirms the booking, books the seats and issues one pass per passenger', async () => {
    const b = await booked(ALICE, ['5A', '5B']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    assert.equal(co.amount, FARE * 2);

    await deliver(co.paymentId, 'captured');

    const after = await pay.bookingViewById(b.id);
    assert.equal(after.status, 'CONFIRMED');
    assert.equal(after.payment.status, 'SUCCESS');
    assert.equal((await seatOf('5A')).status, 'BOOKED');
    const { rows: [p] } = await q('SELECT count(*)::int n FROM boarding_passes WHERE booking_id=$1', [b.id]);
    assert.equal(p.n, 2);
    assert.ok(after.passengers.every((x: any) => x.passStatus === 'VALID'));
  });

  test('the checkout amount comes from the booking, never from the caller', async () => {
    const b = await booked(ALICE, ['6A']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    assert.equal(rp.orders.get(co.providerOrderId)!.amount, FARE * 100);
  });

  test('a second checkout call reuses the live intent rather than making two orders', async () => {
    const b = await booked(ALICE, ['6B']);
    const a1 = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    const a2 = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    assert.equal(a1.paymentId, a2.paymentId);
  });

  test('THE REPRODUCED DEFECT · a second checkout call reuses the stored provider order id', async () => {
    const b = await booked(ALICE, ['6D']);
    const liveLike = nonIdempotentOrderProvider();
    const a1 = await pay.createCheckout(b.id, A(ALICE), liveLike) as any;
    const a2 = await pay.createCheckout(b.id, A(ALICE), liveLike) as any;

    assert.equal(a1.paymentId, a2.paymentId);
    assert.equal(a1.providerOrderId, a2.providerOrderId);
    assert.equal(a1.checkoutHandle, a2.checkoutHandle);
    assert.equal(liveLike.orderCalls(), 1);
  });

  test('another student cannot pay for a booking that is not theirs', async () => {
    const b = await booked(ALICE, ['6C']);
    await assert.rejects(pay.createCheckout(b.id, A(BOB), rp), /not yours/);
  });
});

/* ================================================================= idempotency */

describe('§5 idempotency and replay [provider-simulated]', () => {
  test('THE SAME WEBHOOK TWICE changes nothing the second time', async () => {
    const b = await booked(ALICE, ['7A']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured', { eventId: 'evt_fixed' });
    const second = await deliver(co.paymentId, 'captured', { eventId: 'evt_fixed' });

    assert.equal(second.stored, false, 'a replay must collide on provider_event_id');
    const counts = await q(`SELECT
      (SELECT count(*) FROM bookings WHERE id=$1) AS bookings,
      (SELECT count(*) FROM boarding_passes WHERE booking_id=$1) AS passes,
      (SELECT count(*) FROM payments WHERE booking_id=$1 AND status='SUCCESS') AS paid,
      (SELECT count(*) FROM refunds WHERE booking_id=$1) AS refunds,
      (SELECT count(*) FROM trip_seats WHERE booking_id=$1 AND status='BOOKED') AS seats`, [b.id]);
    const c = counts.rows[0];
    assert.equal(Number(c.passes), 1, 'no duplicate boarding pass');
    assert.equal(Number(c.paid), 1, 'no duplicate financial record');
    assert.equal(Number(c.refunds), 0);
    assert.equal(Number(c.seats), 1, 'no double allocation');
  });

  test('processing the same event twice is a no-op even if it is re-queued', async () => {
    const b = await booked(ALICE, ['7B']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured');
    await q('UPDATE provider_events SET processed_at = NULL');
    await pay.processPendingEvents(rp);
    const { rows: [n] } = await q(
      'SELECT count(*)::int n FROM boarding_passes WHERE booking_id=$1', [b.id]);
    assert.equal(n.n, 1);
  });

  test('two workers processing concurrently do not both apply an event', async () => {
    const b = await booked(ALICE, ['7C']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    const { rows: [p] } = await q('SELECT * FROM payments WHERE id=$1', [co.paymentId]);
    const payload = { event: 'payment.captured', payload: { payment: { entity: {
      id: 'pay_race', order_id: p.provider_order_id, status: 'captured',
      amount: p.amount * 100, currency: 'INR' } } } };
    const { raw, headers } = rp.signedWebhook(payload, 'evt_race');
    await pay.recordWebhook(rp.verifyAndParseWebhook(raw, headers), true);
    await Promise.all([pay.processPendingEvents(rp), pay.processPendingEvents(rp)]);
    const { rows: [n] } = await q('SELECT count(*)::int n FROM boarding_passes WHERE booking_id=$1', [b.id]);
    assert.equal(n.n, 1);
  });

  test('an unsigned or tampered webhook is never processed', async () => {
    const b = await booked(ALICE, ['7D']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    const { rows: [p] } = await q('SELECT * FROM payments WHERE id=$1', [co.paymentId]);
    const payload = { event: 'payment.captured', payload: { payment: { entity: {
      id: 'pay_bad', order_id: p.provider_order_id, status: 'captured', amount: 25900 } } } };
    const { raw, headers } = rp.signedWebhook(payload, 'evt_bad');

    /* a signature that does not match the raw body */
    assert.throws(() => rp.verifyAndParseWebhook(raw, { ...headers,
      'x-razorpay-signature': 'a'.repeat(64) }), /bad webhook signature/);
    /* no signature at all */
    assert.throws(() => rp.verifyAndParseWebhook(raw, {}), /unsigned/);
    /* a TAMPERED body against a valid signature for the original */
    const tampered = raw.replace('25900', '1');
    assert.throws(() => rp.verifyAndParseWebhook(tampered, headers), /bad webhook signature/);
    /* Razorpay-specific: no event id means no replay protection, so refuse.
     * There is no timestamp in a Razorpay signature, so the event id is the
     * ONLY defence against a double apply. */
    assert.throws(() => rp.verifyAndParseWebhook(raw,
      { 'x-razorpay-signature': headers['x-razorpay-signature'] }), /no x-razorpay-event-id/);

    assert.equal((await pay.bookingViewById(b.id)).status, 'PAYMENT_PENDING');
  });

  test('RAZORPAY-SPECIFIC · an old delivery still verifies, and dedupe is what stops it', async () => {
    /* Razorpay does not include a timestamp in the signed message, so staleness
     * CANNOT be detected and must not be faked — rejecting old deliveries would
     * break their legitimate 24-hour retries and their 15-day dashboard replay.
     * Replay safety therefore rests entirely on the event id being unique. */
    const b = await booked(ALICE, ['12A']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    const first = await deliver(co.paymentId, 'captured', { eventId: 'evt_replayed' });
    const again = await deliver(co.paymentId, 'captured', { eventId: 'evt_replayed' });
    assert.equal(first.stored, true);
    assert.equal(again.stored, false, 'the UNIQUE (provider, event id) index is the whole defence');
    const { rows: [n] } = await q(
      'SELECT count(*)::int n FROM boarding_passes WHERE booking_id=$1', [b.id]);
    assert.equal(n.n, 1);
  });

  test('RAZORPAY-SPECIFIC · payment.authorized is recorded but does NOT confirm', async () => {
    /* Ordering is not guaranteed: authorized may arrive after captured. Treating
     * an authorisation as money received would confirm before funds are ours. */
    const b = await booked(ALICE, ['12B']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    const { rows: [p] } = await q('SELECT * FROM payments WHERE id=$1', [co.paymentId]);
    const payload = { event: 'payment.authorized', payload: { payment: { entity: {
      id: 'pay_auth', order_id: p.provider_order_id, status: 'authorized',
      amount: p.amount * 100, currency: 'INR' } } } };
    const { raw, headers } = rp.signedWebhook(payload, 'evt_auth');
    await pay.recordWebhook(rp.verifyAndParseWebhook(raw, headers), true);
    await pay.processPendingEvents(rp);
    assert.equal((await pay.bookingViewById(b.id)).status, 'PAYMENT_PENDING');

    await deliver(co.paymentId, 'captured');          // now the capture lands
    assert.equal((await pay.bookingViewById(b.id)).status, 'CONFIRMED');
  });

  test('RAZORPAY-SPECIFIC · amounts convert rupees ↔ paise at the boundary only', async () => {
    const b = await booked(ALICE, ['12C']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    assert.equal(co.amount, FARE, 'our API speaks rupees');
    assert.equal(rp.orders.get(co.providerOrderId)!.amount, FARE * 100, 'the provider is sent paise');
    await deliver(co.paymentId, 'captured');
    const { rows: [p] } = await q('SELECT amount FROM payments WHERE id=$1', [co.paymentId]);
    assert.equal(p.amount, FARE, 'the database stays in rupees');
  });

  test('RAZORPAY-SPECIFIC · the checkout handback verifies against OUR order id', async () => {
    const b = await booked(ALICE, ['12D']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    const ours = co.providerOrderId as string;
    const sig = createHmac('sha256', rp.keySecret)
      .update(`${ours}|pay_handback`, 'utf8').digest('hex');
    assert.equal(rp.verifyCheckoutHandback({ ourOrderId: ours!,
      providerPaymentId: 'pay_handback', signature: sig }), true);
    /* an attacker substituting their own order id must not verify */
    assert.equal(rp.verifyCheckoutHandback({ ourOrderId: 'order_ATTACKER',
      providerPaymentId: 'pay_handback', signature: sig }), false);
    assert.equal(rp.verifyCheckoutHandback({ ourOrderId: ours!,
      providerPaymentId: 'pay_handback', signature: 'b'.repeat(64) }), false);
  });
});

/* ================================================================= failure */

describe('failure, timeout and stale intents [provider-simulated]', () => {
  test('a failed payment leaves the booking payable and the seats held', async () => {
    const b = await booked(ALICE, ['8A']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'failed');
    const after = await pay.bookingViewById(b.id);
    assert.equal(after.status, 'PAYMENT_PENDING');
    assert.equal((await seatOf('8A')).status, 'HELD');
  });

  test('a failure webhook can never downgrade an already successful payment', async () => {
    const b = await booked(ALICE, ['8B']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured');
    await deliver(co.paymentId, 'failed', { eventId: 'evt_late_fail' });
    assert.equal((await pay.bookingViewById(b.id)).payment.status, 'SUCCESS');
  });

  test('a timeout (no webhook at all) leaves the booking to the sweeper', async () => {
    const b = await booked(ALICE, ['8C']);
    await pay.createCheckout(b.id, A(ALICE), rp);
    await q(`UPDATE bookings SET hold_expires_at = now() - interval '1 min' WHERE id=$1`, [b.id]);
    await q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 min' WHERE booking_id=$1`, [b.id]);
    await q('SELECT sweep_expired_holds()');
    assert.equal((await pay.bookingViewById(b.id)).status, 'ABANDONED');
    assert.equal((await seatOf('8C')).status, 'AVAILABLE');
  });

  test('an amount mismatch is a discrepancy and is refunded, never silently accepted', async () => {
    const b = await booked(ALICE, ['8D']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured', { amountRupees: 100 });
    const m = await money(b.id);
    assert.equal(m.received, 100);
    assert.equal(m.returned, 0, 'the pending obligation is not money returned yet');
    assert.equal(m.refundable, 0, 'the obligation consumes the refundable balance');
    assert.notEqual((await pay.bookingViewById(b.id)).status, 'CONFIRMED');
  });

  /* ------------------------------------------------ amount semantics (§ledger)
   *
   * payments.amount is MONEY ACTUALLY RECEIVED once a payment settles. The
   * intended figure lives on bookings.total_amount. The ledger previously
   * recorded the ordered amount as received, which overstated cash in and left
   * a phantom refundable balance an override could have paid out. */

  test('LEDGER · an underpayment records what arrived, not what was ordered', async () => {
    const b = await booked(ALICE, ['9B']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    assert.equal(co.amount, FARE, 'the order asks for the full fare');
    await deliver(co.paymentId, 'captured', { amountRupees: 100 });

    const { rows: [p] } = await q('SELECT amount, status, failure_reason FROM payments WHERE id=$1',
      [co.paymentId]);
    assert.equal(p.amount, 100, 'payments.amount is the money actually received');
    assert.match(p.failure_reason, /expected ₹259, received ₹100/,
      'the intended figure is still recorded, just not in amount');

    const { rows: [bk] } = await q('SELECT total_amount FROM bookings WHERE id=$1', [b.id]);
    assert.equal(bk.total_amount, FARE, 'the booking still carries what was owed');

    const m = await money(b.id);
    assert.equal(m.received, 100);
    assert.equal(m.total_amount, FARE);
  });

  test('LEDGER · the refund cap after an underpayment is the money received', async () => {
    const b = await booked(ALICE, ['9C']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured', { amountRupees: 100 });

    /* the discrepancy refund obligation already consumes the whole ₹100 */
    assert.equal((await money(b.id)).refundable, 0, 'nothing is left to give back');
    /* and an override cannot manufacture the ₹159 that never arrived */
    await assert.rejects(pay.overrideRefund({ bookingId: b.id, amount: 159,
      reason: 'trying to refund money we never received', actorId: SUPER }),
      /Nothing is left to refund/);
  });

  test('LEDGER · an exact payment is unaffected', async () => {
    const b = await booked(ALICE, ['9D']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured');
    const { rows: [p] } = await q('SELECT amount, failure_reason FROM payments WHERE id=$1',
      [co.paymentId]);
    assert.equal(p.amount, FARE);
    assert.equal(p.failure_reason, null, 'an exact payment is not a discrepancy');
    const m = await money(b.id);
    assert.equal(m.received, FARE);
    assert.equal(m.returned, 0);
    assert.equal((await pay.bookingViewById(b.id)).status, 'CONFIRMED');
  });

  test('LEDGER · an OVERpayment is also a discrepancy, returned in full', async () => {
    const b = await booked(ALICE, ['10B']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured', { amountRupees: 300 });
    const m = await money(b.id);
    assert.equal(m.received, 300, 'we received ₹300 and must say so');
    assert.equal(m.returned, 0, 'pending refund obligation is not reported as returned');
    assert.equal(m.refundable, 0);
    assert.notEqual((await pay.bookingViewById(b.id)).status, 'CONFIRMED');
  });

  test('LEDGER · a re-queued mismatch event neither double-refunds nor confirms', async () => {
    /* Because amount now equals what was received, a naive re-run would find the
     * amounts equal and settle the booking. It must not. */
    const b = await booked(ALICE, ['10C']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured', { amountRupees: 100 });

    await q('UPDATE provider_events SET processed_at = NULL');
    await pay.processPendingEvents(rp);

    const m = await money(b.id);
    assert.equal(m.received, 100, 'still one receipt');
    assert.equal(m.returned, 0, 'the pending obligation is still not money returned');
    assert.equal(m.refundable, 0, 'still ONE obligation — not two');
    const { rows: [n] } = await q(
      'SELECT count(*)::int n FROM refunds WHERE booking_id=$1', [b.id]);
    assert.equal(n.n, 1);
    assert.notEqual((await pay.bookingViewById(b.id)).status, 'CONFIRMED',
      'a discrepancy must never be settled by a replay');
    const { rows: [pass] } = await q(
      'SELECT count(*)::int n FROM boarding_passes WHERE booking_id=$1', [b.id]);
    assert.equal(pass.n, 0, 'no pass may be issued for an unconfirmed booking');
  });
});

/* ================================================================= F-01 */

describe('F-01 · late settlement [provider-simulated]', () => {
  test('THE REPRODUCED DEFECT · a late payment refunds and never takes the seat back', async () => {
    // Alice books 9A and starts paying
    const alices = await booked(ALICE, ['9A']);
    const co = await pay.createCheckout(alices.id, A(ALICE), rp) as any;

    // she walks away; the hold lapses and the sweeper abandons the booking
    await q(`UPDATE bookings SET hold_expires_at = now() - interval '1 min' WHERE id=$1`, [alices.id]);
    await q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 min' WHERE booking_id=$1`, [alices.id]);
    await q('SELECT sweep_expired_holds()');
    assert.equal((await seatOf('9A')).status, 'AVAILABLE');

    // Bob takes the freed seat and pays properly
    const bobs = await booked(BOB, ['9A']);
    const bco = await pay.createCheckout(bobs.id, A(BOB), rp) as any;
    await deliver(bco.paymentId, 'captured');
    assert.equal((await pay.bookingViewById(bobs.id)).status, 'CONFIRMED');

    // Alice's acquirer webhook finally lands
    await deliver(co.paymentId, 'captured');

    const a = await pay.bookingViewById(alices.id);
    assert.notEqual(a.status, 'CONFIRMED', 'an abandoned booking must never be resurrected');
    const am = await money(alices.id);
    assert.equal(am.returned, 0, 'the pending obligation is not money returned yet');
    assert.equal(am.refundable, 0, 'her full fare is obligated for return');

    const seat = await seatOf('9A');
    assert.equal(seat.booking_id, bobs.id, 'the seat belongs to the student who actually paid');
    const { rows: [n] } = await q(
      `SELECT count(*)::int n FROM boarding_passes p JOIN bookings b ON b.id=p.booking_id
        WHERE p.trip_id=$1 AND p.status='VALID'
          AND p.passenger_id IN (SELECT id FROM booking_passengers WHERE seat_number='9A')`, [TRIP]);
    assert.equal(n.n, 1, 'exactly one valid pass for seat 9A — the defect produced two');
  });

  test('operations is told, rather than the money quietly sitting there', async () => {
    const b = await booked(ALICE, ['10A']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await q(
      `INSERT INTO notification_requests (kind,user_id,trip_id,email,reason)
       VALUES ('GET_NOTIFIED',$1,$2,'alice@woxsen.edu.in','Existing waitlist notice')`,
      [ALICE, TRIP]);
    await q(`UPDATE bookings SET status='ABANDONED' WHERE id=$1`, [b.id]);
    await deliver(co.paymentId, 'captured');
    const { rows } = await q(`SELECT reason FROM notification_requests WHERE reason LIKE '%Late settlement%'`);
    assert.equal(rows.length, 1);
  });
});

/* ================================================================= F-03 */

describe('F-03 · repricing', () => {
  test('THE REPRODUCED DEFECT · a fare change returns data instead of looping forever', async () => {
    const b = await booked(ALICE, ['11A']);
    await fixtureSql('UPDATE trips SET price = 299 WHERE id=$1', [TRIP]);

    const first = await pay.createCheckout(b.id, A(ALICE), rp);
    const second = await pay.createCheckout(b.id, A(ALICE), rp);
    assert.ok('repriced' in first && 'repriced' in second);
    assert.equal((first as any).newTotal, 299);
    /* the prototype threw here, rolling back its own correction, so the same
     * error recurred forever with the stored total never updated */
    const { rows: [row] } = await q('SELECT reprice_to FROM bookings WHERE id=$1', [b.id]);
    assert.equal(row.reprice_to, 299, 'the revalidated total must PERSIST');
  });

  test('the student accepts the new total and can then pay it', async () => {
    const b = await booked(ALICE, ['11B']);
    await fixtureSql('UPDATE trips SET price = 299 WHERE id=$1', [TRIP]);
    await pay.createCheckout(b.id, A(ALICE), rp);
    const accepted = await pay.acceptReprice(b.id, A(ALICE));
    assert.equal(accepted.totalAmount, 299);

    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    assert.equal(co.amount, 299);
    await deliver(co.paymentId, 'captured');
    assert.equal((await pay.bookingViewById(b.id)).status, 'CONFIRMED');
  });

  test('accepting a reprice cancels any intent created at the old amount', async () => {
    const b = await booked(ALICE, ['11C']);
    const stale = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await fixtureSql('UPDATE trips SET price = 299 WHERE id=$1', [TRIP]);
    await pay.createCheckout(b.id, A(ALICE), rp);
    await pay.acceptReprice(b.id, A(ALICE));
    const { rows: [p] } = await q('SELECT status FROM payments WHERE id=$1', [stale.paymentId]);
    assert.equal(p.status, 'CANCELLED');
  });
});

/* ================================================================= duplicates */

describe('duplicate payment [provider-simulated]', () => {
  test('a second successful payment is marked DUPLICATE and refunded in full', async () => {
    const b = await booked(ALICE, ['1A']);
    const one = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(one.paymentId, 'captured');

    /* a second intent that also settles — the acquirer charged twice */
    const { rows: [p2] } = await q(
      `INSERT INTO payments (booking_id, amount, status, provider, provider_order_id)
       VALUES ($1,$2,'PENDING','RAZORPAY',$3) RETURNING *`,
      [b.id, FARE, 'order_dup_1']);
    rp.orders.set('order_dup_1', { id: 'order_dup_1', amount: FARE * 100, status: 'paid', receipt: p2.id });
    await deliver(p2.id, 'captured', { eventId: 'evt_dup' });

    const { rows: [dup] } = await q('SELECT status FROM payments WHERE id=$1', [p2.id]);
    assert.equal(dup.status, 'DUPLICATE');
    const m = await money(b.id);
    assert.equal(m.received, FARE * 2);
    assert.equal(m.returned, 0, 'the duplicate refund is not returned until provider settlement');
    assert.equal(m.refundable, FARE, 'the duplicate obligation leaves the original fare refundable');
    assert.equal((await pay.bookingViewById(b.id)).status, 'CONFIRMED', 'the student keeps their seat');
  });
});

/* ================================================================= refunds */

describe('cancellation and refunds (F-05, F-12)', () => {
  async function confirmed(user = ALICE, seat = '1B') {
    const b = await booked(user, [seat]);
    const co = await pay.createCheckout(b.id, A(user), rp) as any;
    await deliver(co.paymentId, 'captured');
    return b;
  }

  test('cancelling before payment releases the seats and refunds nothing', async () => {
    const b = await booked(ALICE, ['1C']);
    const out = await pay.cancelBooking(b.id, A(ALICE));
    assert.equal(out.refundAmount, 0);
    assert.equal((await seatOf('1C')).status, 'AVAILABLE');
  });

  test('cancelling outside 24 hours refunds in full and frees the seat', async () => {
    const b = await confirmed(ALICE, '1D');
    const quote = await pay.cancellationQuote(b.id, A(ALICE));
    assert.equal(quote.amount, FARE);
    const out = await pay.cancelBooking(b.id, A(ALICE));
    assert.equal(out.refundAmount, FARE);
    assert.equal((await seatOf('1D')).status, 'AVAILABLE');
    const { rows: [p] } = await q(
      `SELECT status FROM boarding_passes WHERE booking_id=$1`, [b.id]);
    assert.equal(p.status, 'VOID');
  });

  test('inside 24 hours the policy refunds nothing', async () => {
    const b = await confirmed(ALICE, '2C');
    await fixtureSql(`UPDATE trips SET departure_at = now() + interval '18 hours' WHERE id=$1`, [TRIP]);
    assert.equal((await pay.cancellationQuote(b.id, A(ALICE))).amount, 0);
    assert.equal((await pay.cancelBooking(b.id, A(ALICE))).refundAmount, 0);
  });

  test('F-05 · money out can never exceed money in', async () => {
    const b = await confirmed(ALICE, '2D');
    await pay.cancelBooking(b.id, A(ALICE));
    await assert.rejects(pay.overrideRefund({ bookingId: b.id, amount: 1,
      reason: 'trying to double refund', actorId: SUPER }), /Nothing is left to refund/);
  });

  test('F-05 · a complimentary booking refunds nothing, by construction', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '3C', SUPER]);
    await q(`UPDATE trip_seats SET status='AVAILABLE', hold_by=NULL, hold_expires_at=NULL
              WHERE trip_id=$1 AND seat_number='3C'`, [TRIP]);
    const b = await pay.createManualBooking({ tripId: TRIP, type: 'COMPLIMENTARY',
      contactPhone: '9876543210', reason: 'University staff escorting a group', actorId: SUPER,
      passengers: [{ seatNumber: '3C', name: 'Escort Officer', studentId: 'STAFF22' }] });
    assert.equal(b.totalAmount, 0);
    assert.equal(b.payment.provider, 'NONE_COMPLIMENTARY');
    assert.equal((await money(b.id)).refundable, 0);
    assert.equal((await pay.cancellationQuote(b.id, A(SUPER, 'SUPER_ADMIN'))).amount, 0);
    await assert.rejects(pay.overrideRefund({ bookingId: b.id, amount: FARE,
      reason: 'trying to refund a free seat', actorId: SUPER }), /Nothing is left to refund/);
  });

  test('F-12 · the override refuses \u20b90 and refuses more than is held', async () => {
    const b = await confirmed(ALICE, '4C');
    await fixtureSql(`UPDATE trips SET departure_at = now() + interval '3 hours' WHERE id=$1`, [TRIP]);
    await assert.rejects(pay.overrideRefund({ bookingId: b.id, amount: 0,
      reason: 'nothing at all', actorId: SUPER }), /zero-value/);
    await assert.rejects(pay.overrideRefund({ bookingId: b.id, amount: FARE + 500,
      reason: 'more than we took', actorId: SUPER }), /more than/);
    await assert.rejects(pay.overrideRefund({ bookingId: b.id, amount: 100,
      reason: '', actorId: SUPER }), /reason/);
  });

  test('F-12 · a real override refunds inside the cutoff and reports the true amount', async () => {
    const b = await confirmed(ALICE, '4D');
    await fixtureSql(`UPDATE trips SET departure_at = now() + interval '3 hours' WHERE id=$1`, [TRIP]);
    assert.equal((await pay.cancellationQuote(b.id, A(ALICE))).amount, 0);
    const out = await pay.overrideRefund({ bookingId: b.id, amount: 100,
      reason: 'Departure retimed by 90 minutes', cancelBooking: true, actorId: SUPER });
    assert.equal(out.amount, 100);
    assert.equal(out.seatsReleased, 1);
    assert.equal(out.remainingRefundable, FARE - 100);
    const { rows: [r] } = await q('SELECT is_override, reason FROM refunds WHERE booking_id=$1', [b.id]);
    assert.equal(r.is_override, true);
    assert.match(r.reason, /Policy override: Departure retimed/);
  });

  test('a freed seat is offered to the waitlist', async () => {
    const b = await confirmed(ALICE, '5C');
    await q(`INSERT INTO waitlist_entries (trip_id,user_id,position) VALUES ($1,$2,1)`, [TRIP, BOB]);
    await q(`UPDATE trip_seats SET status='BLOCKED', block_reason='fill'
              WHERE trip_id=$1 AND status='AVAILABLE'`, [TRIP]);
    await pay.cancelBooking(b.id, A(ALICE));
    const { rows: [w] } = await q(
      `SELECT status, reserved_seat_id FROM waitlist_entries WHERE trip_id=$1`, [TRIP]);
    assert.equal(w.status, 'CLAIM_OFFERED');
    assert.ok(w.reserved_seat_id);
  });
});

/* ============================================ refund dispatch (new in Razorpay) */

describe('refund dispatch and refund webhooks [provider-simulated]', () => {
  test('AUTO_REFUNDS_ENABLED=false leaves a pending obligation undispatched', async () => {
    const prior = process.env.AUTO_REFUNDS_ENABLED;
    process.env.AUTO_REFUNDS_ENABLED = 'false';
    try {
      const b = await booked(ALICE, ['13A']);
      const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
      await deliver(co.paymentId, 'captured', { providerPaymentId: 'pay_refundable' });
      await pay.cancelBooking(b.id, A(ALICE));

      const before = await q(`SELECT provider_refund_id FROM refunds WHERE booking_id=$1`, [b.id]);
      assert.equal(before.rows[0].provider_refund_id, null, 'not yet dispatched');

      const sent = await pay.dispatchPendingRefunds(rp);
      assert.equal(sent, 0, 'automatic refund dispatch is disabled in production policy');
      const after = await q(`SELECT provider_refund_id, status FROM refunds WHERE booking_id=$1`, [b.id]);
      assert.equal(after.rows[0].provider_refund_id, null);
      assert.equal(after.rows[0].status, 'REFUND_PENDING');
    } finally {
      if (prior === undefined) delete process.env.AUTO_REFUNDS_ENABLED;
      else process.env.AUTO_REFUNDS_ENABLED = prior;
    }
  });

  test('refund.processed is what finally settles it', async () => {
    const b = await booked(ALICE, ['13B']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured', { providerPaymentId: 'pay_r2' });
    await pay.cancelBooking(b.id, A(SUPER, 'SUPER_ADMIN'));
    await q(`UPDATE refunds SET provider_refund_id='rfnd_r2', provider_status='created'
              WHERE booking_id=$1`, [b.id]);
    const { rows: [r] } = await q('SELECT * FROM refunds WHERE booking_id=$1', [b.id]);

    await deliverRefund(r.id, r.provider_refund_id, 'processed');
    const { rows: [done] } = await q('SELECT status, provider_status FROM refunds WHERE id=$1', [r.id]);
    assert.equal(done.status, 'REFUNDED');
  });

  test('a failed refund is recorded as failed, not silently settled', async () => {
    const b = await booked(ALICE, ['13C']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured', { providerPaymentId: 'pay_r3' });
    await pay.cancelBooking(b.id, A(ALICE));
    await q(`UPDATE refunds SET provider_refund_id='rfnd_r3', provider_status='created'
              WHERE booking_id=$1`, [b.id]);
    const { rows: [r] } = await q('SELECT * FROM refunds WHERE booking_id=$1', [b.id]);
    await deliverRefund(r.id, r.provider_refund_id, 'failed');
    const { rows: [done] } = await q('SELECT status FROM refunds WHERE id=$1', [r.id]);
    assert.equal(done.status, 'REFUND_FAILED');
  });

  test('dispatching twice does not create a second provider refund', async () => {
    const b = await booked(ALICE, ['13D']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured', { providerPaymentId: 'pay_r4' });
    await pay.cancelBooking(b.id, A(ALICE));
    await pay.dispatchPendingRefunds(rp);
    const n1 = rp.refunds.size;
    await pay.dispatchPendingRefunds(rp);
    assert.equal(rp.refunds.size, n1, 'an already-dispatched refund is not re-sent');
  });

  test('a refund with no captured provider payment is flagged for manual settlement', async () => {
    /* a complimentary booking can never reach here, but a manual-external one
     * has money that never went through the provider */
    const b = await pay.createManualBooking({ tripId: TRIP, type: 'PAID_EXTERNALLY',
      contactPhone: '9876543210', reason: 'Paid in cash at the office', actorId: SUPER,
      passengers: [{ seatNumber: '14A', name: 'Cash Payer', studentId: 'WU209999' }] });
    await q(`UPDATE payments SET provider='MANUAL_EXTERNAL', provider_payment_id=NULL
              WHERE booking_id=$1`, [b.id]);
    await pay.cancelBooking(b.id, A(SUPER, 'SUPER_ADMIN'));
    await pay.dispatchPendingRefunds(rp);
    const { rows: [r] } = await q('SELECT provider_status, status FROM refunds WHERE booking_id=$1', [b.id]);
    assert.equal(r.provider_status, 'no captured provider payment — needs manual settlement');
    assert.equal(r.status, 'REFUND_PENDING');
  });
});

/* ================================================================= manual */

describe('§40 manual bookings', () => {
  test('a paid-externally booking records the fare against a manual provider', async () => {
    const b = await pay.createManualBooking({ tripId: TRIP, type: 'PAID_EXTERNALLY',
      contactPhone: '9876543210', reason: 'Paid in cash at the university office', actorId: SUPER,
      passengers: [{ seatNumber: '6D', name: 'Cash Payer', studentId: 'WU208888' }] });
    assert.equal(b.totalAmount, FARE);
    assert.equal(b.payment.provider, 'MANUAL_EXTERNAL');
    assert.equal(b.payment.status, 'SUCCESS');
    assert.equal(b.status, 'CONFIRMED');
    assert.equal(b.passengers[0].passStatus, 'VALID');
  });

  test('a manual booking needs a reason and an available seat', async () => {
    await assert.rejects(pay.createManualBooking({ tripId: TRIP, type: 'COMPLIMENTARY',
      contactPhone: '9876543210', reason: '', actorId: SUPER,
      passengers: [{ seatNumber: '7A', name: 'X Y Z', studentId: 'WU0001' }] }), /reason/);
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '7B', ALICE]);
    await assert.rejects(pay.createManualBooking({ tripId: TRIP, type: 'COMPLIMENTARY',
      contactPhone: '9876543210', reason: 'Taking a held seat', actorId: SUPER,
      passengers: [{ seatNumber: '7B', name: 'X Y Z', studentId: 'WU0001' }] }), /not available/);
  });
});

/* ================================================================= waitlist */

describe('F-02 · paying for a claimed waitlist seat [provider-simulated]', () => {
  test('a claimed offer books through the normal flow and converts the entry', async () => {
    await q(`UPDATE trip_seats SET status='BLOCKED', block_reason='fill' WHERE trip_id=$1`, [TRIP]);
    const e = (await q(`INSERT INTO waitlist_entries (trip_id,user_id,position)
      VALUES ($1,$2,1) RETURNING id`, [TRIP, BOB])).rows[0].id;
    await q(`UPDATE trip_seats SET status='AVAILABLE', block_reason=NULL
              WHERE trip_id=$1 AND seat_number='8A'`, [TRIP]);
    await q('SELECT offer_seat_to_waitlist($1)', [TRIP]);
    await q('SELECT claim_waitlist_offer($1,$2)', [e, BOB]);

    const b = await pay.createBooking({ tripId: TRIP, holder: { userId: BOB },
      contactPhone: '9876543210', idempotencyKey: 'wl-1',
      passengers: [{ seatNumber: '8A', name: 'Bob B', studentId: 'WU0002' }] });
    const co = await pay.createCheckout(b.id, A(BOB), rp) as any;
    await deliver(co.paymentId, 'captured');

    assert.equal((await pay.bookingViewById(b.id)).status, 'CONFIRMED');
    const { rows: [w] } = await q('SELECT status FROM waitlist_entries WHERE id=$1', [e]);
    assert.equal(w.status, 'CONVERTED');
  });
});

/* ============================================ M-2 / M-3 · receipt projection
 *
 * The Dashboard's receipt and its row statuses are composed from the booking
 * response. "Refunded" and "refund pending" are different things to a student,
 * and a returned total cannot tell them apart — so the ROWS are projected, not
 * just booking_money's aggregates. The aggregates stay authoritative for money.
 */

describe('M-2/M-3 · paidAt and refund rows on the booking projection', () => {
  test('a settled payment carries paidAt; the money totals are unchanged', async () => {
    const b = await booked(ALICE, ['2A']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured');

    const v = await pay.bookingViewById(b.id);
    assert.equal(v.payment.status, 'SUCCESS');
    assert.ok(v.payment.paidAt, 'a settled payment records when it settled');
    assert.ok(new Date(v.payment.paidAt).getTime() > 0);
    assert.equal(v.received, FARE);
    assert.equal(v.returned, 0);
    assert.equal(v.refundable, FARE);
    assert.deepEqual(v.refunds, [], 'nothing refunded yet');
  });

  test('an unpaid booking has no paidAt — never a misleading timestamp', async () => {
    const b = await booked(ALICE, ['2B']);
    const v0 = await pay.bookingViewById(b.id);
    assert.equal(v0.payment, null, 'no intent has been created yet');

    await pay.createCheckout(b.id, A(ALICE), rp);
    const v1 = await pay.bookingViewById(b.id);
    assert.notEqual(v1.payment.status, 'SUCCESS');
    assert.equal(v1.payment.paidAt, null, 'an unsettled intent has not been paid');
  });

  test('a failed payment has no paidAt', async () => {
    const b = await booked(ALICE, ['2C']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'failed');
    const v = await pay.bookingViewById(b.id);
    assert.equal(v.payment.status, 'FAILED');
    assert.equal(v.payment.paidAt, null);
  });

  test('a pending refund is distinguishable from a settled one', async () => {
    const b = await booked(ALICE, ['2D']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured', { providerPaymentId: 'pay_m3a' });
    await pay.cancelBooking(b.id, A(ALICE));

    const pendingView = await pay.bookingViewById(b.id);
    assert.equal(pendingView.refunds.length, 1);
    assert.equal(pendingView.refunds[0].status, 'REFUND_PENDING');
    assert.equal(pendingView.refunds[0].amount, FARE);
    assert.ok(pendingView.refunds[0].createdAt, 'each row carries when it was raised');
    assert.equal(pendingView.returned, 0,
      'a pending obligation is not presented as money already returned');

    /* the total alone cannot tell these two states apart — the row can */
    await q(`UPDATE refunds SET provider_refund_id='rfnd_m3a', provider_status='created'
              WHERE booking_id=$1`, [b.id]);
    const { rows: [r] } = await q('SELECT * FROM refunds WHERE booking_id=$1', [b.id]);
    await deliverRefund(r.id, r.provider_refund_id, 'processed');

    const settledView = await pay.bookingViewById(b.id);
    assert.equal(settledView.refunds[0].status, 'REFUNDED');
    assert.equal(settledView.returned, FARE, 'the total is the same in both states');
  });

  test('multiple refund rows are all projected, in order', async () => {
    /* A duplicate payment produces a second receipt and its own refund, so one
     * booking legitimately carries more than one refund row. */
    const b = await booked(ALICE, ['3A']);
    const one = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(one.paymentId, 'captured');

    const { rows: [p2] } = await q(
      `INSERT INTO payments (booking_id, amount, status, provider, provider_order_id)
       VALUES ($1,$2,'PENDING','RAZORPAY',$3) RETURNING *`, [b.id, FARE, 'order_m3dup']);
    rp.orders.set('order_m3dup', { id: 'order_m3dup', amount: FARE * 100, status: 'paid', receipt: p2.id });
    await deliver(p2.id, 'captured', { eventId: 'evt_m3dup' });

    /* now cancel, which raises a second refund against the remaining balance */
    await pay.cancelBooking(b.id, A(ALICE));

    const v = await pay.bookingViewById(b.id);
    assert.ok(v.refunds.length >= 2, `expected more than one refund row, got ${v.refunds.length}`);
    const times = v.refunds.map((x: any) => new Date(x.createdAt).getTime());
    assert.deepEqual(times, [...times].sort((x, y) => x - y), 'rows are oldest first');
    const summed = v.refunds
      .filter((x: any) => x.status === 'REFUNDED')
      .reduce((a: number, x: any) => a + x.amount, 0);
    assert.equal(summed, v.returned, 'the rows and the total agree');
  });

  test('refund rows never let the totals exceed money in (F-05 unchanged)', async () => {
    const b = await booked(ALICE, ['3B']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured');
    await pay.cancelBooking(b.id, A(SUPER, 'SUPER_ADMIN'));

    const v = await pay.bookingViewById(b.id);
    assert.ok(v.returned <= v.received, 'money out never exceeds money in');
    assert.equal(v.refundable, 0);
    await assert.rejects(pay.overrideRefund({ bookingId: b.id, amount: 1,
      reason: 'a second bite', actorId: SUPER }), /Nothing is left to refund/);
  });

  test('the trip projection carries server-derived reportingAt and the cancellation reason', async () => {
    const b = await booked(ALICE, ['3C']);
    const v = await pay.bookingViewById(b.id);
    assert.ok(v.trip.reportingAt, 'reportingAt is derived server-side, as on TripView');
    assert.ok(new Date(v.trip.reportingAt) < new Date(v.trip.departureAt));
    assert.equal(v.trip.cancelledReason, null, 'a live trip has no cancellation reason');
    assert.ok(!('pickupPoint' in v.trip),
      'no pickup point is invented — no column holds one');

    await fixtureSql(`UPDATE trips SET status='CANCELLED', cancel_reason='Vehicle breakdown' WHERE id=$1`, [TRIP]);
    const after = await pay.bookingViewById(b.id);
    assert.equal(after.trip.cancelledReason, 'Vehicle breakdown',
      'the reason comes from trips.cancel_reason, the authoritative column');
  });

  test('boardedAt comes from the boarding event that actually boarded them', async () => {
    const b = await booked(ALICE, ['3D']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured');

    const before = await pay.bookingViewById(b.id);
    assert.equal(before.passengers[0].boardedAt, null, 'nobody has boarded yet');

    const { rows: [pax] } = await q(
      'SELECT id FROM booking_passengers WHERE booking_id=$1', [b.id]);
    await q(`UPDATE trips SET status='BOOKING_CLOSED' WHERE id=$1`, [TRIP]);
    await q(`UPDATE trips SET status='BOARDING' WHERE id=$1`, [TRIP]);
    await q(`UPDATE booking_passengers SET boarding_status='BOARDED' WHERE id=$1`, [pax.id]);
    await q(`SELECT log_boarding($1,$2,$3,'VALID','SCAN',NULL,NULL)`, [TRIP, pax.id, SUPER]);

    const after = await pay.bookingViewById(b.id);
    assert.ok(after.passengers[0].boardedAt, 'the time comes from boarding_events');
  });
});

/* ================================================================= §12 cap */

describe('§12 · the booking cap is five, at every layer that enforces it', () => {
  test('five passengers book through createBooking; six are refused', async () => {
    /* The cap has THREE homes: the basket check while holding (seats.ts), this
     * validation on the booking payload, and create_booking_from_holds. The
     * first and third moved to five with migration 012; validatePassengers was
     * still refusing a fifth, so a student could hold five seats and then be
     * told they could not book them. The HTTP schema capped it at four too. */
    const b = await booked(ALICE, ['9A', '9B', '9C', '9D', '10A']);
    assert.equal(b.passengers.length, 5, 'five is the documented maximum');
    assert.equal(b.totalAmount, FARE * 5);

    await assert.rejects(pay.createBooking({
      tripId: TRIP, holder: { userId: BOB }, contactPhone: '9876543210',
      idempotencyKey: 'k-six',
      passengers: ['11A', '11B', '11C', '11D', '12A', '12B'].map((s, i) => ({
        seatNumber: s, name: `Passenger ${i + 1}`, studentId: `WU30000${i}` })),
    }), /Up to 5 passengers in one booking/);
  });
});

/* ========================================== partial settlement · 019 / 020 */

describe('partial settlement · claim what is still ours, refund only what is gone', () => {

  /** Put a seat beyond this booking's reach the way a competing booking does:
   *  still HELD, but owned by somebody else. This is 018's orphan shape — the
   *  one case where a booking is live yet no longer owns one of its seats. */
  async function stolenBy(seat: string, otherBookingId: string, thief: string) {
    await q(
      `UPDATE trip_seats SET hold_by = $2::uuid, booking_id = $3,
              hold_expires_at = now() + interval '10 minutes', updated_at = now()
        WHERE trip_id = $1 AND seat_number = $4`,
      [TRIP, thief, otherBookingId, seat]);
  }

  test('every seat still available · the whole booking confirms, nothing refunded', async () => {
    const b = await booked(ALICE, ['6A', '6B', '6C']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;

    await deliver(co.paymentId, 'captured');

    const v = await pay.bookingViewById(b.id);
    assert.equal(v.status, 'CONFIRMED');
    for (const n of ['6A', '6B', '6C']) {
      const s = await seatOf(n);
      assert.equal(s.status, 'BOOKED', `${n} must be permanently booked`);
      assert.equal(s.booking_id, b.id);
      assert.equal(s.hold_expires_at, null, 'a booked seat carries no hold');
    }
    const m = await money(b.id);
    assert.equal(m.received, FARE * 3);
    assert.equal(m.returned, 0, 'nothing is refunded when nothing was lost');
    /* every passenger keeps a scannable pass */
    const { rows: passes } = await q(
      `SELECT bp.status FROM booking_passengers p
         JOIN boarding_passes bp ON bp.passenger_id = p.id WHERE p.booking_id=$1`, [b.id]);
    assert.equal(passes.length, 3);
    assert.ok(passes.every((r: any) => r.status === 'VALID'));
  });

  test('one lost seat refunds ONE seat, and the booking stands on the rest', async () => {
    const bob = await booked(BOB, ['6D']);
    const b = await booked(ALICE, ['6A', '6B']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await stolenBy('6B', bob.id, BOB);

    await deliver(co.paymentId, 'captured');

    assert.equal((await pay.bookingViewById(b.id)).status, 'CONFIRMED',
      'the seat they did get still stands');
    assert.equal((await seatOf('6A')).status, 'BOOKED');
    const m = await money(b.id);
    assert.equal(m.received, FARE * 2);
    assert.equal(m.returned, 0, 'the pending obligation is not money returned yet');
    assert.equal(m.refundable, FARE, 'exactly one seat is obligated, not the whole booking');
  });

  test('F-01 · the lost seat is never taken from whoever holds it', async () => {
    const bob = await booked(BOB, ['6D']);
    const b = await booked(ALICE, ['6A', '6B']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await stolenBy('6B', bob.id, BOB);
    await deliver(co.paymentId, 'captured');
    assert.equal((await seatOf('6B')).booking_id, bob.id,
      'two students must never end up on one seat');
  });

  test('when every requested seat is gone the whole payment goes back', async () => {
    const bob = await booked(BOB, ['6D']);
    const b = await booked(ALICE, ['6A']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await stolenBy('6A', bob.id, BOB);
    await deliver(co.paymentId, 'captured');
    assert.notEqual((await pay.bookingViewById(b.id)).status, 'CONFIRMED');
    const m = await money(b.id);
    assert.equal(m.returned, 0, 'pending full refund is not presented as returned');
    assert.equal(m.refundable, 0);
  });

  test('a BLOCKED seat is lost, never claimed', async () => {
    const b = await booked(ALICE, ['6A', '6B']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await q(`UPDATE trip_seats SET status='BLOCKED', booking_id=NULL, hold_by=NULL,
                    hold_guest_token=NULL, hold_expires_at=NULL, block_reason='maintenance'
              WHERE trip_id=$1 AND seat_number='6B'`, [TRIP]);
    await deliver(co.paymentId, 'captured');
    assert.equal((await seatOf('6B')).status, 'BLOCKED');
    const m = await money(b.id);
    assert.equal(m.returned, 0);
    assert.equal(m.refundable, FARE);
  });

  test('DECIDED · an abandoned booking is NOT resurrected, even with its seat free', async () => {
    const b = await booked(ALICE, ['6C']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await q(`UPDATE bookings SET hold_expires_at = now() - interval '1 min' WHERE id=$1`, [b.id]);
    await q(`UPDATE trip_seats SET hold_expires_at = now() - interval '1 min' WHERE booking_id=$1`, [b.id]);
    await q('SELECT sweep_expired_holds()');
    assert.equal((await pay.bookingViewById(b.id)).status, 'ABANDONED');
    assert.equal((await seatOf('6C')).status, 'AVAILABLE', 'the seat is genuinely free');

    await deliver(co.paymentId, 'captured');

    /* Deliberate. Reclaiming it would let a Razorpay checkout left open in an
     * old tab confirm a second booking the student never wanted, charged twice.
     * The remedy for a hold lapsing mid-payment is the bounded extension in
     * createCheckout, not raising the booking from the dead. */
    assert.notEqual((await pay.bookingViewById(b.id)).status, 'CONFIRMED');
    const m = await money(b.id);
    assert.equal(m.returned, 0, 'pending full refund is not presented as returned');
    assert.equal(m.refundable, 0);
  });

  test('a refunded passenger is off the manifest and cannot board', async () => {
    const bob = await booked(BOB, ['6D']);
    const b = await booked(ALICE, ['6A', '6B']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await stolenBy('6B', bob.id, BOB);
    await deliver(co.paymentId, 'captured');

    const { rows: manifest } = await q(`SELECT * FROM trip_manifest($1,'OPS_ADMIN')`, [TRIP]);
    const listed = manifest.map((r: any) => r.seat_number);
    assert.ok(listed.includes('6A'), 'the seat they kept is on the list');
    assert.ok(!listed.includes('6B'),
      'a refunded seat must not be expected at the door');

    const { rows: [pass] } = await q(
      `SELECT bp.status FROM booking_passengers p
         LEFT JOIN boarding_passes bp ON bp.passenger_id = p.id
        WHERE p.booking_id=$1 AND p.seat_number='6B'`, [b.id]);
    assert.notEqual(pass?.status, 'VALID', 'no scannable pass for a refunded seat');
  });

  /* ------------------------------------------------ the bounded hold window */

  test('checkout renews the hold, but never past the ceiling', async () => {
    const b = await booked(ALICE, ['7A']);
    /* nearly lapsed — a student who lingered over the passenger form */
    await q(`UPDATE bookings SET hold_expires_at = now() + interval '20 seconds' WHERE id=$1`, [b.id]);
    await q(`UPDATE trip_seats SET hold_expires_at = now() + interval '20 seconds' WHERE booking_id=$1`, [b.id]);

    await pay.createCheckout(b.id, A(ALICE), rp);
    const { rows: [one] } = await q('SELECT hold_expires_at FROM bookings WHERE id=$1', [b.id]);
    const gained = new Date(one.hold_expires_at).getTime() - Date.now();
    assert.ok(gained > 8 * 60_000,
      `checkout must buy a real window for a UPI approval; got ${Math.round(gained / 1000)}s`);
    assert.equal(new Date((await seatOf('7A')).hold_expires_at).getTime(),
      new Date(one.hold_expires_at).getTime(),
      'booking and seat clocks must not drift (D-4)');

    /* THE ABUSE THE CEILING EXISTS FOR: reopening checkout must not renew a
     * hold forever, or one student could squat a seat indefinitely. */
    for (let i = 0; i < 8; i++) await pay.createCheckout(b.id, A(ALICE), rp);
    const { rows: [many] } = await q(
      'SELECT hold_expires_at, created_at FROM bookings WHERE id=$1', [b.id]);
    const ceiling = new Date(many.created_at).getTime()
      + pay.CHECKOUT_HOLD_CEILING_MIN * 60_000;
    assert.ok(new Date(many.hold_expires_at).getTime() <= ceiling + 1000,
      'repeated /payments/create must not hold a seat past the ceiling');
  });

  /* ------------------------------------------------ release, mapped not 500 */

  test('removing a seat a live pending booking owns is a CONFLICT, not a 500', async () => {
    await booked(ALICE, ['7B']);
    await assert.rejects(
      () => seats.releaseSeat(TRIP, '7B', { userId: ALICE }),
      (e: any) => {
        assert.equal(e.code, 'CONFLICT', `expected a mapped CONFLICT, got ${e.code}`);
        assert.match(e.message, /pending booking/);
        return true;
      });
    assert.equal((await seatOf('7B')).status, 'HELD', 'the seat is left alone');
  });

  test('releasing a plain hold clears booking_id rather than violating the constraint', async () => {
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '7C', ALICE]);
    assert.equal(await seats.releaseSeat(TRIP, '7C', { userId: ALICE }), true);
    const s = await seatOf('7C');
    assert.equal(s.status, 'AVAILABLE');
    assert.equal(s.booking_id, null, 'the coherence constraint rejects AVAILABLE + booking_id');
  });

  /* ------------------------------------------------ concurrency */

  test('two bookings settling the SAME seat at once — exactly one gets it', async () => {
    /* Both bookings end up naming seat 6A, the 018 orphan shape. Then both are
     * paid and settled from separate connections at the same instant. */
    const a = await booked(ALICE, ['6A']);
    const b = await booked(BOB, ['6B']);
    const seat6A = (await seatOf('6A')).id;
    await q(`UPDATE booking_passengers SET trip_seat_id=$2 WHERE booking_id=$1`, [b.id, seat6A]);

    const pay1 = (await q(
      `INSERT INTO payments (booking_id,amount,status,provider,provider_order_id,provider_payment_id)
       VALUES ($1,$2,'SUCCESS','RAZORPAY','order_cc1','pay_cc1') RETURNING *`,
      [a.id, a.totalAmount])).rows[0];
    const pay2 = (await q(
      `INSERT INTO payments (booking_id,amount,status,provider,provider_order_id,provider_payment_id)
       VALUES ($1,$2,'SUCCESS','RAZORPAY','order_cc2','pay_cc2') RETURNING *`,
      [b.id, b.totalAmount])).rows[0];

    const c1 = await pool.connect(), c2 = await pool.connect();
    try {
      const [r1, r2] = await Promise.all([
        c1.query('SELECT * FROM settle_booking_v2($1,$2)', [a.id, pay1.id]),
        c2.query('SELECT * FROM settle_booking_v2($1,$2)', [b.id, pay2.id]),
      ]);
      const outcomes = [r1.rows[0].outcome, r2.rows[0].outcome].sort();

      /* One confirms on 6A. The other cannot have it — it has no other seat, so
       * it must come back REFUND_REQUIRED. Never two winners. */
      assert.deepEqual(outcomes, ['CONFIRMED', 'REFUND_REQUIRED'],
        `exactly one settlement may take the seat, got ${outcomes.join(' + ')}`);
    } finally { c1.release(); c2.release(); }

    const { rows: booked6A } = await q(
      `SELECT booking_id FROM trip_seats WHERE trip_id=$1 AND seat_number='6A' AND status='BOOKED'`,
      [TRIP]);
    assert.equal(booked6A.length, 1, 'one seat, one allocation');
  });

  /* ------------------------------------------------ 020 event retry */

  test('020 · a deadlock is RETRIED, not swallowed with the payment', async () => {
    /* THE DEFECT 020 EXISTS FOR: any failure marked the event processed_at, so
     * a transient deadlock permanently discarded a captured payment.
     *
     * settle_booking_v2 is swapped for one that raises a real 40P01 through the
     * real code path, then restored from its own captured definition — so this
     * exercises the retry branch rather than asserting it by inspection. */
    const b = await booked(ALICE, ['6A']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;

    const { rows: [orig] } = await q(
      `SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname='settle_booking_v2'`);
    /* parameter NAMES must match: CREATE OR REPLACE cannot rename them. */
    await q(`CREATE OR REPLACE FUNCTION settle_booking_v2(p_booking_id uuid, p_payment_id uuid)
             RETURNS TABLE (outcome text, seats_claimed int, seats_lost int, refund_amount int)
             AS $fake$ BEGIN
               RAISE EXCEPTION 'simulated deadlock' USING ERRCODE = '40P01';
             END $fake$ LANGUAGE plpgsql`);
    try {
      await deliver(co.paymentId, 'captured');

      const { rows: [e] } = await q(
        `SELECT processed_at, attempts, next_attempt_at, process_error
           FROM provider_events WHERE payment_id=$1 AND kind_normalized='PAYMENT_SUCCEEDED'`,
        [co.paymentId]);
      assert.equal(e.processed_at, null,
        'a deadlock must NOT mark the event done — that is how a payment was lost');
      assert.equal(e.attempts, 1, 'the attempt is counted');
      assert.ok(e.next_attempt_at, 'and it is scheduled to come back');
      assert.match(e.process_error, /retrying after/);

      /* The booking must not have been confirmed or refunded by the failure. */
      assert.equal((await pay.bookingViewById(b.id)).status, 'PAYMENT_PENDING');
      assert.equal((await money(b.id)).returned, 0, 'no refund is raised on a transient failure');
    } finally {
      await q(orig.d);                       // restore the real settle_booking_v2
    }

    /* Once the fault clears and the backoff elapses, the SAME event settles. */
    await q(`UPDATE provider_events SET next_attempt_at = now() - interval '1 second'
              WHERE payment_id=$1 AND kind_normalized='PAYMENT_SUCCEEDED'`, [co.paymentId]);
    await pay.processPendingEvents(rp);

    assert.equal((await pay.bookingViewById(b.id)).status, 'CONFIRMED',
      'the retry recovers the payment the old code discarded');
    assert.equal((await seatOf('6A')).status, 'BOOKED');
  });

  /* ------------------------------------------------ deploy safety
   *
   * Migration 019 keeps the old scalar settle_booking and adds settle_booking_v2
   * beside it. That makes migration-first safe for the currently deployed app,
   * while this app gets the richer v2 row only after assertReady sees migration
   * 021. */

  async function withSettleBookingV2(body: string, run: () => Promise<void>) {
    const { rows: [cur] } = await q(
      `SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname='settle_booking_v2'`);
    await q('DROP FUNCTION settle_booking_v2(uuid,uuid)');
    await q(body);
    try { await run(); }
    finally {
      await q('DROP FUNCTION settle_booking_v2(uuid,uuid)');
      await q(cur.d);                       // restore the real one, exactly
    }
  }

  test('deploy-safe · old scalar settle_booking remains beside the v2 row function', async () => {
    const { rows: [oldFn] } = await q(
      `SELECT pg_get_function_result('settle_booking(uuid,uuid)'::regprocedure) AS result`);
    const { rows: [newFn] } = await q(
      `SELECT pg_get_function_result('settle_booking_v2(uuid,uuid)'::regprocedure) AS result`);
    assert.equal(oldFn.result, 'settlement_outcome',
      'old deployed code still has the scalar function it calls');
    assert.match(newFn.result, /^TABLE\(outcome text, seats_claimed integer, seats_lost integer, refund_amount integer\)$/);

    const b = await booked(ALICE, ['6A']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await q(`UPDATE bookings SET status='ABANDONED' WHERE id=$1`, [b.id]);
    const { rows: [legacy] } = await q(
      `SELECT settle_booking($1,$2) AS outcome`, [b.id, co.paymentId]);
    assert.equal(legacy.outcome, 'REFUND_REQUIRED',
      'the legacy query shape still returns a scalar enum value');
  });

  test('deploy-safe · an unrecognised shape refuses and retries, never guesses', async () => {
    await withSettleBookingV2(
      `CREATE FUNCTION settle_booking_v2(p_booking_id uuid, p_payment_id uuid)
       RETURNS TABLE (nonsense text) AS $x$
       BEGIN RETURN QUERY SELECT 'WAT'::text; END $x$ LANGUAGE plpgsql`,
      async () => {
        const b = await booked(ALICE, ['6C']);
        const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
        await deliver(co.paymentId, 'captured');

        const { rows: [e] } = await q(
          `SELECT processed_at, attempts FROM provider_events
            WHERE payment_id=$1 AND kind_normalized='PAYMENT_SUCCEEDED'`, [co.paymentId]);
        assert.equal(e.processed_at, null,
          'an unknown shape must be retried, never consumed');
        assert.equal(e.attempts, 1);
        assert.equal((await money(b.id)).returned, 0, 'and no refund is invented');
        assert.notEqual((await pay.bookingViewById(b.id)).status, 'CONFIRMED');
      });
  });

  /* ------------------------------------------------ the path the UI now offers */

  test('cancelling an unpaid pending booking frees its seats, booking_id cleared', async () => {
    /* "Change seats" depends on this: release_all_held deliberately skips seats
     * a live pending booking owns, so the booking itself must be discarded. */
    const b = await booked(ALICE, ['7D']);
    const out: any = await pay.cancelBooking(b.id, A(ALICE), 'Changed seats before paying');
    assert.equal(out.refundAmount, 0, 'nothing was paid, so nothing is refunded');
    const s = await seatOf('7D');
    assert.equal(s.status, 'AVAILABLE');
    assert.equal(s.booking_id, null, 'the seat must be genuinely re-holdable');
    await q('SELECT hold_seat($1,$2,$3::uuid,NULL)', [TRIP, '7D', BOB]);
    assert.equal((await seatOf('7D')).hold_by, BOB, 'and another student can take it');
  });

  test('020 · an event scheduled for a later retry is left alone until then', async () => {
    await q(
      `INSERT INTO provider_events (provider, provider_event_id, kind, raw_body,
         signature_ok, kind_normalized, attempts, next_attempt_at)
       VALUES ('RAZORPAY','evt_deferred_test','payment.captured','{}'::jsonb,true,
         'PAYMENT_SUCCEEDED', 2, now() + interval '5 minutes')`);
    await pay.processPendingEvents(rp);
    const { rows: [e] } = await q(
      `SELECT processed_at FROM provider_events WHERE provider_event_id='evt_deferred_test'`);
    assert.equal(e.processed_at, null,
      'a deferred event must not be consumed before its retry time');
  });
});
