/* DLT · domain/payments.ts — booking creation, payment, settlement, refunds.
 *
 * The rules are the rules the 222 browser assertions pinned down. What changes
 * is that the browser can no longer reach them, and that the indivisible parts
 * are SQL functions holding row locks rather than JavaScript reading and then
 * writing.
 *
 * The three defects this file exists to keep closed:
 *   F-01  a late settlement must never resurrect an abandoned booking
 *   F-03  a price change must be data the student can accept, never an exception
 *   F-05  money out can never exceed money in
 *
 * PROVIDER NEUTRALITY (Razorpay migration): this file names no acquirer. It
 * depends on the PaymentProvider interface, reads NORMALISED columns from
 * provider_events rather than any raw provider body, and works in whole rupees
 * throughout. Adding or swapping a provider touches an adapter, not this file.
 *
 * WRITTEN, NOT EXECUTED.
 */

import type { PoolClient } from 'pg';
import { query, tx } from '../db/index.ts';
import { AppError } from './errors.ts';
import { audit } from './audit.ts';
import type { PaymentProvider, NormalizedEvent } from './payment-provider.ts';
import type { Holder } from './seats.ts';
import { bookingFor, paymentFor, requireOperator, type AnyActor, type Actor } from './authz.ts';
import { createHash } from 'node:crypto';

export const CANCELLATION_CUTOFF_HOURS = 12;

/** Reads the actor's role from the database when a caller did not supply it.
 *  The role is NEVER taken from a request body. */
async function roleOf(userId: string): Promise<string> {
  const { rows: [u] } = await query('SELECT role FROM users WHERE id = $1', [userId]);
  if (!u) throw new AppError('UNAUTHENTICATED', 'Sign in required');
  return u.role;
}

/* ---------------------------------------------------------------- creation */

export interface PassengerInput { seatNumber: string; name: string; studentId: string; phone?: string }

/** §5: booking creation is idempotent on the client's Idempotency-Key. Two taps
 *  of Continue produce one booking, not two. */
export async function createBooking(input: {
  tripId: string; holder: Holder; contactPhone: string;
  passengers: PassengerInput[]; idempotencyKey: string;
}) {
  validatePassengers(input.passengers, input.contactPhone);

  return tx(async (c) => {
    const actor: AnyActor = input.holder.userId
      ? { userId: input.holder.userId, role: 'STUDENT' }
      : { guestToken: input.holder.guestToken! };
    const prior = await claimIdempotency(c, input.idempotencyKey, 'POST /bookings', input, actor);
    if (prior) return prior;

    try {
      const { rows: [b] } = await c.query(
        `SELECT * FROM create_booking_from_holds($1,$2::uuid,$3::text,$4,$5::jsonb)`,
        [input.tripId, input.holder.userId ?? null, input.holder.guestToken ?? null,
         input.contactPhone, JSON.stringify(input.passengers)]);
      await audit(c, { actorId: input.holder.userId ?? undefined }, 'booking.created',
        'booking', b.id, null, b.code, null);
      const view = await bookingView(c, b.id);
      await completeIdempotency(c, input.idempotencyKey, 'POST /bookings', view);
      return view;
    } catch (e: any) {
      if (e.code === '23505' && /hold on seat/.test(e.message ?? ''))
        throw new AppError('CONFLICT', e.message);
      if (e.code === '23514' || e.code === '23505') throw new AppError('CONFLICT', e.message);
      throw e;
    }
  });
}

function validatePassengers(pax: PassengerInput[], contactPhone: string) {
  if (!pax?.length) throw new AppError('VALIDATION', 'Add at least one passenger');
  if (pax.length > 4) throw new AppError('VALIDATION', 'Up to 4 passengers in one booking');
  if (!/^[6-9]\d{9}$/.test((contactPhone ?? '').replace(/\s/g, '')))
    throw new AppError('VALIDATION', 'Enter a valid Indian mobile number for the booking contact');
  for (const p of pax) {
    if (!p.name || p.name.trim().length < 3)
      throw new AppError('VALIDATION', `Enter a full name for seat ${p.seatNumber}`);
    if (!p.studentId || !/^[A-Za-z0-9]{4,20}$/.test(p.studentId))
      throw new AppError('VALIDATION', `Enter a valid student ID for seat ${p.seatNumber}`);
  }
}

/* ---------------------------------------------------------------- repricing
 *
 * F-03, the reproduced defect. The prototype recomputed the total, wrote it,
 * then THREW — and the throw rolled its own correction back, so the same error
 * recurred forever and the booking could never be paid. Here a price change is
 * a RETURN VALUE. Nothing is thrown, the new figure is persisted, and the
 * student is given something they can actually accept.
 */

