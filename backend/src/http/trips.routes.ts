/* DLT · http/trips.routes.ts — trips, seats and waitlist over HTTP.
 * No business rules here. WRITTEN, NOT EXECUTED.
 */

import { Router, type Request } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import * as seats from '../domain/seats.ts';
import { requireAuth, GUEST_COOKIE } from './auth.routes.ts';
import { AppError } from '../domain/errors.ts';

const router = Router();

/* F-09 · UX §4 promises seat selection without an account. An unsigned browser
 * gets an opaque guest token in an HttpOnly cookie; sign-in adopts whatever it
 * holds (F-08), so authenticating mid-booking no longer loses the basket. */
function holderOf(req: Request, res: any): seats.Holder {
  if (req.session) return { userId: req.session.userId, ip: req.ip };
  let g = req.cookies?.[GUEST_COOKIE];
  if (!g) {
    g = randomBytes(24).toString('base64url');
    res.cookie(GUEST_COOKIE, g, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/',
      expires: new Date(Date.now() + 24 * 3600_000),
    });
  }
  return { guestToken: g, ip: req.ip };
}

const UUID = z.string().uuid();

router.get('/trips', async (req, res, next) => {
  try {
    const days = z.coerce.number().int().min(1).max(60).optional().parse(req.query.days);
    await seats.sweepExpiredHolds();          // never show a lapsed hold as taken
    res.json({ trips: await seats.listTrips({ days }) });
  } catch (e) { next(e); }
});

router.get('/trips/:id', async (req, res, next) => {
  try { res.json({ trip: await seats.getTrip(UUID.parse(req.params.id)) }); }
  catch (e) { next(e); }
});

router.get('/trips/:id/seats', async (req, res, next) => {
  try {
    const id = UUID.parse(req.params.id);
    await seats.sweepExpiredHolds();
    const holder = req.session ? { userId: req.session.userId }
      : (req.cookies?.[GUEST_COOKIE] ? { guestToken: req.cookies[GUEST_COOKIE] } : null);
    res.json({ rows: await seats.seatMap(id, holder), held: holder ? await seats.myHeld(id, holder) : [] });
  } catch (e) { next(e); }
});

/* The one endpoint where two devices genuinely race. The domain delegates to a
 * locking SQL function; the loser gets 409 with the seat's real state. */
router.post('/trips/:id/seats/:seatNumber/hold', async (req, res, next) => {
  try {
    const id = UUID.parse(req.params.id);
    const seatNumber = z.string().regex(/^\d{1,2}[A-D]$/i).parse(req.params.seatNumber).toUpperCase();
    res.json({ seat: await seats.holdSeat(id, seatNumber, holderOf(req, res)) });
  } catch (e) { next(e); }
});

router.delete('/trips/:id/seats/:seatNumber/hold', async (req, res, next) => {
  try {
    const id = UUID.parse(req.params.id);
    const seatNumber = z.string().regex(/^\d{1,2}[A-D]$/i).parse(req.params.seatNumber).toUpperCase();
    const released = await seats.releaseSeat(id, seatNumber, holderOf(req, res));
    /* F-20: the client is told this was deliberate, so it never shows the
     * "your seats went back on sale" expiry screen for a removal. */
    res.json({ released, reason: 'RELEASED_BY_STUDENT' });
  } catch (e) { next(e); }
});

router.delete('/trips/:id/holds', async (req, res, next) => {
  try {
    const n = await seats.releaseAll(UUID.parse(req.params.id), holderOf(req, res));
    res.json({ released: n, reason: 'RELEASED_BY_STUDENT' });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- notify
 *
 * B-2. Deliberately NOT behind requireAuth: the sold-out and empty states are
 * shown to students who have not signed in, and requiring an account before
 * someone can express interest defeats the purpose of the signal.
 *
 * Throttled, because it accepts an email from an anonymous caller.
 */
const notifyThrottle = rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: true });

router.post('/trips/:id/notify', notifyThrottle, async (req, res, next) => {
  try {
    const email = z.string().email().max(254).optional().parse(req.body?.email);
    res.status(201).json(await seats.requestNotify({
      tripId: UUID.parse(req.params.id),
      email: email ?? req.session?.email ?? null,
      userId: req.session?.userId ?? null,
    }));
  } catch (e) { next(e); }
});

/* No trip named — "tell me about new departures" from the empty state. */
router.post('/notify', notifyThrottle, async (req, res, next) => {
  try {
    const email = z.string().email().max(254).optional().parse(req.body?.email);
    res.status(201).json(await seats.requestNotify({
      tripId: null,
      email: email ?? req.session?.email ?? null,
      userId: req.session?.userId ?? null,
    }));
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- waitlist */

router.post('/trips/:id/waitlist', requireAuth, async (req, res, next) => {
  try {
    const seatsWanted = z.coerce.number().int().min(1).max(4).default(1).parse(req.body?.seatsWanted);
    res.status(201).json({ entry: await seats.joinWaitlist(
      UUID.parse(req.params.id), req.session!.userId, seatsWanted) });
  } catch (e) { next(e); }
});

router.get('/waitlist/mine', requireAuth, async (req, res, next) => {
  try { res.json({ entries: await seats.myWaitlist(req.session!.userId) }); }
  catch (e) { next(e); }
});

/* F-02 · the half that did not exist. */
router.post('/waitlist/:id/claim', requireAuth, async (req, res, next) => {
  try {
    res.json({ seat: await seats.claimOffer(UUID.parse(req.params.id), req.session!.userId) });
  } catch (e) { next(e); }
});

router.post('/waitlist/:id/decline', requireAuth, async (req, res, next) => {
  try {
    const ok = await seats.declineOffer(UUID.parse(req.params.id), req.session!.userId);
    if (!ok) throw new AppError('INVALID', 'There is no open offer on that entry');
    res.json({ declined: true });
  } catch (e) { next(e); }
});

export default router;
