/* DLT · http/bookings.routes.ts — bookings, checkout, webhook.
 * No business rules here. WRITTEN, NOT EXECUTED.
 */

import { Router, raw, type Request } from 'express';
import { z } from 'zod';
import * as pay from '../domain/payments.ts';
import { requireAuth, requirePermission, GUEST_COOKIE } from './auth.routes.ts';
import { AppError } from '../domain/errors.ts';
import type { PaymentProvider } from '../domain/payment-provider.ts';

export default function bookingRoutes(provider: PaymentProvider) {
  const router = Router();
  const UUID = z.string().uuid();

  const holderOf = (req: Request) => req.session
    ? { userId: req.session.userId, ip: req.ip }
    : { guestToken: req.cookies?.[GUEST_COOKIE] ?? '', ip: req.ip };

  /* The actor for every owned-object guard. Built from the SESSION, or from the
   * guest cookie for an anonymous checkout. req.body is never consulted for
   * identity, so a forged role or user id in a payload changes nothing. */
  const actorOf = (req: Request) => req.session
    ? { userId: req.session.userId, role: req.session.role, ip: req.ip }
    : { guestToken: req.cookies?.[GUEST_COOKIE] ?? '', ip: req.ip };

  const PassengerSchema = z.object({
    seatNumber: z.string().regex(/^\d{1,2}[A-D]$/i),
    name: z.string().min(3).max(120),
    studentId: z.string().min(4).max(20),
    phone: z.string().max(15).optional(),
  });

  /* ------------------------------------------------------------ bookings */

  router.post('/bookings', async (req, res, next) => {
    try {
      const key = req.get('Idempotency-Key');
      if (!key) throw new AppError('VALIDATION', 'An Idempotency-Key header is required');
      const body = z.object({
        tripId: UUID,
        contactPhone: z.string().min(10).max(15),
        passengers: z.array(PassengerSchema).min(1).max(4),
      }).parse(req.body);

      const holder = holderOf(req);
      if (!holder.userId && !holder.guestToken)
        throw new AppError('CONFLICT', 'Your seats went back on sale. Choose again.');

      res.status(201).json({ booking: await pay.createBooking({ ...body, holder, idempotencyKey: key }) });
    } catch (e) { next(e); }
  });

  router.get('/bookings/mine', requireAuth, async (req, res, next) => {
    try { res.json({ bookings: await pay.myBookings(req.session!.userId) }); }
    catch (e) { next(e); }
  });

  /* Readable by its owner, or by an operator with booking.read. The ownership
   * test lives in the domain so no route can forget it. */
  router.get('/bookings/:id', requireAuth, async (req, res, next) => {
    try {
      res.json({ booking: await pay.bookingForActor(
        UUID.parse(req.params.id), actorOf(req)) });
    } catch (e) { next(e); }
  });

  /* F-03 · the student is shown the new total and accepts it. The prototype had
   * no such control, which is why its price-change error looped forever. */
  router.post('/bookings/:id/accept-price', requireAuth, async (req, res, next) => {
    try {
      res.json({ booking: await pay.acceptReprice(UUID.parse(req.params.id), actorOf(req) as any) });
    } catch (e) { next(e); }
  });

  /* H-1: the quote is a financial read about a specific person. Ownership or
   * booking.read, enforced in the domain. */
  router.get('/bookings/:id/cancellation-quote', requireAuth, async (req, res, next) => {
    try { res.json(await pay.cancellationQuote(UUID.parse(req.params.id), actorOf(req))); }
    catch (e) { next(e); }
  });

  router.post('/bookings/:id/cancel', requireAuth, async (req, res, next) => {
    try {
      const reason = z.string().max(500).optional().parse(req.body?.reason);
      res.json(await pay.cancelBooking(UUID.parse(req.params.id), actorOf(req) as any, reason));
    } catch (e) { next(e); }
  });

  /* ------------------------------------------------------------ payments */

  router.post('/payments/create', requireAuth, async (req, res, next) => {
    try {
      const { bookingId } = z.object({ bookingId: UUID }).parse(req.body);
      /* Note what is NOT accepted from the client: an amount. The fare is read
       * from the booking, which was frozen at creation. */
      const out = await pay.createCheckout(bookingId, actorOf(req) as any, provider);
      /* The repriced branch of createCheckout already carries `repriced: true`
       * alongside oldTotal/newTotal; spreading it is the whole 409 body. */
      if ('repriced' in out) return res.status(409).json({ ...out });
      /* The browser is given the checkout handle and the PUBLIC key id. The key
       * SECRET and the webhook secret never leave the server. */
      res.json({ ...out, keyId: process.env.RAZORPAY_KEY_ID, provider: provider.name });
    } catch (e) { next(e); }
  });

  /* C-2: a payment is owned by whoever owns its booking. The response is a
   * STATUS, never a booking — a caller entitled to the booking reads it from
   * GET /bookings/:id, which has its own guard. One disclosure path. */
  router.post('/payments/:id/reconcile', requireAuth, async (req, res, next) => {
    try { res.json(await pay.reconcile(UUID.parse(req.params.id), actorOf(req), provider)); }
    catch (e) { next(e); }
  });

  /* The checkout handback, after Razorpay Checkout's handler fires.
   *
   * C-1. THE DEFECT: this was UNAUTHENTICATED, accepted any paymentId, and
   * returned the full booking — names, student IDs, phone, money. Worse, the
   * signature result was computed, logged, and then IGNORED: a forged handback
   * proceeded exactly like a valid one. A signature check that gates nothing is
   * not a check.
   *
   * Now: session required, ownership enforced, a bad signature is REFUSED, and
   * the response carries a status only. It remains a report, never a second
   * confirmation path — only a verified webhook confirms a booking.
   *
   * The posted order id is still not trusted: the signature is verified against
   * the order id WE stored, per Razorpay's own warning. */
  router.post('/payments/handback', requireAuth, async (req, res, next) => {
    try {
      const body = z.object({
        paymentId: UUID,                                  // OUR payment row id
        razorpay_payment_id: z.string().min(4).max(64),
        razorpay_signature: z.string().min(16).max(256),
      }).parse(req.body);

      /* Ownership first, so an unauthorized caller learns nothing — not even
       * whether the payment exists. */
      const payment = await pay.paymentForActor(body.paymentId, actorOf(req));

      if (!payment.provider_order_id)
        throw new AppError('INVALID', 'That payment never reached the provider');

      const ok = provider.verifyCheckoutHandback({
        ourOrderId: payment.provider_order_id,            // from our database
        providerPaymentId: body.razorpay_payment_id,
        signature: body.razorpay_signature,
      });
      if (!ok) {
        console.warn('[handback] signature mismatch for payment %s', body.paymentId);
        throw new AppError('FORBIDDEN', 'That payment confirmation could not be verified');
      }

      const status = await pay.reconcile(body.paymentId, actorOf(req), provider);
      /* Status only. Never the booking object. */
      res.json({ signatureVerified: true, ...status,
        note: 'Confirmation comes from the provider webhook, not from this response.' });
    } catch (e) { next(e); }
  });

  /* ------------------------------------------------------------ webhook
   *
   * Mounted with a RAW body parser. Razorpay signs the exact bytes sent and
   * their documentation says not to parse or cast the body before verifying, so
   * a JSON.parse-then-restringify here would break every signature.
   *
   * Verify -> record -> 200. Processing happens afterwards: Razorpay treats any
   * non-2xx as a delivery failure and retries with exponential backoff for 24
   * hours, so a slow query must never become the response.
   */
  router.post('/payments/webhook', raw({ type: '*/*' }), async (req, res) => {
    const body = (req.body as Buffer)?.toString('utf8') ?? '';
    try {
      const event = provider.verifyAndParseWebhook(body, req.headers as Record<string, string>);
      await pay.recordWebhook(event, true);
      res.status(200).json({ received: true });
      void pay.processPendingEvents(provider)
        .then(() => pay.dispatchPendingRefunds(provider))
        .catch(e => console.error('[webhook] process', e));
    } catch (e) {
      /* A bad signature, or a delivery with no x-razorpay-event-id, is refused
       * and never processed. 200 so a hostile sender learns nothing from the
       * status code — and so a genuine misconfiguration does not trigger 24
       * hours of retries against an endpoint that will keep refusing it. */
      console.warn('[webhook] rejected:', (e as Error).message);
      res.status(200).json({ received: true });
    }
  });

  /* ------------------------------------------------------------ admin money */

  router.post('/admin/bookings/:id/override-refund',
    requireAuth, requirePermission('refund.override'), async (req, res, next) => {
    try {
      const body = z.object({
        amount: z.coerce.number().int().positive(),
        reason: z.string().min(4).max(500),
        cancelBooking: z.boolean().default(true),
      }).parse(req.body);
      const out = await pay.overrideRefund({ bookingId: UUID.parse(req.params.id),
        ...body, actorId: req.session!.userId });
      /* Says the amount it actually raised — never "override applied" on ₹0. */
      res.json({ ...out, message: `₹${out.amount} refund created` });
    } catch (e) { next(e); }
  });

  router.post('/admin/bookings/manual',
    requireAuth, requirePermission('booking.manual'), async (req, res, next) => {
    try {
      const body = z.object({
        tripId: UUID,
        type: z.enum(['COMPLIMENTARY', 'PAID_EXTERNALLY']),
        passengers: z.array(PassengerSchema).min(1).max(4),
        contactPhone: z.string().min(10).max(15),
        reason: z.string().min(4).max(500),
      }).parse(req.body);
      res.status(201).json({ booking: await pay.createManualBooking({ ...body, actorId: req.session!.userId }) });
    } catch (e) { next(e); }
  });

  return router;
}