export async function priceCheck(bookingId: string) {
  const { rows: [r] } = await query('SELECT * FROM check_booking_price($1)', [bookingId]);
  return { changed: r.changed, oldTotal: r.old_total, newTotal: r.new_total };
}

export async function acceptReprice(bookingId: string, actor: Actor) {
  const userId = actor.userId;
  return tx(async (c) => {
    await bookingFor(actor, bookingId, { forUpdate: true, client: c });
    const { rows: [b] } = await c.query('SELECT * FROM accept_reprice($1)', [bookingId]);
    await audit(c, { actorId: userId }, 'booking.reprice_accepted', 'booking', bookingId,
      null, `₹${b.total_amount}`, null);
    return bookingView(c, bookingId);
  });
}

/* ---------------------------------------------------------------- checkout */

export interface CheckoutSession {
  paymentId: string; providerOrderId: string;
  /** What the browser checkout needs to open. Provider-neutral name: for
   *  Razorpay this is the order id; another provider may return a session
   *  token. The client hands it straight to the checkout and interprets nothing. */
  checkoutHandle: string;
  amount: number;
}

/** Creates OUR payment row, then the provider order for it. The amount is read
 *  from the booking — never from the request. A client that posts an amount is
 *  ignored, because the browser is not the authority for what anything costs. */
export async function createCheckout(
  bookingId: string, actor: Actor, provider: PaymentProvider
): Promise<CheckoutSession | { repriced: true; oldTotal: number; newTotal: number }> {

  /* F-03: revalidate the fare first, and RETURN the change rather than throwing. */
  /* Authorize BEFORE anything else, including the price read. */
  await bookingFor(actor, bookingId, { permission: 'payment.read' });
  const price = await priceCheck(bookingId);
  if (price.changed) return { repriced: true, oldTotal: price.oldTotal, newTotal: price.newTotal };

  const { payment, booking } = await tx(async (c) => {
    const { rows: [b] } = await c.query(
      /* FOR UPDATE OF b: the row we actually lock is the booking. Postgres
       * refuses a bare FOR UPDATE here because u is the nullable side of the
       * LEFT JOIN (a guest booking has no user row). The join is read-only. */
      `SELECT b.*, u.name, u.phone, u.email FROM bookings b
         LEFT JOIN users u ON u.id = b.user_id WHERE b.id = $1 FOR UPDATE OF b`, [bookingId]);
    if (!b) throw new AppError('NOT_FOUND', 'Booking not found');
    if (b.status === 'CONFIRMED') throw new AppError('CONFLICT', 'That booking is already paid');
    if (['ABANDONED', 'CANCELLED_BY_STUDENT', 'CANCELLED_BY_DLT'].includes(b.status))
      throw new AppError('CONFLICT', 'That booking is no longer active. Start again.');
    if (b.hold_expires_at && new Date(b.hold_expires_at) <= new Date())
      throw new AppError('CONFLICT', 'Your seats went back on sale. Choose again.');

    /* An existing live intent is reused, so a double tap does not create two
     * provider orders for one booking. */
    const { rows: [live] } = await c.query(
      `SELECT * FROM payments WHERE booking_id = $1 AND status IN ('CREATED','PENDING')
        ORDER BY created_at DESC LIMIT 1`, [bookingId]);
    if (live && live.amount === b.total_amount) return { payment: live, booking: b };

    const { rows: [p] } = await c.query(
      `INSERT INTO payments (booking_id, amount, status, provider)
       VALUES ($1,$2,'CREATED',$3) RETURNING *`, [bookingId, b.total_amount, provider.name]);
    return { payment: p, booking: b };
  });

  /* Outside the transaction: a network call must never hold a row lock. */
  const order = await provider.createOrder({
    reference: payment.id,
    amountRupees: payment.amount,
    customer: {
      id: booking.user_id ?? payment.id,
      name: booking.name ?? 'DLT student',
      phone: booking.contact_phone ?? booking.phone,
      email: booking.email ?? undefined,
    },
    note: `DLT ${booking.code}`,
  });

  await query(
    `UPDATE payments SET provider_order_id = $1, status = 'PENDING', updated_at = now()
      WHERE id = $2 AND status = 'CREATED'`, [order.providerOrderId, payment.id]);

  /* checkoutHandle is what the browser checkout needs. It is not a credential,
   * but it is scoped to this one order. */
  return { paymentId: payment.id, providerOrderId: order.providerOrderId,
    checkoutHandle: order.checkoutHandle, amount: payment.amount };
}

/* ---------------------------------------------------------------- webhook
 *
 * The handler's whole job is: verify, record, return 200 fast. Processing runs
 * from provider_events, so a replay is a duplicate-key no-op and a slow
 * database never makes the provider retry. Razorpay treats any non-2xx as a
 * delivery failure and retries with exponential backoff for 24 hours, so
 * responding fast and processing afterwards is not an optimisation — it is what
 * keeps a slow query from turning into a retry storm.
 */

