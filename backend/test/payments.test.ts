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
import type { Actor } from '../src/domain/authz.ts';
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
    VALUES ($1,$2, now() + interval '3 days', $3,'OPEN') RETURNING id`, [r, v, FARE])).rows[0].id;
  await q('SELECT materialise_trip_seats($1)', [TRIP]);
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
    assert.equal(m.returned, 100, 'the wrong amount goes straight back');
    assert.notEqual((await pay.bookingViewById(b.id)).status, 'CONFIRMED');
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
    assert.equal((await money(alices.id)).returned, FARE, 'her money goes back in full');

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
    await q('UPDATE trips SET price = 299 WHERE id=$1', [TRIP]);

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
    await q('UPDATE trips SET price = 299 WHERE id=$1', [TRIP]);
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
    await q('UPDATE trips SET price = 299 WHERE id=$1', [TRIP]);
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
    assert.equal(m.returned, FARE, 'exactly one fare goes back');
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

  test('cancelling outside 12 hours refunds in full and frees the seat', async () => {
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

  test('inside 12 hours the policy refunds nothing', async () => {
    const b = await confirmed(ALICE, '2C');
    await q(`UPDATE trips SET departure_at = now() + interval '3 hours' WHERE id=$1`, [TRIP]);
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
    await q(`UPDATE trips SET departure_at = now() + interval '3 hours' WHERE id=$1`, [TRIP]);
    await assert.rejects(pay.overrideRefund({ bookingId: b.id, amount: 0,
      reason: 'nothing at all', actorId: SUPER }), /zero-value/);
    await assert.rejects(pay.overrideRefund({ bookingId: b.id, amount: FARE + 500,
      reason: 'more than we took', actorId: SUPER }), /more than/);
    await assert.rejects(pay.overrideRefund({ bookingId: b.id, amount: 100,
      reason: '', actorId: SUPER }), /reason/);
  });

  test('F-12 · a real override refunds inside the cutoff and reports the true amount', async () => {
    const b = await confirmed(ALICE, '4D');
    await q(`UPDATE trips SET departure_at = now() + interval '3 hours' WHERE id=$1`, [TRIP]);
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
  test('THE GAP FROM LAST PHASE · a pending refund is actually sent to the provider', async () => {
    const b = await booked(ALICE, ['13A']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured', { providerPaymentId: 'pay_refundable' });
    await pay.cancelBooking(b.id, A(ALICE));

    const before = await q(`SELECT provider_refund_id FROM refunds WHERE booking_id=$1`, [b.id]);
    assert.equal(before.rows[0].provider_refund_id, null, 'not yet dispatched');

    const sent = await pay.dispatchPendingRefunds(rp);
    assert.equal(sent, 1);
    const after = await q(`SELECT provider_refund_id, status FROM refunds WHERE booking_id=$1`, [b.id]);
    assert.match(after.rows[0].provider_refund_id, /^rfnd_/);
    assert.equal(after.rows[0].status, 'REFUND_PENDING', 'still pending until the provider says otherwise');
  });

  test('refund.processed is what finally settles it', async () => {
    const b = await booked(ALICE, ['13B']);
    const co = await pay.createCheckout(b.id, A(ALICE), rp) as any;
    await deliver(co.paymentId, 'captured', { providerPaymentId: 'pay_r2' });
    await pay.cancelBooking(b.id, A(ALICE));
    await pay.dispatchPendingRefunds(rp);
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
    await pay.dispatchPendingRefunds(rp);
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
    assert.match(r.provider_status, /manual settlement/);
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
