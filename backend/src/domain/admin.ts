/* DLT · domain/admin.ts — operations authority.
 *
 * Phase 3 built these workflows in the prototype; this moves them to the
 * server. Two rules shaped the file:
 *
 *   1. NO DUPLICATED RULES. The refund override and manual bookings live in
 *      domain/payments.ts, already correct and tested, and are re-exported here
 *      rather than reimplemented. Seat blocking, vehicle guards and trip status
 *      live in SQL (008) because their rules are relational and need locks.
 *   2. EVERY function begins with requirePermission against the role in the
 *      DATABASE, read from the session. The admin UI decides which buttons to
 *      draw; it never decides what may happen.
 *
 * WRITTEN, NOT EXECUTED.
 */

import { query, tx } from '../db/index.ts';
import { AppError } from './errors.ts';
import { audit, readAudit } from './audit.ts';
import { requirePermission } from './auth.ts';
import { TRIP_SQL, decorateTrip } from './seats.ts';
import type { Actor } from './authz.ts';

/* One canonical Actor for the whole backend. Two local definitions would drift,
 * and a drifted actor type is how an authorization argument gets dropped. */
export type { Actor } from './authz.ts';

/* Re-exported, NOT reimplemented. Both already enforce their own permission,
 * amount and reason rules and are covered by the payment tests. */
export { overrideRefund, createManualBooking, cancelBooking } from './payments.ts';

function needReason(reason: string | undefined, what: string): string {
  const r = String(reason ?? '').trim();
  if (r.length < 4) throw new AppError('VALIDATION', `A reason is required ${what}`);
  return r;
}

function mapSqlError(e: any): never {
  if (e?.code === '23514' || e?.code === '22023') throw new AppError('VALIDATION', e.message);
  if (e?.code === '23505') throw new AppError('CONFLICT', e.message);
  if (e?.code === 'P0002' || e?.code === '02000') throw new AppError('NOT_FOUND', e.message);
  throw e;
}

/* ---------------------------------------------------------------- seat blocking */

/** §13.4 F-13. Fully implemented in the prototype store and reachable from no
 *  screen; now a real endpoint. */
export async function blockSeat(
  tripId: string, seatNumber: string, reason: string, actor: Actor
) {
  await requirePermission(actor.role, 'seat.block');
  const why = needReason(reason, 'to block a seat');
  return tx(async (c) => {
    try {
      const { rows: [s] } = await c.query('SELECT * FROM block_seat($1,$2,$3,$4)',
        [tripId, seatNumber.toUpperCase(), why, actor.userId]);
      await audit(c, actor, 'seat.blocked', 'trip_seat', s.id, 'AVAILABLE', 'BLOCKED', why);
      return { seatNumber: s.seat_number, status: s.status, reason: s.block_reason };
    } catch (e) { mapSqlError(e); }
  });
}

export async function unblockSeat(tripId: string, seatNumber: string, actor: Actor) {
  await requirePermission(actor.role, 'seat.block');
  return tx(async (c) => {
    try {
      const { rows: [s] } = await c.query('SELECT * FROM unblock_seat($1,$2)',
        [tripId, seatNumber.toUpperCase()]);
      await audit(c, actor, 'seat.unblocked', 'trip_seat', s.id, 'BLOCKED', 'AVAILABLE', null);
      return { seatNumber: s.seat_number, status: s.status };
    } catch (e) { mapSqlError(e); }
  });
}

/* ---------------------------------------------------------------- vehicles */

export async function listVehicles(actor: Actor) {
  await requirePermission(actor.role, 'vehicle.read');
  const { rows } = await query(
    `SELECT v.id, v.name, v.registration, v.row_count AS "rowCount", v.capacity, v.status,
            (SELECT count(*)::int FROM trips t
              WHERE t.vehicle_id = v.id AND t.status IN ('OPEN','BOOKING_CLOSED','BOARDING')) AS "openTrips",
            (SELECT count(*)::int FROM trip_seats ts JOIN trips t ON t.id = ts.trip_id
              WHERE t.vehicle_id = v.id AND ts.status IN ('BOOKED','HELD')
                AND t.status NOT IN ('COMPLETED','CANCELLED')) AS "seatsCommitted"
       FROM vehicles v ORDER BY v.name`);
  /* configLocked tells the UI why the seat-configuration field is disabled,
   * rather than letting an operator try and be refused. */
  return rows.map((v: any) => ({ ...v, configLocked: v.seatsCommitted > 0 }));
}

/** §4 / FR-015 F-14. The prototype's console called saveVehicle with nothing but
 *  a status; the guard against renumbering sold seats was unreachable. */
export async function saveVehicle(input: {
  id?: string | null; name: string; registration: string;
  rowCount?: number | null; status?: string | null;
}, actor: Actor) {
  await requirePermission(actor.role, 'vehicle.write');
  return tx(async (c) => {
    const before = input.id
      ? (await c.query('SELECT name, registration, row_count, status FROM vehicles WHERE id=$1',
          [input.id])).rows[0]
      : null;
    try {
      const { rows: [v] } = await c.query('SELECT * FROM save_vehicle($1,$2,$3,$4,$5::vehicle_status)',
        [input.id ?? null, input.name, input.registration,
         input.rowCount ?? null, input.status ?? null]);
      await audit(c, actor, input.id ? 'vehicle.updated' : 'vehicle.created', 'vehicle', v.id,
        before ? `${before.name} ${before.registration} ${before.row_count} rows ${before.status}` : null,
        `${v.name} ${v.registration} ${v.row_count} rows ${v.status}`, null);
      return { id: v.id, name: v.name, registration: v.registration,
        rowCount: v.row_count, capacity: v.capacity, status: v.status };
    } catch (e) { mapSqlError(e); }
  });
}

/* ---------------------------------------------------------------- trips */