export async function recordWebhook(event: NormalizedEvent, signatureOk: boolean): Promise<{ stored: boolean }> {
  try {
    /* Everything the domain will later act on is normalised HERE, once, by the
     * adapter that produced the event. `raw_body` is kept for audit and for
     * re-normalising if an adapter bug is found — business logic never reads it.
     *
     * Replay protection is the UNIQUE (provider, provider_event_id) index. For
     * Razorpay that id is the `x-razorpay-event-id` header, which their
     * documentation states is unique per event and is their own recommended
     * dedupe key. There is no timestamp in a Razorpay webhook signature, so
     * this index is the ONLY thing preventing a double apply — it carries more
     * weight here than it did under the previous provider. */
    await query(
      `INSERT INTO provider_events (
         provider, provider_event_id, kind, raw_body, signature_ok,
         kind_normalized, amount_rupees, subject_order_id, subject_payment_id,
         subject_refund_id, failure_reason, provider_status,
         payment_id, refund_id)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,
         (SELECT id FROM payments WHERE provider_order_id = $8
             OR (provider_payment_id IS NOT NULL AND provider_payment_id = $9)),
         (SELECT id FROM refunds WHERE provider_refund_id = $10))`,
      [event.provider, event.providerEventId, event.providerStatus ?? event.kind,
       JSON.stringify(event.raw), signatureOk,
       event.kind, event.amountRupees, event.orderId, event.paymentId,
       event.refundId, event.failureReason, event.providerStatus]);
    return { stored: true };
  } catch (e: any) {
    /* §5 replay protection. A second delivery of the same event collides here,
     * and that is SUCCESS — the event is already recorded. Returning an error
     * would make the provider retry: Razorpay treats any non-2xx as a delivery
     * failure and retries with exponential backoff for 24 hours. */
    if (e.code === '23505') return { stored: false };
    throw e;
  }
}

/** Processes unapplied provider events. Safe to run concurrently: each event is
 *  taken with FOR UPDATE SKIP LOCKED, so two workers never process one twice. */
