/* DLT · http/boarding.routes.ts — the boarding HTTP boundary.
 *
 * The scanner submits an identifier. That is the entire contract. Every verdict,
 * every scope decision and every mutation happens server-side.
 *
 * Note what these routes do NOT accept: a result, a boarding status, a
 * passenger's validity, or (for staff) a trip. A scanner that could post
 * "result: VALID" would be the authority, and it is not.
 *
 * WRITTEN, NOT EXECUTED.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import * as boarding from '../domain/boarding.ts';
import { requireAuth, requirePermission } from './auth.routes.ts';

const router = Router();
const UUID = z.string().uuid();
/* The canonical Actor (domain/authz.ts) is { userId, role, ip?, guestToken? }.
 * The boarding domain reads only userId and role; it never referenced `name`,
 * which was not on the type. */
const actorOf = (req: any): boarding.Actor => ({
  userId: req.session.userId, role: req.session.role });

/* A door scanner fires fast and repeatedly; a brute-force enumerator also
 * fires fast and repeatedly. This bounds the second without impeding the
 * first — a queue boards well under 120 scans a minute per device. */
const scanThrottle = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true });

/** What trip am I boarding? Staff cannot change it; the console shows it. */
router.get('/boarding/context', requireAuth, requirePermission('boarding.scan'),
  async (req, res, next) => {
    try { res.json(await boarding.scannerContext(actorOf(req))); } catch (e) { next(e); }
  });

/* One endpoint for all three identifier kinds and for the CHOOSE follow-up.
 * F-11: a hand-typed boarding code runs the identical chain as a scanned token
 * — there is no second, weaker path for typed input. */
router.post('/boarding/scan', requireAuth, requirePermission('boarding.scan'), scanThrottle,
  async (req, res, next) => {
    try {
      const body = z.object({
        /* Deliberately permissive: this is whatever the camera decoded or the
         * staff member typed. The server decides what it is. */
        code: z.string().min(1).max(256),
        /* Ignored entirely for BOARDING_STAFF, whose trip comes from their
         * assignment (F-19). Honoured for ops, who may scope a desk scan. */
        tripId: UUID.nullish(),
        /* Set on the second call, after a CHOOSE. */
        passengerId: UUID.nullish(),
      }).parse(req.body);
      res.json(await boarding.scan(body, actorOf(req)));
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- manual */

router.post('/boarding/passengers/:id/manual', requireAuth, requirePermission('boarding.manual'),
  async (req, res, next) => {
    try {
      const reason = z.string().min(4).max(500).parse(req.body?.reason);
      res.json(await boarding.manualBoard(UUID.parse(req.params.id), reason, actorOf(req)));
    } catch (e) { next(e); }
  });

router.post('/boarding/passengers/:id/deny', requireAuth, requirePermission('boarding.deny'),
  async (req, res, next) => {
    try {
      const reason = z.string().min(4).max(500).parse(req.body?.reason);
      res.json(await boarding.denyBoarding(UUID.parse(req.params.id), reason, actorOf(req)));
    } catch (e) { next(e); }
  });

router.post('/boarding/passengers/:id/no-show', requireAuth, requirePermission('boarding.noshow'),
  async (req, res, next) => {
    try {
      const reason = z.string().min(4).max(500).parse(req.body?.reason);
      res.json(await boarding.confirmNoShow(UUID.parse(req.params.id), reason, actorOf(req)));
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- manifest */

/* The :tripId is ignored for staff, who always get their assigned trip. Same
 * derivation as the scanner, so the door list and the scanner cannot disagree. */
router.get('/trips/:tripId/manifest', requireAuth, requirePermission('boarding.read'),
  async (req, res, next) => {
    try {
      const id = req.params.tripId === 'assigned' ? null : UUID.parse(req.params.tripId);
      res.json(await boarding.manifest(id, actorOf(req)));
    } catch (e) { next(e); }
  });

router.get('/trips/:tripId/boarding-events', requireAuth, requirePermission('boarding.read'),
  async (req, res, next) => {
    try {
      res.json({ events: await boarding.boardingEvents(UUID.parse(req.params.tripId), actorOf(req)) });
    } catch (e) { next(e); }
  });

export default router;