export async function saveTrip(input: {
  id?: string | null; routeId: string; vehicleId: string;
  departureAt: string; price: number;
}, actor: Actor) {
  await requirePermission(actor.role, 'trip.write');
  if (!(Number(input.price) >= 0))
    throw new AppError('VALIDATION', 'Enter a fare');
  if (new Date(input.departureAt).getTime() < Date.now() - 3600_000)
    throw new AppError('VALIDATION', 'A departure cannot be in the past');

  return tx(async (c) => {
    if (input.id) {
      const { rows: [before] } = await c.query(
        'SELECT * FROM trips WHERE id=$1 FOR UPDATE', [input.id]);
      if (!before) throw new AppError('NOT_FOUND', 'Trip not found');
      /* A vehicle change rebuilds the seat map, which materialise_trip_seats
       * refuses while seats are held or booked. */
      const { rows: [t] } = await c.query(
        `UPDATE trips SET route_id=$2, vehicle_id=$3, departure_at=$4, price=$5, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [input.id, input.routeId, input.vehicleId, input.departureAt, input.price]);
      if (before.vehicle_id !== input.vehicleId) {
        try { await c.query('SELECT materialise_trip_seats($1)', [t.id]); }
        catch (e) { mapSqlError(e); }
      }
      await audit(c, actor, 'trip.updated', 'trip', t.id,
        `${before.departure_at} ₹${before.price}`, `${t.departure_at} ₹${t.price}`, null);
      return t;
    }
    const { rows: [t] } = await c.query(
      `INSERT INTO trips (route_id, vehicle_id, departure_at, price, status)
       VALUES ($1,$2,$3,$4,'DRAFT') RETURNING *`,
      [input.routeId, input.vehicleId, input.departureAt, input.price]);
    await c.query('SELECT materialise_trip_seats($1)', [t.id]);
    await audit(c, actor, 'trip.created', 'trip', t.id, null,
      `${t.departure_at} ₹${t.price}`, null);
    return t;
  });
}

/** DRAFT → OPEN. Separated from saveTrip because publishing is the moment a
 *  trip becomes sellable and deserves its own permission and audit line. */
export async function publishTrip(tripId: string, actor: Actor) {
  await requirePermission(actor.role, 'trip.publish');
  return tx(async (c) => {
    const { rows: [t] } = await c.query('SELECT * FROM trips WHERE id=$1 FOR UPDATE', [tripId]);
    if (!t) throw new AppError('NOT_FOUND', 'Trip not found');
    if (t.status !== 'DRAFT') throw new AppError('CONFLICT', `That trip is already ${t.status}`);
    if (!t.vehicle_id) throw new AppError('VALIDATION', 'Assign a vehicle before publishing');
    const { rows: [seats] } = await c.query(
      'SELECT count(*)::int n FROM trip_seats WHERE trip_id=$1', [tripId]);
    if (!seats.n) throw new AppError('VALIDATION', 'That trip has no seat map');

    await c.query(`UPDATE trips SET status='OPEN', updated_at=now() WHERE id=$1`, [tripId]);
    await audit(c, actor, 'trip.published', 'trip', tripId, 'DRAFT', 'OPEN', null);
    return { id: tripId, status: 'OPEN', seats: seats.n };
  });
}

/** F-23: pins one transition, not the trip forever. */
export async function setTripStatus(
  tripId: string, status: string, reason: string, actor: Actor
) {
  await requirePermission(actor.role, 'trip.status');
  const why = needReason(reason, 'to change a trip status by hand');
  return tx(async (c) => {
    const { rows: [before] } = await c.query('SELECT status FROM trips WHERE id=$1', [tripId]);
    if (!before) throw new AppError('NOT_FOUND', 'Trip not found');
    try {
      const { rows: [t] } = await c.query(
        'SELECT * FROM set_trip_status($1,$2::trip_status,$3,$4)', [tripId, status, why, actor.userId]);
      await audit(c, actor, 'trip.status_changed', 'trip', tripId, before.status, t.status, why);
      return { id: t.id, status: t.status, pinnedUntil: t.pinned_until };
    } catch (e) { mapSqlError(e); }
  });
}

/** Cancels a trip, refunds every confirmed booking on it, releases the seats.
 *  Refunds are capped by money received per booking (F-05) and dispatched by
 *  the refund job — never invented here. */
export async function cancelTrip(tripId: string, reason: string, actor: Actor) {
  await requirePermission(actor.role, 'trip.cancel');
  const why = needReason(reason, 'to cancel a departure');
  return tx(async (c) => {
    const { rows: [t] } = await c.query('SELECT * FROM trips WHERE id=$1 FOR UPDATE', [tripId]);
    if (!t) throw new AppError('NOT_FOUND', 'Trip not found');
    if (t.status === 'CANCELLED') throw new AppError('CONFLICT', 'That departure is already cancelled');

    const { rows: bookings } = await c.query(
      `SELECT b.id, b.code, m.refundable FROM bookings b
         JOIN booking_money m ON m.booking_id = b.id
        WHERE b.trip_id = $1 AND b.status = 'CONFIRMED'`, [tripId]);

    let refunded = 0, affected = 0;
    for (const b of bookings) {
      if (b.refundable > 0) {
        await c.query(
          `INSERT INTO refunds (booking_id, amount, reason, requested_by)
           VALUES ($1,$2,$3,$4)`,
          [b.id, b.refundable, `Departure cancelled: ${why}`, actor.userId]);
        refunded += b.refundable;
      }
      await c.query('SELECT release_booking_seats($1,$2)', [b.id, 'CANCELLED_BY_DLT']);
      affected++;
    }

    await c.query(
      `UPDATE trips SET status='CANCELLED', cancel_reason=$2, pinned_status='CANCELLED',
              updated_at=now() WHERE id=$1`, [tripId, why]);
    /* Every waiting student is released too — there is nothing to wait for. */
    await c.query(
      `UPDATE waitlist_entries SET status='CANCELLED', reserved_seat_id=NULL, updated_at=now()
        WHERE trip_id=$1 AND status IN ('WAITING','CLAIM_OFFERED')`, [tripId]);

    await audit(c, actor, 'trip.cancelled', 'trip', tripId, t.status, 'CANCELLED', why);
    return { cancelled: true, bookingsAffected: affected, refundTotal: refunded };
  });
}

/** F-22: the affected-passenger list for a cancelled trip, scoped to THAT trip.
 *  The prototype's export passed tripId: null and returned every passenger in
 *  the system. */
export async function affectedPassengers(tripId: string, actor: Actor) {
  await requirePermission(actor.role, 'report.export');
  const { rows } = await query(
    `SELECT bp.name, bp.student_id AS "studentId", bp.phone, bp.seat_number AS "seatNumber",
            b.code AS "bookingCode", b.contact_phone AS "contactPhone",
            m.received, m.returned
       FROM booking_passengers bp
       JOIN bookings b ON b.id = bp.booking_id
       JOIN booking_money m ON m.booking_id = b.id
      WHERE b.trip_id = $1
      ORDER BY bp.seat_row_order, bp.seat_number`, [tripId]);
  return rows;
}

/* ---------------------------------------------------------------- staff */

/** F-19. The assignment the scanner and the manifest both derive from. */
export async function assignStaff(
  tripId: string, staffUserId: string, reason: string | undefined, actor: Actor
) {
  await requirePermission(actor.role, 'staff.assign');
  return tx(async (c) => {
    const { rows: [u] } = await c.query('SELECT id, name, role, status FROM users WHERE id=$1',
      [staffUserId]);
    if (!u) throw new AppError('NOT_FOUND', 'That account does not exist');
    if (u.role !== 'BOARDING_STAFF')
      throw new AppError('VALIDATION', 'Choose a boarding staff account');
    if (u.status !== 'ACTIVE') throw new AppError('VALIDATION', 'That staff account is not active');
    const { rows: [t] } = await c.query('SELECT id, status FROM trips WHERE id=$1', [tripId]);
    if (!t) throw new AppError('NOT_FOUND', 'Trip not found');
    if (t.status === 'CANCELLED')
      throw new AppError('CONFLICT', 'That departure is cancelled');

    await c.query(
      `INSERT INTO trip_staff (trip_id, user_id, assigned_by, reason)
       VALUES ($1,$2,$3,$4) ON CONFLICT (trip_id, user_id) DO NOTHING`,
      [tripId, staffUserId, actor.userId, reason ?? null]);
    /* A new assignment revokes their sessions, so a scanner already open cannot
     * keep operating against the old scope. */
    await c.query('SELECT revoke_user_sessions($1,$2)', [staffUserId, 'trip assignment changed']);
    await audit(c, actor, 'staff.assigned', 'trip', tripId, null, u.name, reason ?? null);
    return { assigned: true, staff: u.name };
  });
}

export async function unassignStaff(tripId: string, staffUserId: string, actor: Actor) {
  await requirePermission(actor.role, 'staff.assign');
  return tx(async (c) => {
    const { rowCount } = await c.query(
      'DELETE FROM trip_staff WHERE trip_id=$1 AND user_id=$2', [tripId, staffUserId]);
    if (!rowCount) throw new AppError('NOT_FOUND', 'That staff member is not assigned to this trip');
    await c.query('SELECT revoke_user_sessions($1,$2)', [staffUserId, 'trip assignment removed']);
    await audit(c, actor, 'staff.unassigned', 'trip', tripId, staffUserId, null, null);
    return { unassigned: true };
  });
}

export async function listStaff(actor: Actor) {
  await requirePermission(actor.role, 'staff.assign');
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.status,
            (SELECT json_agg(json_build_object('tripId', t.id, 'departureAt', t.departure_at))
               FROM trip_staff ts JOIN trips t ON t.id = ts.trip_id
              WHERE ts.user_id = u.id AND t.status NOT IN ('COMPLETED','CANCELLED')) AS assignments
       FROM users u WHERE u.role = 'BOARDING_STAFF' ORDER BY u.name`);
  return rows;
}

/* ---------------------------------------------------------------- bookings */

/** §14.3 F-13. Built in the store, reachable from nowhere. */
export async function updateBookingContact(
  bookingId: string, contactPhone: string, reason: string, actor: Actor
) {
  await requirePermission(actor.role, 'booking.contact');
  const why = needReason(reason, 'to change a booking contact');
  const phone = String(contactPhone ?? '').replace(/\s/g, '');
  if (!/^[6-9]\d{9}$/.test(phone))
    throw new AppError('VALIDATION', 'Enter a valid Indian mobile number');

  return tx(async (c) => {
    const { rows: [b] } = await c.query(
      'SELECT id, code, contact_phone FROM bookings WHERE id=$1 FOR UPDATE', [bookingId]);
    if (!b) throw new AppError('NOT_FOUND', 'Booking not found');
    await c.query('UPDATE bookings SET contact_phone=$2, updated_at=now() WHERE id=$1',
      [bookingId, phone]);
    await audit(c, actor, 'booking.contact_changed', 'booking', bookingId,
      b.contact_phone, phone, why);
    return { code: b.code, contactPhone: phone };
  });
}

/** Console copy promises "booking ID, boarding code, name, student ID or
 *  phone" — the name/student ID half needs booking_passengers, not just the
 *  booking row, since a booking's own columns carry neither. ownerName is
 *  the registered user's name where there is one (a MANUAL or guest-checkout
 *  booking has none — b.user_id is nullable), so a search-result label can
 *  show who a booking belongs to instead of just its code. */
export async function findBookings(f: {
  q?: string; tripId?: string; status?: string; from?: string; to?: string; limit?: number;
}, actor: Actor) {
  await requirePermission(actor.role, 'booking.read');
  const { rows } = await query(
    `SELECT b.id, b.code, b.boarding_code AS "boardingCode", b.status, b.kind,
            b.total_amount AS "totalAmount", b.contact_phone AS "contactPhone",
            b.created_at AS "createdAt", t.departure_at AS "departureAt",
            u.name AS "ownerName",
            m.received, m.returned, m.refundable,
            (SELECT count(*)::int FROM booking_passengers bp WHERE bp.booking_id = b.id) AS seats
       FROM bookings b
       JOIN trips t ON t.id = b.trip_id
       JOIN booking_money m ON m.booking_id = b.id
       LEFT JOIN users u ON u.id = b.user_id
      WHERE ($1::text IS NULL OR upper(b.code) LIKE '%' || upper($1) || '%'
                              OR upper(b.boarding_code) LIKE '%' || upper($1) || '%'
                              OR b.contact_phone LIKE '%' || $1 || '%'
                              OR EXISTS (SELECT 1 FROM booking_passengers bp WHERE bp.booking_id = b.id
                                           AND (bp.name ILIKE '%' || $1 || '%'
                                             OR upper(bp.student_id) LIKE '%' || upper($1) || '%')))
        AND ($2::uuid IS NULL OR b.trip_id = $2)
        AND ($3::text IS NULL OR b.status::text = $3)
        AND ($4::timestamptz IS NULL OR t.departure_at >= $4)
        AND ($5::timestamptz IS NULL OR t.departure_at <= $5)
      ORDER BY b.created_at DESC LIMIT $6`,
    [f.q ?? null, f.tripId ?? null, f.status ?? null, f.from ?? null, f.to ?? null,
     Math.min(Number(f.limit ?? 100), 500)]);
  return rows;
}

/* ---------------------------------------------------------------- requests
 *
 * §8.1 / §8.3 F-13. The prototype listed ID-change and deletion requests and
 * wired the action button only for GET_NOTIFIED, so they could be read and
 * never resolved.
 */

export async function listRequests(f: { status?: string; kind?: string }, actor: Actor) {
  await requirePermission(actor.role, 'notification.read');
  const { rows } = await query(
    `SELECT r.id, r.kind, r.status, r.email, r.requested_value AS "requestedValue",
            r.current_value AS "currentValue", r.reason, r.created_at AS "createdAt",
            r.decision_reason AS "decisionReason", r.decided_at AS "decidedAt",
            u.name AS "userName", u.email AS "userEmail",
            t.departure_at AS "tripDepartureAt"
       FROM notification_requests r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN trips t ON t.id = r.trip_id
      WHERE ($1::text IS NULL OR r.status::text = $1)
        AND ($2::text IS NULL OR r.kind::text = $2)
      ORDER BY r.created_at DESC LIMIT 200`,
    [f.status ?? 'PENDING', f.kind ?? null]);
  return rows;
}

/** One decision path for all three request kinds, with the side effect each kind
 *  actually needs — approving an ID change must change the ID, and approving a
 *  deletion must anonymise the account. A decision that only sets a status
 *  would be theatre. */
export async function decideRequest(
  requestId: string, decision: 'approve' | 'reject', reason: string, actor: Actor
) {
  await requirePermission(actor.role, 'notification.resolve');
  const why = needReason(reason, 'to decide a request');
  if (!['approve', 'reject'].includes(decision))
    throw new AppError('VALIDATION', 'Choose approve or reject');

  return tx(async (c) => {
    const { rows: [r] } = await c.query(
      'SELECT * FROM notification_requests WHERE id=$1 FOR UPDATE', [requestId]);
    if (!r) throw new AppError('NOT_FOUND', 'Request not found');
    if (r.status !== 'PENDING')
      throw new AppError('CONFLICT', `That request is already ${r.status.toLowerCase()}`);

    const approved = decision === 'approve';
    let effect: string | null = null;

    if (approved && r.kind === 'STUDENT_ID_CHANGE') {
      if (!r.requested_value)
        throw new AppError('VALIDATION', 'That request carries no new student ID');
      try {
        await c.query(
          `UPDATE student_profiles SET student_id=$2, updated_at=now() WHERE user_id=$1`,
          [r.user_id, r.requested_value]);
      } catch (e: any) {
        if (e.code === '23505')
          throw new AppError('CONFLICT', `Student ID ${r.requested_value} is already in use`);
        throw e;
      }
      effect = `student ID → ${r.requested_value}`;
    }

    if (approved && r.kind === 'ACCOUNT_DELETION') {
      /* §8.3. The row is retained because financial and boarding records
       * reference it; the identity is removed. Sessions die immediately. */
      const { rows: [future] } = await c.query(
        `SELECT count(*)::int n FROM bookings b JOIN trips t ON t.id = b.trip_id
          WHERE b.user_id=$1 AND b.status='CONFIRMED' AND t.departure_at > now()`, [r.user_id]);
      if (future.n)
        throw new AppError('CONFLICT',
          `That account has ${future.n} upcoming confirmed booking(s). Cancel them first.`);
      await c.query(
        `UPDATE users SET status='DELETED', name='Deleted account',
                email = 'deleted+' || id::text || '@dlt.invalid',
                phone = NULL, updated_at = now() WHERE id=$1`, [r.user_id]);
      await c.query('DELETE FROM user_credentials WHERE user_id=$1', [r.user_id]);
      await c.query(`UPDATE student_profiles SET emergency_contact_name=NULL,
                            emergency_contact_phone=NULL WHERE user_id=$1`, [r.user_id]);
      await c.query('SELECT revoke_user_sessions($1,$2)', [r.user_id, 'account deleted']);
      effect = 'account anonymised, sessions revoked';
    }

    await c.query(
      `UPDATE notification_requests
          SET status=$2, decided_at=now(), decided_by=$3, decision_reason=$4
        WHERE id=$1`,
      [requestId, approved ? 'APPROVED' : 'REJECTED', actor.userId, why]);

    await audit(c, actor, `request.${decision}d`, 'notification_request', requestId,
      'PENDING', approved ? `APPROVED${effect ? ' · ' + effect : ''}` : 'REJECTED', why);
    return { decided: decision, kind: r.kind, effect };
  });
}

/* ---------------------------------------------------------------- waitlist */

export async function listWaitlist(tripId: string, actor: Actor) {
  await requirePermission(actor.role, 'waitlist.read');
  const { rows } = await query(
    `SELECT w.id, w.position, w.status, w.seats_wanted AS "seatsWanted",
            w.offer_expires_at AS "offerExpiresAt", w.created_at AS "createdAt",
            u.name, u.email, sp.student_id AS "studentId", ts.seat_number AS "reservedSeat"
       FROM waitlist_entries w
       JOIN users u ON u.id = w.user_id
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
       LEFT JOIN trip_seats ts ON ts.id = w.reserved_seat_id
      WHERE w.trip_id = $1 AND w.status IN ('WAITING','CLAIM_OFFERED','CLAIMED')
      ORDER BY w.position, w.created_at`, [tripId]);
  return rows;
}

export async function moveWaitlistToTop(entryId: string, reason: string, actor: Actor) {
  await requirePermission(actor.role, 'waitlist.reorder');
  const why = needReason(reason, 'to reorder the waitlist');
  return tx(async (c) => {
    const { rows: [e] } = await c.query(
      'SELECT * FROM waitlist_entries WHERE id=$1 FOR UPDATE', [entryId]);
    if (!e) throw new AppError('NOT_FOUND', 'Waitlist entry not found');
    if (e.status !== 'WAITING')
      throw new AppError('CONFLICT', `That entry is ${e.status.toLowerCase()}, not waiting`);
    /* Same race joinWaitlist had (seats.ts): reading min(position) with no
     * lock lets two concurrent reorders on the same trip compute the same
     * "top" before either commits. Locking the trip row serialises them —
     * the same technique used throughout this file for trip mutations. */
    await c.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [e.trip_id]);
    const { rows: [min] } = await c.query(
      'SELECT COALESCE(min(position),1) - 1 AS top FROM waitlist_entries WHERE trip_id=$1', [e.trip_id]);
    try {
      await c.query('UPDATE waitlist_entries SET position=$2, updated_at=now() WHERE id=$1',
        [entryId, min.top]);
    } catch (err: any) {
      if (err.code === '23505') throw new AppError('CONFLICT', 'Could not reorder the waitlist — try again.');
      throw err;
    }
    await audit(c, actor, 'waitlist.reordered', 'waitlist_entry', entryId,
      `position ${e.position}`, `position ${min.top}`, why);
    return { position: min.top };
  });
}

/* ---------------------------------------------------------------- reports
 *
 * F-22. Filters are applied in the SQL that produces the numbers, so a filter
 * that is shown is a filter that applies. No caller supplies or sums a total.
 */

export type ReportKind = 'trips' | 'revenue' | 'bookings' | 'passengers' | 'boarding' | 'noshow' | 'refunds' | 'waitlist';

export interface ReportFilter { tripId?: string | null; from?: string | null; to?: string | null; status?: string | null }

export async function report(kind: ReportKind, f: ReportFilter, actor: Actor) {
  await requirePermission(actor.role, 'report.read');
  const args = [f.tripId ?? null, f.from ?? null, f.to ?? null];
  const scope = `($1::uuid IS NULL OR t.id = $1)
             AND ($2::timestamptz IS NULL OR t.departure_at >= $2)
             AND ($3::timestamptz IS NULL OR t.departure_at <= $3)`;

  switch (kind) {
    case 'trips':
      return (await query(
        `SELECT s.* FROM report_trip_summary s JOIN trips t ON t.id = s.trip_id
          WHERE ${scope} ORDER BY t.departure_at DESC`, args)).rows;

    case 'revenue': {
      const { rows } = await query(
        `SELECT r.* FROM report_revenue r JOIN trips t ON t.id = r.trip_id
          WHERE ${scope} ORDER BY t.departure_at DESC`, args);
      /* Totals computed here, from the same rows — never accepted from a client
       * and never added up in a browser. */
      const totals = rows.reduce((a: any, x: any) => ({
        gross: a.gross + x.gross_rupees,
        refunded: a.refunded + x.refunded_rupees,
        net: a.net + x.net_rupees,
      }), { gross: 0, refunded: 0, net: 0 });
      return { rows, totals };
    }

    case 'bookings':
      /* F-22: the prototype's bookings report ignored tripId entirely while the
       * UI presented the trip selector as applying to it. */
      return (await query(
        `SELECT b.code, b.status, b.kind, b.total_amount AS "totalAmount",
                b.created_at AS "createdAt", t.departure_at AS "departureAt",
                m.received, m.returned,
                (SELECT count(*)::int FROM booking_passengers bp WHERE bp.booking_id=b.id) AS seats
           FROM bookings b JOIN trips t ON t.id = b.trip_id
           JOIN booking_money m ON m.booking_id = b.id
          WHERE ${scope} AND ($4::text IS NULL OR b.status::text = $4)
          ORDER BY b.created_at DESC`, [...args, f.status ?? null])).rows;

    case 'passengers':
      return (await query(
        `SELECT t.departure_at AS "departureAt", bp.name, bp.student_id AS "studentId",
                bp.seat_number AS "seatNumber", bp.boarding_status AS "boardingStatus",
                b.code AS "bookingCode",
                CASE WHEN $4::text = 'BOARDING_STAFF' THEN NULL ELSE bp.phone END AS phone
           FROM booking_passengers bp
           JOIN bookings b ON b.id = bp.booking_id
           JOIN trips t ON t.id = b.trip_id
          WHERE ${scope} AND b.status = 'CONFIRMED'
          ORDER BY t.departure_at DESC, bp.seat_row_order`, [...args, actor.role])).rows;

    case 'boarding':
    case 'noshow':
      return (await query(
        `SELECT t.departure_at AS "departureAt", bp.name, bp.seat_number AS "seatNumber",
                bp.boarding_status AS "boardingStatus", b.code AS "bookingCode",
                (SELECT max(e.occurred_at) FROM boarding_events e
                  WHERE e.passenger_id = bp.id AND e.result='VALID') AS "boardedAt"
           FROM booking_passengers bp
           JOIN bookings b ON b.id = bp.booking_id
           JOIN trips t ON t.id = b.trip_id
          WHERE ${scope} AND b.status='CONFIRMED'
            AND ($4::boolean IS FALSE OR bp.boarding_status = 'NO_SHOW')
          ORDER BY t.departure_at DESC, bp.seat_row_order`,
        [...args, kind === 'noshow'])).rows;

    case 'refunds':
      return (await query(
        `SELECT b.code, rf.amount, rf.status, rf.is_override AS "isOverride", rf.reason,
                rf.provider_refund_id AS "providerRefundId", rf.provider_status AS "providerStatus",
                rf.created_at AS "createdAt", u.name AS "requestedBy",
                t.departure_at AS "departureAt"
           FROM refunds rf
           JOIN bookings b ON b.id = rf.booking_id
           JOIN trips t ON t.id = b.trip_id
           LEFT JOIN users u ON u.id = rf.requested_by
          WHERE ${scope} ORDER BY rf.created_at DESC`, args)).rows;

    case 'waitlist':
      return (await query(
        `SELECT t.departure_at AS "departureAt", u.name, w.position, w.status,
                w.seats_wanted AS "seatsWanted", w.created_at AS "createdAt"
           FROM waitlist_entries w
           JOIN trips t ON t.id = w.trip_id
           JOIN users u ON u.id = w.user_id
          WHERE ${scope} ORDER BY t.departure_at DESC, w.position`, args)).rows;

    default:
      throw new AppError('VALIDATION', 'Unknown report');
  }
}

/** CSV export. Separate permission from reading: seeing a total on screen and
 *  walking out with a passenger list are different acts. */
export async function exportReport(kind: ReportKind, f: ReportFilter, actor: Actor) {
  await requirePermission(actor.role, 'report.export');
  const data = await report(kind, f, actor);
  const rows: any[] = Array.isArray(data) ? data : (data as any).rows;
  if (!rows.length) return { filename: `dlt-${kind}.csv`, csv: '' };

  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  await tx(c => audit(c, actor, 'report.exported', 'report', kind, null,
    `${rows.length} rows`, null));
  return { filename: `dlt-${kind}-${new Date().toISOString().slice(0, 10)}.csv`, csv };
}

/* ---------------------------------------------------------------- alerts */

export async function operationalAlerts(actor: Actor) {
  await requirePermission(actor.role, 'booking.read');
  const { rows } = await query(
    `SELECT kind, subject_id AS "subjectId", subject, detail, severity, since
       FROM operational_alerts ORDER BY
         CASE severity WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, since`);
  return rows;
}

/** The operations home view. Every figure from the authoritative rows. */
export async function today(actor: Actor) {
  await requirePermission(actor.role, 'trip.read');
  const { rows: trips } = await query(
    `SELECT s.* FROM report_trip_summary s
      WHERE s.departure_at BETWEEN now() - interval '6 hours' AND now() + interval '18 hours'
      ORDER BY s.departure_at`);
  const { rows: [alerts] } = await query(
    `SELECT count(*) FILTER (WHERE severity='P0')::int AS p0,
            count(*) FILTER (WHERE severity='P1')::int AS p1 FROM operational_alerts`);
  return { trips, alerts };
}

/* Known operational_alerts kinds (migration 008's UNION ALL, read verbatim —
 * not guessed). An unmapped kind still renders, under its own raw name,
 * rather than being silently dropped. */
const ALERT_LABELS: Record<string, { title: string; section: string }> = {
  LATE_SETTLEMENT: { title: 'Late settlement', section: 'Bookings' },
  REFUND_STUCK: { title: 'Refund stuck', section: 'Payments' },
  WEBHOOK_UNPROCESSED: { title: 'Webhook unprocessed', section: 'Payments' },
  BAD_SIGNATURE: { title: 'Webhook signature failed', section: 'Payments' },
  NO_STAFF_ASSIGNED: { title: 'No staff assigned', section: 'Boarding' },
  OFFER_EXPIRING: { title: 'Waitlist offer expiring', section: 'Waitlist' },
};

/** The dashboard's summary tiles, alerts and activity feed — every figure
 *  summed from report_trip_summary's already-correct per-trip rows (the same
 *  view today() reads), never recomputed by a caller. */
export async function dashboardSummary(actor: Actor) {
  await requirePermission(actor.role, 'trip.read');
  const { rows: trips } = await query(
    `SELECT s.* FROM report_trip_summary s
      WHERE s.departure_at BETWEEN now() - interval '6 hours' AND now() + interval '18 hours'
      ORDER BY s.departure_at`);

  const byStatus: Record<string, number> = {};
  let passengers = 0, seatsSold = 0, capacity = 0, revenue = 0, refundToday = 0, boarded = 0;
  for (const t of trips as any[]) {
    byStatus[t.trip_status] = (byStatus[t.trip_status] ?? 0) + 1;
    passengers += t.passengers; seatsSold += t.seats_booked; capacity += t.capacity;
    revenue += t.gross_rupees; refundToday += t.refunded_rupees; boarded += t.boarded;
  }
  const occupancy = capacity ? Math.round((seatsSold / capacity) * 100) : 0;
  const tripsTodayDetail = Object.entries(byStatus)
    .map(([s, n]) => `${n} ${s.toLowerCase().replace(/_/g, ' ')}`).join(', ') || 'none scheduled';

  let alertRows: Awaited<ReturnType<typeof operationalAlerts>> = [];
  try { alertRows = await operationalAlerts(actor); } catch { alertRows = []; }
  const alerts = alertRows
    .filter((a: any) => a.severity !== 'P2')
    .map((a: any) => ({
      kind: a.kind, title: ALERT_LABELS[a.kind]?.title ?? a.kind, detail: a.detail,
      cta: 'Review', section: ALERT_LABELS[a.kind]?.section ?? 'Dashboard',
    }));

  const { entries } = await readAudit({ limit: 8 });
  const activity = entries.map((e: any) => ({
    at: e.occurredAt,
    text: `${e.actorName ?? 'system'} · ${e.action}${e.reason ? ' — ' + e.reason : ''}`,
  }));

  return { tripsToday: trips.length, tripsTodayDetail, passengers, seatsSold, capacity,
    occupancy, revenue, refundToday, boarded, alerts, activity };
}

/** The route picker a new trip draft needs. This is a single-route product
 *  today (Woxsen → Miyapur) but saveTrip's contract takes a routeId, and
 *  nothing previously exposed one — the console's "New trip" form has no
 *  route selector at all because there has only ever been the one row. */
export async function listRoutes(actor: Actor) {
  await requirePermission(actor.role, 'trip.read');
  const { rows } = await query(
    `SELECT id, code, origin, destination, duration_min AS "durationMin" FROM routes ORDER BY origin`);
  return rows;
}

/* ---------------------------------------------------------------- trip listing
 *
 * Migrating the Admin console off dlt-store.js surfaced this gap: the public
 * /trips list (seats.listTrips) is deliberately narrow — only what a student
 * may book — so operations had nowhere to see a DRAFT being built or a
 * CANCELLED departure in its own history. Same projection as the public list
 * (seats.TRIP_SQL / decorateTrip — NO DUPLICATED RULES), every status, plus
 * the two figures only operations needs: net revenue and the waitlist count.
 */
export async function listAllTrips(actor: Actor) {
  await requirePermission(actor.role, 'trip.read');
  const { rows } = await query(`${TRIP_SQL} ORDER BY t.departure_at DESC LIMIT 500`);
  const { rows: extra } = await query(
    `SELECT t.id::text AS id,
            (SELECT COALESCE(sum(p.amount),0)::int FROM payments p JOIN bookings b ON b.id = p.booking_id
              WHERE b.trip_id = t.id AND p.status = 'SUCCESS')
            - (SELECT COALESCE(sum(rf.amount),0)::int FROM refunds rf JOIN bookings b ON b.id = rf.booking_id
              WHERE b.trip_id = t.id AND rf.status <> 'REFUND_FAILED') AS revenue,
            (SELECT count(*)::int FROM waitlist_entries w WHERE w.trip_id = t.id
              AND w.status IN ('WAITING','CLAIM_OFFERED')) AS "waitlistCount"
       FROM trips t`);
  const byId = new Map(extra.map((e: any) => [e.id, e]));
  return rows.map((r: any) => {
    const t = decorateTrip(r);
    const e = byId.get(t.id) ?? { revenue: 0, waitlistCount: 0 };
    return { ...t, revenue: e.revenue, waitlistCount: e.waitlistCount,
      staffUserIds: t.assignedStaff.map((s: any) => s.id) };
  });
}

/** Read-only. Runs the same checks publishTrip() enforces, without mutating,
 *  so the console can show "ready to publish" or exactly what is missing
 *  before an operator commits. publishTrip still re-checks everything itself
 *  on the actual transition — this is a preview, never the authority. */
export async function validateTripDraft(tripId: string, actor: Actor) {
  await requirePermission(actor.role, 'trip.read');
  const { rows: [t] } = await query('SELECT * FROM trips WHERE id = $1', [tripId]);
  if (!t) throw new AppError('NOT_FOUND', 'Trip not found');
  const problems: string[] = [];
  const checks: string[] = [];

  if (t.status !== 'DRAFT') problems.push(`This trip is ${t.status}, not a draft.`);
  else checks.push('Status is DRAFT.');

  if (!t.vehicle_id) problems.push('No vehicle is assigned.');
  else checks.push('A vehicle is assigned.');

  const { rows: [seats] } = await query(
    'SELECT count(*)::int n FROM trip_seats WHERE trip_id = $1', [tripId]);
  if (!seats.n) problems.push('The trip has no seat map.');
  else checks.push(`${seats.n} seats mapped.`);

  if (new Date(t.departure_at).getTime() < Date.now())
    problems.push('The departure time is in the past.');
  else checks.push('The departure time is in the future.');

  return { valid: problems.length === 0, problems, checks };
}

/* ---------------------------------------------------------------- booking detail
 *
 * findBookings() (above) is the search list — one row per booking, cheap to
 * scan. This is the drill-down the console's tabs need: owner, the trip's
 * vehicle, every passenger with how and by whom they boarded, the payment,
 * every refund. Built once here rather than reusing payments.ts's
 * student-facing BOOKING_SQL, which is deliberately narrower (no owner
 * identity, no staff/method on a boarding, no admin-only audit trail).
 */
export async function bookingDetail(id: string, actor: Actor) {
  await requirePermission(actor.role, 'booking.read');
  const { rows: [b] } = await query(
    `SELECT b.id, b.code, b.boarding_code AS "boardingCode", b.status,
            b.kind AS "bookingType", b.total_amount AS "totalAmount",
            b.contact_phone AS "contactPhone", b.created_at AS "createdAt",
            json_build_object('id', u.id, 'name', u.name, 'studentId', sp.student_id) AS owner,
            json_build_object(
              'departureAt', t.departure_at, 'status', t.status,
              'vehicle', CASE WHEN v.id IS NULL THEN NULL ELSE
                json_build_object('name', v.name, 'registration', v.registration) END) AS trip,
            m.received, m.returned, m.refundable,
            COALESCE(rf.rows, '[]'::json) AS refunds,
            (SELECT row_to_json(x) FROM (
               SELECT p.id, p.status, p.amount, p.provider,
                      p.provider_reference AS "providerReference",
                      p.updated_at AS "updatedAt"
                 FROM payments p WHERE p.booking_id = b.id
                ORDER BY CASE p.status WHEN 'SUCCESS' THEN 0 ELSE 1 END, p.created_at DESC
                LIMIT 1) x) AS payment,
            COALESCE(pax.rows, '[]'::json) AS passengers
       FROM bookings b
       JOIN trips t ON t.id = b.trip_id
       LEFT JOIN vehicles v ON v.id = t.vehicle_id
       JOIN users u ON u.id = b.user_id
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
       JOIN booking_money m ON m.booking_id = b.id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('amount', r.amount, 'status', r.status,
                'createdAt', r.created_at) ORDER BY r.created_at) AS rows
           FROM refunds r WHERE r.booking_id = b.id) rf ON true
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
              'id', bp.id, 'name', bp.name, 'studentId', bp.student_id, 'phone', bp.phone,
              'seatNumber', bp.seat_number, 'boardingStatus', bp.boarding_status,
              'boardedAt', ev.occurred_at, 'boardingMethod', ev.method,
              'boardedBy', su.name, 'boardingReason', ev.reason,
              'passStatus', pass.status)
            ORDER BY bp.seat_row_order, bp.seat_number) AS rows
           FROM booking_passengers bp
           LEFT JOIN boarding_passes pass ON pass.passenger_id = bp.id
           LEFT JOIN LATERAL (
             SELECT * FROM boarding_events e WHERE e.passenger_id = bp.id
              ORDER BY e.occurred_at DESC LIMIT 1) ev ON true
           LEFT JOIN users su ON su.id = ev.staff_user_id
          WHERE bp.booking_id = b.id) pax ON true
      WHERE b.id = $1`, [id]);
  if (!b) throw new AppError('NOT_FOUND', 'Booking not found');

  const refundedTotal = (b.refunds as { amount: number; status: string }[])
    .filter(r => r.status !== 'REFUND_FAILED')
    .reduce((n, r) => n + r.amount, 0);

  /* The console's own copy calls this "Super Admin only" — a narrower gate
   * than booking.read (which OPS_ADMIN also holds), kept exactly as stated
   * rather than loosened on my own inference. OPS_ADMIN still reaches the
   * same entries through the general Audit section (audit.read), which it
   * also holds; this only keeps them out of the inline per-booking view. */
  let auditTrail: unknown[] = [];
  if (actor.role === 'SUPER_ADMIN') {
    auditTrail = (await readAudit({ entityId: id, limit: 50 })).entries;
  }

  return { ...b, refundedTotal, auditTrail };
}

/* ---------------------------------------------------------------- students
 *
 * §8.1. The roster is student.read — OPS_ADMIN's usual scope. Revealing an
 * emergency contact is narrower and deliberately its own permission
 * (student.emergency.reveal, migration 016, Super Admin only): it discloses a
 * THIRD PARTY's name and phone, not the student's own data, and Admin Spec
 * §8.1 requires it be reasoned and audited every time.
 */
export async function listStudents(actor: Actor, q?: string | null) {
  await requirePermission(actor.role, 'student.read');
  const needle = q?.trim() || null;
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone,
            (u.email_verified_at IS NOT NULL) AS "emailVerified",
            sp.student_id AS "studentId",
            (sp.emergency_contact_name IS NOT NULL) AS "emergencyContactAvailable",
            (SELECT count(*)::int FROM bookings b
              WHERE b.user_id = u.id AND b.status <> 'ABANDONED') AS bookings
       FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id
      WHERE u.role = 'STUDENT' AND u.status = 'ACTIVE'
        AND ($1::text IS NULL OR u.name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%'
                              OR sp.student_id ILIKE '%' || $1 || '%' OR u.phone LIKE '%' || $1 || '%')
      ORDER BY u.name LIMIT 200`, [needle]);
  return rows;
}

export async function revealEmergencyContact(userId: string, reason: string, actor: Actor) {
  await requirePermission(actor.role, 'student.emergency.reveal');
  const why = needReason(reason, 'to reveal an emergency contact');
  return tx(async (c) => {
    const { rows: [u] } = await c.query(
      `SELECT sp.emergency_contact_name AS name, sp.emergency_contact_phone AS phone,
              sp.emergency_contact_relation AS relation
         FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id
        WHERE u.id = $1 AND u.role = 'STUDENT'`, [userId]);
    if (!u) throw new AppError('NOT_FOUND', 'Student not found');
    /* Deliberately no before/after value: the contact's name and phone must
     * never land in the audit trail itself, which OPS_ADMIN can browse
     * generally (audit.read) — that would make the reveal gate pointless.
     * Only that a reveal happened, of whom, by whom, and why. */
    await audit(c, actor, 'student.emergency_contact_revealed', 'user', userId, null, null, why);
    if (!u.name) return null;
    return { name: u.name, phone: u.phone, relation: u.relation };
  });
}

/* ---------------------------------------------------------------- reviews (§Feedback)
 *
 * The table (migration 001) and the permissions (feedback.read/moderate,
 * migration 003) already existed; nothing in domain/ or http/ ever used them.
 * `resolved_at`/`resolved_by` (migration 016) mirror `hidden_at`/`hidden_by`
 * exactly, for the third state the console's copy already described
 * ("Hiding a review keeps it on the record...") but the schema had no column
 * for: acknowledged and kept visible, as distinct from never looked at.
 */
export async function listReviews(actor: Actor) {
  await requirePermission(actor.role, 'feedback.read');
  const { rows } = await query(
    `SELECT rv.id, rv.rating, rv.comment AS feedback, rv.hidden_at AS "hiddenAt",
            rv.resolved_at AS "resolvedAt", rv.created_at AS "createdAt",
            u.name AS student,
            r.origin || ' → ' || r.destination || ' · ' || to_char(t.departure_at, 'DD Mon') AS trip
       FROM reviews rv
       JOIN trips t ON t.id = rv.trip_id
       JOIN routes r ON r.id = t.route_id
       JOIN users u ON u.id = rv.user_id
      ORDER BY rv.created_at DESC LIMIT 200`);
  return rows.map((r: any) => ({
    ...r, status: r.hiddenAt ? 'HIDDEN' : r.resolvedAt ? 'RESOLVED' : 'VISIBLE',
  }));
}

export async function moderateReview(
  reviewId: string, action: 'hide' | 'unhide' | 'resolve', actor: Actor
) {
  await requirePermission(actor.role, 'feedback.moderate');
  if (!['hide', 'unhide', 'resolve'].includes(action))
    throw new AppError('VALIDATION', 'Choose hide, unhide or resolve');
  return tx(async (c) => {
    const { rows: [rv] } = await c.query('SELECT * FROM reviews WHERE id = $1 FOR UPDATE', [reviewId]);
    if (!rv) throw new AppError('NOT_FOUND', 'Review not found');
    const before = rv.hidden_at ? 'HIDDEN' : rv.resolved_at ? 'RESOLVED' : 'VISIBLE';
    let after: string;
    if (action === 'hide') {
      await c.query('UPDATE reviews SET hidden_at = now(), hidden_by = $2 WHERE id = $1',
        [reviewId, actor.userId]);
      after = 'HIDDEN';
    } else if (action === 'unhide') {
      await c.query('UPDATE reviews SET hidden_at = NULL, hidden_by = NULL WHERE id = $1', [reviewId]);
      after = 'VISIBLE';
    } else {
      await c.query('UPDATE reviews SET resolved_at = now(), resolved_by = $2 WHERE id = $1',
        [reviewId, actor.userId]);
      after = 'RESOLVED';
    }
    await audit(c, actor, `review.${action}d`, 'review', reviewId, before, after, null);
    return { moderated: action, status: after };
  });
}

/* ---------------------------------------------------------------- payment reconciliation
 *
 * F-01/F-05's fix already made discrepancy and duplicate handling AUTOMATIC:
 * the webhook processor (domain/payments.ts) refunds an amount mismatch or a
 * duplicate payment in full the moment it is detected — "never a silent
 * accept", by its own comment — and no PENDING discrepancy state exists to
 * hand an operator a choice between accepting a short payment or refunding
 * it. dlt-store.js's resolveDiscrepancy(accept|refund) / refundExtra
 * describe exactly that choice, which no longer exists once the fix is
 * server-side and the money already moved before anyone opens this screen.
 * Building it now would mean inventing a manual override of a rule the
 * backend was deliberately changed to enforce automatically. This function
 * is the transparency list only — real statuses, real references, real
 * refunds already raised — plus the one action still genuine: nudging a
 * reconciliation via the existing payments.reconcile() when a webhook is
 * late. See the migration report for this exact mismatch, reported rather
 * than papered over.
 */
export async function listPaymentsForReconciliation(actor: Actor) {
  await requirePermission(actor.role, 'payment.admin');
  const { rows } = await query(
    `SELECT p.id, p.status, p.amount, p.provider, p.provider_reference AS "providerReference",
            p.failure_reason AS "failureReason", p.updated_at AS "updatedAt",
            b.id AS "bookingId", b.code AS "bookingCode", b.kind AS "bookingType",
            u.name AS student,
            COALESCE(rf.rows, '[]'::json) AS refunds
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN users u ON u.id = b.user_id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('amount', r.amount, 'status', r.status)) AS rows
           FROM refunds r WHERE r.booking_id = b.id) rf ON true
      ORDER BY p.updated_at DESC LIMIT 300`);
  return rows;
}