export async function processPendingEvents(provider: PaymentProvider, limit = 50): Promise<number> {
  let done = 0;
  for (;;) {
    const handled = await tx(async (c) => {
      const { rows: [ev] } = await c.query(
        `SELECT * FROM provider_events
          WHERE processed_at IS NULL AND signature_ok = true
          ORDER BY received_at
          FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (!ev) return false;
      try {
        await applyEvent(c, ev, provider);
        await c.query('UPDATE provider_events SET processed_at = now() WHERE id = $1', [ev.id]);
      } catch (e: any) {
        /* A failure is recorded on the event, not swallowed and not retried
         * forever in a loop. Operations sees it in the reconciliation report. */
        await c.query('UPDATE provider_events SET processed_at = now(), process_error = $2 WHERE id = $1',
          [ev.id, String(e?.message ?? e).slice(0, 500)]);
      }
      return true;
    });
    if (!handled || ++done >= limit) break;
  }
  return done;
}

/* Applies ONE recorded event. Reads only NORMALISED columns — no provider
 * payload shape appears here, which is exactly what the Cashfree version leaked
 * when it read `raw_body.data.payment.payment_status` inside business logic. */
async function applyEvent(c: PoolClient, ev: any, provider: PaymentProvider) {
  /* Refund outcomes first: they name a refund, not a payment. Razorpay's
   * documentation calls `refund.processed` the definitive final status, so this
   * is what finally moves a refund off REFUND_PENDING — the gap left open at
   * the end of the previous phase. */
  if (ev.kind_normalized === 'REFUND_PROCESSED' || ev.kind_normalized === 'REFUND_FAILED') {
    if (!ev.refund_id) return;
    const settled = ev.kind_normalized === 'REFUND_PROCESSED';
    await c.query(
      `UPDATE refunds SET status = $2, provider_status = $3, updated_at = now()
        WHERE id = $1 AND status = 'REFUND_PENDING'`,
      [ev.refund_id, settled ? 'REFUNDED' : 'REFUND_FAILED', ev.provider_status]);
    await audit(c, {}, settled ? 'refund.processed' : 'refund.failed',
      'refund', ev.refund_id, 'REFUND_PENDING', ev.provider_status, null);
    return;
  }

  if (!ev.payment_id) return;                       // an event for something we do not have
  const { rows: [p] } = await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [ev.payment_id]);
  if (!p) return;

  /* Record the provider's payment id the first time we learn it: a refund is
   * created against that, not against the order. */
  if (ev.subject_payment_id && !p.provider_payment_id) {
    await c.query('UPDATE payments SET provider_payment_id = $2, updated_at = now() WHERE id = $1',
      [p.id, ev.subject_payment_id]);
  }

  /* IGNORED covers states that are real but not actionable — notably
   * `payment.authorized`, which may arrive AFTER `payment.captured` because
   * Razorpay does not guarantee webhook ordering. Treating an authorisation as
   * money received would confirm a booking before the funds are ours. */
  if (ev.kind_normalized === 'IGNORED') return;

  const paidAmount = Number(ev.amount_rupees ?? 0);
  const reference = ev.subject_payment_id ?? null;

  if (ev.kind_normalized === 'PAYMENT_FAILED') {
    if (p.status === 'SUCCESS') return;             // never downgrade a settled payment
    await c.query(
      `UPDATE payments SET status='FAILED', failure_reason=$2, provider_reference=$3, updated_at=now()
        WHERE id=$1`, [p.id, ev.failure_reason ?? ev.provider_status, reference]);
    return;
  }
  if (ev.kind_normalized !== 'PAYMENT_SUCCEEDED') return;

  /* Amount mismatch is a discrepancy for operations, never a silent accept. */
  if (paidAmount && Math.round(paidAmount) !== p.amount) {
    await c.query(
      `UPDATE payments SET status='SUCCESS', provider_reference=$2,
              failure_reason=$3, updated_at=now() WHERE id=$1`,
      [p.id, reference, `amount mismatch: expected ₹${p.amount}, received ₹${Math.round(paidAmount)}`]);
    await raiseRefund(c, p.booking_id, p.id, Math.round(paidAmount),
      'Amount received does not match the fare — returned in full', null, false);
    await audit(c, {}, 'payment.amount_mismatch', 'payment', p.id,
      `₹${p.amount}`, `₹${Math.round(paidAmount)}`, null);
    return;
  }

  /* A second successful payment on one booking is a DUPLICATE, refunded, not
   * kept. payments_one_success_per_booking makes the first one authoritative. */
  const { rows: [already] } = await c.query(
    `SELECT id FROM payments WHERE booking_id=$1 AND status='SUCCESS' AND id <> $2`,
    [p.booking_id, p.id]);
  if (already) {
    await c.query(
      `UPDATE payments SET status='DUPLICATE', provider_reference=$2, updated_at=now() WHERE id=$1`,
      [p.id, reference]);
    await raiseRefund(c, p.booking_id, p.id, p.amount, 'Duplicate payment returned in full', null, false);
    return;
  }

  await c.query(
    `UPDATE payments SET status='SUCCESS', provider_reference=$2, updated_at=now() WHERE id=$1`,
    [p.id, reference]);

  /* F-01, THE DEFECT. settle_booking refuses to confirm an abandoned booking
   * and refuses any seat that is no longer ours. When it says REFUND_REQUIRED
   * the money is real and goes back — what must not happen, and now cannot, is
   * a second student appearing on somebody else's seat. */
  const { rows: [s] } = await c.query('SELECT settle_booking($1,$2) AS outcome', [p.booking_id, p.id]);

  if (s.outcome === 'REFUND_REQUIRED') {
    await raiseRefund(c, p.booking_id, p.id, p.amount,
      'Payment arrived after the seats were released — returned in full', null, false);
    await c.query(
      `INSERT INTO notification_requests (kind, user_id, reason, status)
       SELECT 'GET_NOTIFIED', user_id,
              'Late settlement on ' || code || ' — refund raised, seat not reissued', 'PENDING'
         FROM bookings WHERE id = $1`, [p.booking_id]);
    await audit(c, {}, 'payment.late_settlement', 'booking', p.booking_id,
      null, `₹${p.amount} refunded`, null);
    return;
  }
  if (s.outcome === 'CONFIRMED')
    await audit(c, {}, 'booking.confirmed', 'booking', p.booking_id, null, `₹${p.amount}`, null);
}

/** Pull-based reconciliation for anything the webhook never delivered. */
/* C-2. THE DEFECT: this took a payment id with no ownership check and returned
 * bookingViewById() — so any authenticated student could reconcile any payment
 * and receive that booking in full (names, student IDs, phone, money).
 *
 * The actor is now required, and the return is a STATUS, not a booking. A caller
 * who is entitled to the booking reads it from GET /bookings/:id, which has its
 * own guard. One disclosure path, one check. */
export async function reconcile(
  paymentId: string, actor: AnyActor, provider: PaymentProvider
): Promise<{ paymentStatus: string; bookingStatus: string; bookingId: string }> {
  const p = await paymentFor(actor, paymentId, { permission: 'payment.reconcile' });
  if (!p.provider_order_id) throw new AppError('INVALID', 'That payment never reached the provider');

  const order = await provider.fetchOrder(p.provider_order_id);
  /* A deterministic synthesised id, so polling repeatedly cannot apply the same
   * outcome twice, and namespaced so it can never collide with a real provider
   * event id. */
  const event: NormalizedEvent = {
    providerEventId: `reconcile:${p.id}:${order.kind}:${order.providerStatus}`,
    provider: provider.name,
    kind: order.kind,
    providerStatus: order.providerStatus,
    amountRupees: order.amountRupees,
    orderId: order.providerOrderId,
    paymentId: order.paymentId,
    refundId: null,
    failureReason: null,
    raw: { source: 'reconciliation', order },
  };
  await recordWebhook(event, true);
  await processPendingEvents(provider);

  const { rows: [after] } = await query(
    `SELECT p.status AS payment_status, b.status AS booking_status
       FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.id = $1`, [paymentId]);
  return { paymentStatus: after.payment_status, bookingStatus: after.booking_status,
    bookingId: p.booking_id };
}

/* ---------------------------------------------------------------- refunds
 *
 * F-05 / F-12. One helper raises every refund in the system, so the cap is
 * applied once. booking_money.refundable is the reading; the
 * refunds_within_receipts trigger is the enforcement. A ₹0 booking has
 * received = 0, so refundable = 0, so nothing can be raised against it.
 */

async function raiseRefund(
  c: PoolClient, bookingId: string, paymentId: string | null, amount: number,
  reason: string, actorId: string | null, isOverride: boolean
) {
  const { rows: [m] } = await c.query('SELECT * FROM booking_money WHERE booking_id = $1', [bookingId]);
  const capped = Math.min(Math.round(amount), m?.refundable ?? 0);
  if (capped <= 0) return null;
  const { rows: [r] } = await c.query(
    `INSERT INTO refunds (booking_id, payment_id, amount, reason, requested_by, is_override)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [bookingId, paymentId, capped, reason, actorId, isOverride]);
  return r;
}

/* Refund rows are created inside the transaction that frees the seats, and
 * DISPATCHED afterwards by this job. Two reasons, both deliberate:
 *
 *   1. A network call must never be made while holding a row lock.
 *   2. If the provider call fails, the refund is still recorded as owed.
 *
 * The previous phase had no dispatch at all — refunds were written as
 * REFUND_PENDING and never sent anywhere, so the money never actually moved.
 * That gap is what this closes.
 *
 * Safe to run concurrently: each row is taken FOR UPDATE SKIP LOCKED, and the
 * provider is given our refund id as its merchant reference, so a retry after a
 * timeout cannot create a second refund at the provider either. */
export async function dispatchPendingRefunds(provider: PaymentProvider, limit = 25): Promise<number> {
  let sent = 0;
  for (;;) {
    const row = await tx(async (c) => {
      const { rows: [r] } = await c.query(
        `SELECT r.*, p.provider_payment_id
           FROM refunds r
           LEFT JOIN payments p ON p.booking_id = r.booking_id
                               AND p.status IN ('SUCCESS','DUPLICATE')
          WHERE r.status = 'REFUND_PENDING' AND r.provider_refund_id IS NULL
            AND COALESCE(r.provider_status,'') <> 'dispatching'
          ORDER BY r.created_at
          FOR UPDATE OF r SKIP LOCKED LIMIT 1`);
      if (!r) return null;
      /* A null provider_payment_id means the payment never captured — there is
       * nothing at the provider to refund, and a manual settlement is owed. */
      if (!r.provider_payment_id) {
        await c.query(
          `UPDATE refunds SET provider_status = $2, updated_at = now() WHERE id = $1`,
          [r.id, 'no captured provider payment — needs manual settlement']);
        return null;
      }
      /* Claim it, so a second worker does not pick it up while we are on the
       * network. */
      await c.query(`UPDATE refunds SET provider_status = 'dispatching', updated_at = now()
                      WHERE id = $1`, [r.id]);
      return r;
    });
    if (!row) break;

    try {
      const out = await provider.createRefund({
        providerPaymentId: row.provider_payment_id,
        amountRupees: row.amount,
        reference: row.id,                    // our id IS the idempotency handle
        note: row.reason,
      });
      await query(
        `UPDATE refunds SET provider_refund_id = $2, provider_status = $3,
                acquirer_reference = $4,
                status = CASE WHEN $5 = 'REFUND_PROCESSED' THEN 'REFUNDED'::refund_status
                              WHEN $5 = 'REFUND_FAILED'    THEN 'REFUND_FAILED'::refund_status
                              ELSE 'REFUND_PENDING'::refund_status END,
                updated_at = now()
          WHERE id = $1`,
        [row.id, out.providerRefundId, out.providerStatus, out.acquirerReference, out.kind]);
    } catch (e: any) {
      /* Left REFUND_PENDING with the error recorded, so the next run retries.
       * Never marked REFUND_FAILED on OUR network error — that would tell
       * operations the provider refused when it may never have been asked. */
      await query(
        `UPDATE refunds SET provider_status = $2, updated_at = now() WHERE id = $1`,
        [row.id, `dispatch error: ${String(e?.message ?? e).slice(0, 200)}`]);
    }
    if (++sent >= limit) break;
  }
  return sent;
}

export async function cancellationQuote(bookingId: string, actor: AnyActor) {
  await bookingFor(actor, bookingId);
  const { rows: [b] } = await query(
    `SELECT b.status, t.departure_at, m.refundable
       FROM bookings b JOIN trips t ON t.id = b.trip_id
       JOIN booking_money m ON m.booking_id = b.id WHERE b.id = $1`, [bookingId]);
  if (!b) throw new AppError('NOT_FOUND', 'Booking not found');
  const hours = (new Date(b.departure_at).getTime() - Date.now()) / 3600_000;
  const withinPolicy = hours >= CANCELLATION_CUTOFF_HOURS;
  return {
    refundable: withinPolicy && b.refundable > 0,
    amount: withinPolicy ? b.refundable : 0,
    hoursToDeparture: Math.max(0, Math.round(hours)),
    reason: withinPolicy ? null
      : `Cancellations within ${CANCELLATION_CUTOFF_HOURS} hours of departure are not refunded`,
  };
}

export async function cancelBooking(bookingId: string, actor: Actor, reason?: string) {
  const actorId = actor.userId;
  return tx(async (c) => {
    /* Ownership OR booking.cancel, via the central guard, with the row locked
     * so the check and the mutation it guards are one transaction. */
    const b = await bookingFor(actor, bookingId,
      { permission: 'booking.cancel', forUpdate: true, client: c });
    if (['CANCELLED_BY_STUDENT', 'CANCELLED_BY_DLT'].includes(b.status))
      throw new AppError('CONFLICT', 'That booking is already cancelled');

    const quote = await cancellationQuote(bookingId, actor);
    const isStudent = b.user_id === actorId;
    const refund = quote.amount > 0
      ? await raiseRefund(c, bookingId, null, quote.amount,
          reason ?? 'Cancelled by the student', actorId, false)
      : null;

    const released = await c.query('SELECT release_booking_seats($1,$2) AS n',
      [bookingId, isStudent ? 'CANCELLED_BY_STUDENT' : 'CANCELLED_BY_DLT']);
    await audit(c, { actorId }, 'booking.cancelled', 'booking', bookingId, b.status,
      refund ? `refund ₹${refund.amount}` : 'no refund', reason ?? null);

    return { cancelled: true, refundAmount: refund?.amount ?? 0,
      seatsReleased: released.rows[0].n, refundId: refund?.id ?? null };
  });
}

/** F-12. Super Admin only, explicit amount, mandatory reason, capped by money
 *  actually held, refuses ₹0 — and returns what it really raised, so nothing
 *  can report success on a zero-value action. */
export async function overrideRefund(input: {
  bookingId: string; amount: number; reason: string; cancelBooking?: boolean; actorId: string;
}) {
  /* Super Admin only, checked here and not merely on the route.
   *
   * N-1: an earlier draft accepted an optional `actorRole`, so a future caller
   * could have passed a role of its choosing. The role is ALWAYS read from the
   * database for the given actor id — there is no parameter to supply it. */
  await requireOperator({ userId: input.actorId, role: await roleOf(input.actorId) },
    'refund.override');
  if (!input.reason || input.reason.trim().length < 4)
    throw new AppError('VALIDATION', 'A reason is required for a policy override');
  const want = Math.round(Number(input.amount));
  if (!(want > 0))
    throw new AppError('VALIDATION', 'Enter the refund amount. A zero-value override is not an override.');

  return tx(async (c) => {
    const { rows: [m] } = await c.query('SELECT * FROM booking_money WHERE booking_id=$1', [input.bookingId]);
    if (!m) throw new AppError('NOT_FOUND', 'Booking not found');
    if (m.refundable <= 0)
      throw new AppError('CONFLICT',
        `Nothing is left to refund on ${m.code} — ₹${m.received} received, ₹${m.returned} already returned.`);
    if (want > m.refundable)
      throw new AppError('VALIDATION', `₹${want} is more than the ₹${m.refundable} still refundable on ${m.code}.`);

    const r = await raiseRefund(c, input.bookingId, null, want,
      `Policy override: ${input.reason.trim()}`, input.actorId, true);
    let released = 0;
    if (input.cancelBooking) {
      const out = await c.query('SELECT release_booking_seats($1,$2) AS n',
        [input.bookingId, 'CANCELLED_BY_DLT']);
      released = out.rows[0].n;
    }
    await audit(c, { actorId: input.actorId }, 'refund.policy_override', 'booking', input.bookingId,
      'refundable by policy: ₹0', `₹${want}`, input.reason.trim());
    return { amount: r!.amount, refundId: r!.id, seatsReleased: released,
      remainingRefundable: m.refundable - want };
  });
}

/* ---------------------------------------------------------------- manual */

/** §40. Super Admin only. A complimentary booking is worth ₹0 and therefore can
 *  never produce a refund — F-05 by construction, not by a check. */
export async function createManualBooking(input: {
  tripId: string; type: 'COMPLIMENTARY' | 'PAID_EXTERNALLY';
  passengers: PassengerInput[]; contactPhone: string; reason: string; actorId: string;
}) {
  /* N-1: role read from the database, never accepted as an argument. */
  await requireOperator({ userId: input.actorId, role: await roleOf(input.actorId) },
    'booking.manual');
  if (!input.reason || input.reason.trim().length < 4)
    throw new AppError('VALIDATION', 'A reason is required for a manual booking');
  validatePassengers(input.passengers, input.contactPhone);

  return tx(async (c) => {
    const { rows: [t] } = await c.query('SELECT * FROM trips WHERE id=$1 FOR SHARE', [input.tripId]);
    if (!t) throw new AppError('NOT_FOUND', 'Trip not found');

    const comp = input.type === 'COMPLIMENTARY';
    const unit = comp ? 0 : t.price;
    const { rows: [b] } = await c.query(
      `INSERT INTO bookings (code, boarding_code, trip_id, status, kind, unit_price,
                             total_amount, contact_phone, manual_reason)
       VALUES (new_booking_code(), new_boarding_code(), $1, 'CONFIRMED', $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.tripId, comp ? 'MANUAL_COMPLIMENTARY' : 'MANUAL_EXTERNAL',
       unit, unit * input.passengers.length, input.contactPhone, input.reason.trim()]);

    for (const p of input.passengers) {
      const { rows: [s] } = await c.query(
        `SELECT * FROM trip_seats WHERE trip_id=$1 AND seat_number=$2 FOR UPDATE`,
        [input.tripId, p.seatNumber]);
      if (!s || s.status !== 'AVAILABLE')
        throw new AppError('CONFLICT', `Seat ${p.seatNumber} is not available`);
      const { rows: [pax] } = await c.query(
        `INSERT INTO booking_passengers (booking_id, trip_seat_id, name, student_id, phone,
                                         seat_number, seat_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [b.id, s.id, p.name, p.studentId, p.phone ?? input.contactPhone, s.seat_number, s.seat_type]);
      await c.query(
        `UPDATE trip_seats SET status='BOOKED', booking_id=$2, hold_by=NULL,
                hold_guest_token=NULL, hold_expires_at=NULL, updated_at=now() WHERE id=$1`,
        [s.id, b.id]);
      await c.query(
        `INSERT INTO boarding_passes (passenger_id, booking_id, trip_id, qr_token)
         VALUES ($1,$2,$3, 'dlt.' || encode(gen_random_bytes(14),'hex'))`,
        [pax.id, b.id, input.tripId]);
    }

    /* The payment record says plainly what it is. A complimentary seat is
     * NOT_APPLICABLE and never presented as a provider payment. */
    await c.query(
      `INSERT INTO payments (booking_id, amount, status, provider)
       VALUES ($1,$2,$3,$4)`,
      [b.id, unit * input.passengers.length,
       comp ? 'NOT_APPLICABLE' : 'SUCCESS',
       comp ? 'NONE_COMPLIMENTARY' : 'MANUAL_EXTERNAL']);

    await audit(c, { actorId: input.actorId }, 'booking.manual_created', 'booking', b.id,
      null, `${b.kind} ₹${b.total_amount}`, input.reason.trim());
    return bookingView(c, b.id);
  });
}

/* ---------------------------------------------------------------- idempotency */

/* H-4. THE DEFECT: request_hash was JSON.stringify(req).length — a LENGTH, not
 * a digest — and was never compared on replay, so a caller presenting a known
 * key received the stored response of the ORIGINAL request (a full booking
 * view). Keys are client-chosen; key quality was never ours to assume.
 *
 * Now: a real SHA-256 over a canonicalised body, compared on every replay, and
 * every record bound to its caller. */

/** Stable JSON: keys sorted at every depth, so two semantically identical
 * bodies hash the same regardless of property order. */
function canonicalise(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonicalise).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort()
    .map(k => JSON.stringify(k) + ':' + canonicalise(o[k])).join(',') + '}';
}

const requestDigest = (req: unknown) =>
  createHash('sha256').update(canonicalise(req), 'utf8').digest('hex');

async function claimIdempotency(
  c: PoolClient, key: string, endpoint: string, req: unknown, actor: AnyActor
) {
  if (!key) throw new AppError('VALIDATION', 'An Idempotency-Key is required');
  const digest = requestDigest(req);
  const userId = (actor as Actor).userId ?? null;
  const guestToken = (actor as { guestToken?: string | null }).guestToken ?? null;

  const { rows: [existing] } = await c.query(
    'SELECT * FROM idempotency_keys WHERE key = $1 AND endpoint = $2 FOR UPDATE',
    [key, endpoint]);

  if (existing) {
    /* Bound to the caller: one caller's key can never be another's. Same
     * message for a foreign key and a changed body, so this cannot be used to
     * probe which keys exist. */
    const sameCaller = userId
      ? existing.user_id === userId
      : !!guestToken && existing.guest_token === guestToken;
    if (!sameCaller || existing.request_hash !== digest)
      throw new AppError('CONFLICT',
        'That Idempotency-Key was already used for a different request. Use a new key.');

    if (existing.completed_at) return existing.response_body;
    /* In flight: a concurrent duplicate. Refuse rather than racing — the row
     * lock above serialises the two, so exactly one proceeds. */
    throw new AppError('CONFLICT', 'That request is already in progress');
  }

  await c.query(
    `INSERT INTO idempotency_keys (key, endpoint, request_hash, user_id, guest_token)
     VALUES ($1,$2,$3,$4,$5)`,
    [key, endpoint, digest, userId, guestToken]);
  return null;
}

async function completeIdempotency(c: PoolClient, key: string, endpoint: string, body: unknown) {
  await c.query(
    `UPDATE idempotency_keys SET completed_at = now(), response_code = 201, response_body = $3::jsonb
      WHERE key = $1 AND endpoint = $2`, [key, endpoint, JSON.stringify(body)]);
}

/* ---------------------------------------------------------------- views */

const BOOKING_SQL = `
  SELECT b.id, b.code, b.boarding_code AS "boardingCode", b.status, b.kind,
         b.user_id AS "userId",
         b.unit_price AS "unitPrice", b.total_amount AS "totalAmount",
         b.contact_phone AS "contactPhone", b.hold_expires_at AS "holdExpiresAt",
         b.reprice_to AS "repriceTo", b.created_at AS "createdAt",
         json_build_object('id', t.id, 'departureAt', t.departure_at, 'status', t.status) AS trip,
         COALESCE(pax.rows,'[]'::json) AS passengers,
         m.received, m.returned, m.refundable,
         (SELECT row_to_json(x) FROM (
            SELECT p.id, p.status, p.amount, p.provider, p.provider_reference AS "reference"
              FROM payments p WHERE p.booking_id = b.id
             ORDER BY CASE p.status WHEN 'SUCCESS' THEN 0 WHEN 'NOT_APPLICABLE' THEN 1 ELSE 2 END,
                      p.created_at DESC LIMIT 1) x) AS payment
    FROM bookings b
    JOIN trips t ON t.id = b.trip_id
    JOIN booking_money m ON m.booking_id = b.id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
        'id', bp.id, 'name', bp.name, 'studentId', bp.student_id,
        'seatNumber', bp.seat_number, 'seatType', bp.seat_type,
        'boardingStatus', bp.boarding_status,
        'passStatus', pass.status) ORDER BY bp.seat_number) AS rows
        FROM booking_passengers bp
        LEFT JOIN boarding_passes pass ON pass.passenger_id = bp.id
       WHERE bp.booking_id = b.id
    ) pax ON true`;

async function bookingView(c: PoolClient, id: string) {
  const { rows: [b] } = await c.query(`${BOOKING_SQL} WHERE b.id = $1`, [id]);
  return b;
}
/** Ownership-checked read. The route previously compared a `userId` field that
 *  BOOKING_SQL did not select, so the comparison was always false and any
 *  authenticated user could read any booking. */
/** Ownership-checked payment read, for the handback. Returns the row, not a
 *  booking — the caller must not be able to reach PII through this. */
export async function paymentForActor(id: string, actor: AnyActor) {
  return paymentFor(actor, id, { permission: 'payment.read' });
}

export async function bookingForActor(id: string, actor: AnyActor) {
  await bookingFor(actor, id);          // the check; throws on failure
  const { rows: [b] } = await query(`${BOOKING_SQL} WHERE b.id = $1`, [id]);
  return b;
}

export async function bookingViewById(id: string) {
  const { rows: [b] } = await query(`${BOOKING_SQL} WHERE b.id = $1`, [id]);
  if (!b) throw new AppError('NOT_FOUND', 'Booking not found');
  return b;
}
export async function myBookings(userId: string) {
  const { rows } = await query(`${BOOKING_SQL} WHERE b.user_id = $1
    AND b.status <> 'ABANDONED' ORDER BY t.departure_at DESC`, [userId]);
  return rows;
}
