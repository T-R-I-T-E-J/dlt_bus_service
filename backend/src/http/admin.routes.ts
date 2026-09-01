/* DLT · http/admin.routes.ts — the operations HTTP boundary.
 *
 * Thin by design: parse, authorize, call the domain, serialize. Not one business
 * rule lives here.
 *
 * EVERY route carries requirePermission, which checks the role stored in the
 * DATABASE against the session — never a role, flag or scope from the request.
 * A client that posts {"role":"SUPER_ADMIN"} changes nothing, because nothing
 * reads it.
 *
 * WRITTEN, NOT EXECUTED.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';
import * as admin from '../domain/admin.ts';
import { readAudit } from '../domain/audit.ts';
import { requireAuth, requirePermission } from './auth.routes.ts';

const router = Router();
const UUID = z.string().uuid();
const SEAT = z.string().regex(/^\d{1,2}[A-D]$/i);
const REASON = z.string().min(4).max(500);

/* The actor is built from the SESSION only. This function is the reason a
 * tampered body cannot escalate: req.body is never consulted for identity. */
const actorOf = (req: Request): admin.Actor =>
  ({ userId: req.session!.userId, role: req.session!.role, ip: req.ip });

router.use(requireAuth);

/* ---------------------------------------------------------------- today */

router.get('/admin/today', requirePermission('trip.read'), async (req, res, next) => {
  try { res.json(await admin.today(actorOf(req))); } catch (e) { next(e); }
});

router.get('/admin/alerts', requirePermission('booking.read'), async (req, res, next) => {
  try { res.json({ alerts: await admin.operationalAlerts(actorOf(req)) }); } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- trips */

router.post('/admin/trips', requirePermission('trip.write'), async (req, res, next) => {
  try {
    const body = z.object({
      id: UUID.nullish(), routeId: UUID, vehicleId: UUID,
      departureAt: z.string().datetime(), price: z.coerce.number().int().min(0).max(100000),
    }).parse(req.body);
    res.status(body.id ? 200 : 201).json({ trip: await admin.saveTrip(body, actorOf(req)) });
  } catch (e) { next(e); }
});

router.post('/admin/trips/:id/publish', requirePermission('trip.publish'), async (req, res, next) => {
  try { res.json(await admin.publishTrip(UUID.parse(req.params.id), actorOf(req))); }
  catch (e) { next(e); }
});

router.post('/admin/trips/:id/status', requirePermission('trip.status'), async (req, res, next) => {
  try {
    const body = z.object({
      status: z.enum(['DRAFT', 'OPEN', 'BOOKING_CLOSED', 'BOARDING', 'DEPARTED', 'COMPLETED']),
      reason: REASON,
    }).parse(req.body);
    res.json(await admin.setTripStatus(UUID.parse(req.params.id), body.status, body.reason, actorOf(req)));
  } catch (e) { next(e); }
});

router.post('/admin/trips/:id/cancel', requirePermission('trip.cancel'), async (req, res, next) => {
  try {
    const reason = REASON.parse(req.body?.reason);
    res.json(await admin.cancelTrip(UUID.parse(req.params.id), reason, actorOf(req)));
  } catch (e) { next(e); }
});

/* F-22: scoped to THIS trip. The prototype exported every passenger in the
 * system from the equivalent action. */
router.get('/admin/trips/:id/affected', requirePermission('report.export'), async (req, res, next) => {
  try {
    res.json({ passengers: await admin.affectedPassengers(UUID.parse(req.params.id), actorOf(req)) });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- seats */

router.post('/admin/trips/:id/seats/:seat/block', requirePermission('seat.block'),
  async (req, res, next) => {
    try {
      const reason = REASON.parse(req.body?.reason);
      res.json({ seat: await admin.blockSeat(
        UUID.parse(req.params.id), SEAT.parse(req.params.seat), reason, actorOf(req)) });
    } catch (e) { next(e); }
  });

router.delete('/admin/trips/:id/seats/:seat/block', requirePermission('seat.block'),
  async (req, res, next) => {
    try {
      res.json({ seat: await admin.unblockSeat(
        UUID.parse(req.params.id), SEAT.parse(req.params.seat), actorOf(req)) });
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- vehicles */

router.get('/admin/vehicles', requirePermission('vehicle.read'), async (req, res, next) => {
  try { res.json({ vehicles: await admin.listVehicles(actorOf(req)) }); } catch (e) { next(e); }
});

router.post('/admin/vehicles', requirePermission('vehicle.write'), async (req, res, next) => {
  try {
    const body = z.object({
      id: UUID.nullish(),
      name: z.string().min(2).max(80),
      registration: z.string().min(6).max(20),
      rowCount: z.coerce.number().int().min(4).max(20).nullish(),
      status: z.enum(['AVAILABLE', 'MAINTENANCE', 'INACTIVE']).nullish(),
    }).parse(req.body);
    res.json({ vehicle: await admin.saveVehicle(body, actorOf(req)) });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- staff */

router.get('/admin/staff', requirePermission('staff.assign'), async (req, res, next) => {
  try { res.json({ staff: await admin.listStaff(actorOf(req)) }); } catch (e) { next(e); }
});

router.post('/admin/trips/:id/staff', requirePermission('staff.assign'), async (req, res, next) => {
  try {
    const body = z.object({ staffUserId: UUID, reason: z.string().max(500).optional() }).parse(req.body);
    res.json(await admin.assignStaff(UUID.parse(req.params.id), body.staffUserId, body.reason, actorOf(req)));
  } catch (e) { next(e); }
});

router.delete('/admin/trips/:id/staff/:userId', requirePermission('staff.assign'),
  async (req, res, next) => {
    try {
      res.json(await admin.unassignStaff(
        UUID.parse(req.params.id), UUID.parse(req.params.userId), actorOf(req)));
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- bookings */

router.get('/admin/bookings', requirePermission('booking.read'), async (req, res, next) => {
  try {
    const f = z.object({
      q: z.string().max(60).optional(), tripId: UUID.optional(),
      status: z.string().max(30).optional(),
      from: z.string().optional(), to: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }).parse(req.query);
    res.json({ bookings: await admin.findBookings(f, actorOf(req)) });
  } catch (e) { next(e); }
});

router.patch('/admin/bookings/:id/contact', requirePermission('booking.contact'),
  async (req, res, next) => {
    try {
      const body = z.object({ contactPhone: z.string().min(10).max(15), reason: REASON }).parse(req.body);
      res.json(await admin.updateBookingContact(
        UUID.parse(req.params.id), body.contactPhone, body.reason, actorOf(req)));
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- requests */

router.get('/admin/requests', requirePermission('notification.read'), async (req, res, next) => {
  try {
    const f = z.object({
      status: z.enum(['PENDING', 'NOTIFIED', 'APPROVED', 'REJECTED']).optional(),
      kind: z.enum(['GET_NOTIFIED', 'STUDENT_ID_CHANGE', 'ACCOUNT_DELETION']).optional(),
    }).parse(req.query);
    res.json({ requests: await admin.listRequests(f, actorOf(req)) });
  } catch (e) { next(e); }
});

/* F-13: the prototype wired this only for GET_NOTIFIED, so ID-change and
 * deletion requests could be read and never resolved. */
router.post('/admin/requests/:id/decide', requirePermission('notification.resolve'),
  async (req, res, next) => {
    try {
      const body = z.object({ decision: z.enum(['approve', 'reject']), reason: REASON }).parse(req.body);
      res.json(await admin.decideRequest(UUID.parse(req.params.id), body.decision, body.reason, actorOf(req)));
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- waitlist */

router.get('/admin/trips/:id/waitlist', requirePermission('waitlist.read'), async (req, res, next) => {
  try { res.json({ entries: await admin.listWaitlist(UUID.parse(req.params.id), actorOf(req)) }); }
  catch (e) { next(e); }
});

router.post('/admin/waitlist/:id/move-to-top', requirePermission('waitlist.reorder'),
  async (req, res, next) => {
    try {
      const reason = REASON.parse(req.body?.reason);
      res.json(await admin.moveWaitlistToTop(UUID.parse(req.params.id), reason, actorOf(req)));
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- reports */

const ReportKind = z.enum(['trips', 'revenue', 'bookings', 'passengers', 'boarding',
  'noshow', 'refunds', 'waitlist']);
const ReportFilter = z.object({
  tripId: UUID.nullish(), from: z.string().nullish(), to: z.string().nullish(),
  status: z.string().max(30).nullish(),
});

router.get('/admin/reports/:kind', requirePermission('report.read'), async (req, res, next) => {
  try {
    const kind = ReportKind.parse(req.params.kind);
    res.json({ report: await admin.report(kind, ReportFilter.parse(req.query), actorOf(req)) });
  } catch (e) { next(e); }
});

router.get('/admin/reports/:kind/export', requirePermission('report.export'),
  async (req, res, next) => {
    try {
      const kind = ReportKind.parse(req.params.kind);
      const out = await admin.exportReport(kind, ReportFilter.parse(req.query), actorOf(req));
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${out.filename}"`);
      res.send(out.csv);
    } catch (e) { next(e); }
  });

/* ---------------------------------------------------------------- audit */

router.get('/admin/audit', requirePermission('audit.read'), async (req, res, next) => {
  try {
    const f = z.object({
      entityType: z.string().max(40).optional(), entityId: z.string().max(64).optional(),
      actorId: UUID.optional(), action: z.string().max(60).optional(),
      from: z.string().optional(), to: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      cursor: z.string().max(32).optional(),
    }).parse(req.query);
    res.json(await readAudit(f));
  } catch (e) { next(e); }
});

/* There is deliberately NO delete route for audit_logs. Migration 001 revokes
 * DELETE and UPDATE on the table, so even an accidental endpoint could not
 * prune it. Admin Spec §9–§10: operational records are never deleted. */

export default router;
