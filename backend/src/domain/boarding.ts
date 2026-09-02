/* DLT · domain/boarding.ts — identifier resolution, scan authority, manifest.
 *
 * THE DIVISION OF LABOUR, which is the whole point of this phase:
 *
 *   the scanner  submits an identifier. Nothing else. It decides nothing.
 *   this file    resolves that identifier to a pass, and decides whether the
 *                caller is even allowed to ask.
 *   board_by_pass  runs the eleven-check chain under a row lock and mutates.
 *
 * The prototype's chain is preserved verbatim, in order, in migration 007. The
 * order matters: at a coach door several things can be true at once, and which
 * one a staff member is shown was a reviewed decision.
 *
 * ONE VALIDATION PATH ONLY. A hand-typed boarding code resolves to a pass and
 * then runs the identical chain — there is deliberately no shortcut for typed
 * input, because a second path is a second set of bugs.
 *
 * WRITTEN, NOT EXECUTED.
 */

import type { PoolClient } from 'pg';
import { query, tx } from '../db/index.ts';
import { AppError } from './errors.ts';
import { audit } from './audit.ts';
import { requirePermission } from './auth.ts';
import { REPORTING_LEAD_MIN } from './seats.ts';
import { boardingScopeFor, requireTripScope, passengerFor, bookingFor } from './authz.ts';
import type { Actor } from './authz.ts';

export type ScanResult = 'VALID' | 'INVALID' | 'ALREADY BOARDED' | 'DENIED' | 'NO_SHOW' | 'CHOOSE';

export interface ScanOutcome {
  result: ScanResult;
  detail: string;
  passenger?: {
    id: string; name: string; seatNumber: string; seatType: string;
    studentId: string; bookingCode: string; boardedAt?: string;
  };
  /** CHOOSE only: the travellers on a booking, so staff pick rather than the
   *  server guessing. */
  bookingCode?: string;
  passengers?: { id: string; name: string; seatNumber: string; studentId: string; boardingStatus: string }[];
}

/* One canonical Actor for the whole backend. Two local definitions would drift,
 * and a drifted actor type is how an authorization argument gets dropped. */
export type { Actor } from './authz.ts';

/* ---------------------------------------------------------------- scope
 *
 * F-19. A boarding staff member's trip comes from `trip_staff` and from nowhere
 * else. Whatever trip id the client sends is discarded for that role — the
 * assignment cannot be talked out of by a URL, a cookie, a body field or a
 * tampered local store, because none of those are read.
 */
const scopeTripFor = (c: PoolClient, actor: Actor, clientTripId?: string | null) =>
  boardingScopeFor(actor, clientTripId, c);

/** What trip is this scanner working? Exposed so the console can show it
 *  without inferring it — the prototype's scanner guessed (F-19). */
export async function scannerContext(actor: Actor) {
  const { rows: [r] } = await query(
    `SELECT t.id, t.departure_at AS "departureAt", t.status,
            r.origin, r.destination,
            (SELECT count(*)::int FROM booking_passengers bp
               JOIN bookings b ON b.id = bp.booking_id
              WHERE b.trip_id = t.id AND b.status = 'CONFIRMED') AS expected,
            (SELECT count(*)::int FROM booking_passengers bp
               JOIN bookings b ON b.id = bp.booking_id
              WHERE b.trip_id = t.id AND b.status = 'CONFIRMED'
                AND bp.boarding_status = 'BOARDED') AS boarded
       FROM trips t JOIN routes r ON r.id = t.route_id
      WHERE t.id = assigned_trip_for($1)`, [actor.userId]);
  return {
    assigned: !!r,
    trip: r ?? null,
    canChooseTrip: actor.role !== 'BOARDING_STAFF',
  };
}

/* ---------------------------------------------------------------- resolution
 *
 * F-11. Three identifier kinds, one chain. The prototype advertised "token or
 * boarding code" and accepted only the token; here all three resolve.
 */

interface Resolved {
  passId?: string;
  method: 'SCAN' | 'CODE' | 'MANUAL';
  choose?: { bookingId: string; bookingCode: string };
  fail?: { detail: string; reason: string | null; passengerId?: string | null };
}

async function resolveIdentifier(
  c: PoolClient, rawInput: string, passengerId?: string | null
): Promise<Resolved> {
  const raw = String(rawInput ?? '').trim();
  if (!raw) return { method: 'SCAN', fail: { detail: 'Enter or scan a code.', reason: null } };

  /* 1. a QR token, exactly as printed on the pass */
  const { rows: [byToken] } = await c.query(
    'SELECT id FROM boarding_passes WHERE qr_token = $1', [raw]);
  if (byToken) return { passId: byToken.id, method: 'SCAN' };

  /* 2. a boarding code (WX3102) or a booking id (DLT-40219), typed by hand when
   *    the camera will not cooperate. Case- and space-insensitive, because it is
   *    being typed at a bus door in the dark. */
  const key = raw.toUpperCase().replace(/\s+/g, '');
  const { rows: bookings } = await c.query(
    `SELECT id, code FROM bookings
      WHERE upper(boarding_code) = $1 OR upper(code) = $1
      ORDER BY created_at DESC`, [key]);
  if (!bookings.length)
    return { method: 'SCAN',
      fail: { detail: 'This code is not a DLT boarding pass, boarding code or booking ID.', reason: null } };

  const b0 = bookings[0];
  const { rows: pax } = await c.query(
    `SELECT id, name, seat_number, student_id, boarding_status
       FROM booking_passengers WHERE booking_id = $1 ORDER BY seat_row_order, seat_number`, [b0.id]);

  let chosen: any = null;
  if (passengerId) chosen = pax.find(p => p.id === passengerId) ?? null;
  else if (pax.length === 1) chosen = pax[0];
  else if (pax.length > 1)
    /* Never guess which of several travellers is at the door. */
    return { method: 'CODE', choose: { bookingId: b0.id, bookingCode: b0.code } };

  if (!chosen)
    return { method: 'CODE',
      fail: { detail: `No passenger on ${b0.code} matches that choice.`, reason: 'passenger not on booking' } };

  const { rows: [pass] } = await c.query(
    'SELECT id FROM boarding_passes WHERE passenger_id = $1', [chosen.id]);
  if (!pass)
    return { method: 'CODE', fail: {
      detail: `No boarding pass has been issued for ${chosen.name} yet.`,
      reason: 'pass not issued', passengerId: chosen.id } };

  return { passId: pass.id, method: 'CODE' };
}

/* ---------------------------------------------------------------- scan */

export async function scan(
  input: { code: string; tripId?: string | null; passengerId?: string | null },
  actor: Actor
): Promise<ScanOutcome> {
  await requirePermission(actor.role, 'boarding.scan');

  return tx(async (c) => {
    const scopeTripId = await scopeTripFor(c, actor, input.tripId);
    const tokenPrefix = String(input.code ?? '').trim().slice(0, 12);
    const r = await resolveIdentifier(c, input.code, input.passengerId);

    /* Resolution failures are still boarding events. An unrecognised code at
     * the door is exactly the kind of thing operations needs to see. */
    if (r.fail) {
      await c.query('SELECT log_boarding($1,$2,$3,$4,$5,$6,$7)',
        [scopeTripId, r.fail.passengerId ?? null, actor.userId, 'INVALID', r.method,
         r.fail.reason, tokenPrefix]);
      return { result: 'INVALID' as const, detail: r.fail.detail };
    }

    /* CHOOSE is a question, not an outcome: nothing is mutated and nothing is
     * logged, because nobody has been boarded or refused yet. */
    if (r.choose) {
      const { rows: pax } = await c.query(
        `SELECT bp.id, bp.name, bp.seat_number AS "seatNumber", bp.student_id AS "studentId",
                bp.boarding_status AS "boardingStatus"
           FROM booking_passengers bp WHERE bp.booking_id = $1
          ORDER BY bp.seat_row_order, bp.seat_number`, [r.choose.bookingId]);
      return {
        result: 'CHOOSE' as const,
        detail: `${r.choose.bookingCode} carries ${pax.length} passengers. Choose who is boarding.`,
        bookingCode: r.choose.bookingCode,
        passengers: pax,
      };
    }

    /* The chain. Eleven checks, fixed order, one row lock, one event. */
    const { rows: [v] } = await c.query(
      'SELECT * FROM board_by_pass($1,$2,$3::user_role,$4,$5,$6)',
      [r.passId, actor.userId, actor.role, scopeTripId, r.method, tokenPrefix]);

    if (v.result !== 'VALID')
      return { result: v.result as ScanResult, detail: v.detail };

    await audit(c, { actorId: actor.userId },
      r.method === 'CODE' ? 'boarding.code_entry' : 'boarding.scanned',
      'passenger', v.passenger_id, 'NOT_BOARDED', 'BOARDED',
      r.method === 'CODE' ? `Boarded by ${tokenPrefix.toUpperCase()}` : null);

    const { rows: [p] } = await c.query(
      `SELECT bp.id, bp.name, bp.seat_number AS "seatNumber", bp.seat_type AS "seatType",
              bp.student_id AS "studentId", b.code AS "bookingCode"
         FROM booking_passengers bp JOIN bookings b ON b.id = bp.booking_id
        WHERE bp.id = $1`, [v.passenger_id]);
    return { result: 'VALID' as const, detail: v.detail,
      passenger: { ...p, boardedAt: new Date().toISOString() } };
  });
}

/* ---------------------------------------------------------------- manual paths
 *
 * §24.3 / §25.1 / §25.2. Ops and Super only, reason mandatory, audited. Staff
 * can scan and read a manifest and nothing else — least privilege, unchanged
 * from the prototype, now enforced server-side where it cannot be bypassed.
 */

function needReason(reason: string | undefined, what: string): string {
  const r = String(reason ?? '').trim();
  if (r.length < 4) throw new AppError('VALIDATION', `A reason is required ${what}`);
  return r;
}

export async function manualBoard(passengerId: string, reason: string, actor: Actor, tripId?: string | null) {
  await requirePermission(actor.role, 'boarding.manual');
  const why = needReason(reason, 'for manual boarding');
  return tx(async (c) => {
    /* L-1: when the caller names a trip, the passenger must be on it — so a
     * mistyped id fails instead of acting on a stranger on another departure. */
    await passengerFor(actor, passengerId, { permission: 'boarding.manual', tripId, client: c });
    const { rows: [p] } = await c.query(
      `SELECT bp.*, b.trip_id FROM booking_passengers bp
         JOIN bookings b ON b.id = bp.booking_id WHERE bp.id = $1 FOR UPDATE OF bp`, [passengerId]);
    if (!p) throw new AppError('NOT_FOUND', 'Passenger not found');
    if (p.boarding_status === 'BOARDED') throw new AppError('CONFLICT', `${p.name} has already boarded`);

    await c.query(`UPDATE booking_passengers SET boarding_status='BOARDED' WHERE id=$1`, [passengerId]);
    await c.query('SELECT log_boarding($1,$2,$3,$4,$5,$6,$7)',
      [p.trip_id, passengerId, actor.userId, 'VALID', 'MANUAL', why, null]);
    await audit(c, { actorId: actor.userId }, 'boarding.manual', 'passenger', passengerId,
      'NOT_BOARDED', 'BOARDED', why);
    return { name: p.name, seatNumber: p.seat_number, at: new Date().toISOString() };
  });
}

/** §25.2 A distinct state, not a cancellation: the seat is not resold and no
 *  refund follows automatically. The pass is voided so it cannot be re-scanned. */
export async function denyBoarding(passengerId: string, reason: string, actor: Actor, tripId?: string | null) {
  await requirePermission(actor.role, 'boarding.deny');
  const why = needReason(reason, 'to deny boarding');
  return tx(async (c) => {
    const { rows: [p] } = await c.query(
      `SELECT bp.*, b.trip_id FROM booking_passengers bp
         JOIN bookings b ON b.id = bp.booking_id WHERE bp.id = $1 FOR UPDATE OF bp`, [passengerId]);
    if (!p) throw new AppError('NOT_FOUND', 'Passenger not found');

    await c.query(`UPDATE booking_passengers SET boarding_status='DENIED_BOARDING' WHERE id=$1`, [passengerId]);
    await c.query(`UPDATE boarding_passes SET status='VOID', voided_at=now() WHERE passenger_id=$1`, [passengerId]);
    await c.query('SELECT log_boarding($1,$2,$3,$4,$5,$6,$7)',
      [p.trip_id, passengerId, actor.userId, 'DENIED', 'MANUAL', why, null]);
    await audit(c, { actorId: actor.userId }, 'boarding.denied', 'passenger', passengerId,
      p.boarding_status, 'DENIED_BOARDING', why);
    return { name: p.name };
  });
}

/** §25.1 An admin confirms the final no-show. No automatic refund. */
export async function confirmNoShow(passengerId: string, reason: string, actor: Actor, tripId?: string | null) {
  await requirePermission(actor.role, 'boarding.noshow');
  const why = needReason(reason, 'to record a no-show');
  return tx(async (c) => {
    const { rows: [p] } = await c.query(
      `SELECT bp.*, b.trip_id FROM booking_passengers bp
         JOIN bookings b ON b.id = bp.booking_id WHERE bp.id = $1 FOR UPDATE OF bp`, [passengerId]);
    if (!p) throw new AppError('NOT_FOUND', 'Passenger not found');
    if (p.boarding_status === 'BOARDED')
      throw new AppError('CONFLICT', `${p.name} boarded — that is not a no-show`);

    await c.query(`UPDATE booking_passengers SET boarding_status='NO_SHOW' WHERE id=$1`, [passengerId]);
    await c.query('SELECT log_boarding($1,$2,$3,$4,$5,$6,$7)',
      [p.trip_id, passengerId, actor.userId, 'NO_SHOW', 'MANUAL', why, null]);
    await audit(c, { actorId: actor.userId }, 'boarding.no_show', 'passenger', passengerId,
      p.boarding_status, 'NO_SHOW', why);
    return { name: p.name };
  });
}

/* ---------------------------------------------------------------- manifest */

export async function manifest(tripIdInput: string | null | undefined, actor: Actor) {
  await requirePermission(actor.role, 'boarding.read');
  return tx(async (c) => {
    /* F-19: staff read the manifest for their ASSIGNED trip, derived the same
     * way the scanner derives it. One source, so the list at the door and the
     * scanner can never disagree. */
    const tripId = actor.role === 'BOARDING_STAFF'
      ? await scopeTripFor(c, actor, null)
      : tripIdInput;
    if (!tripId) throw new AppError('VALIDATION', 'Choose a departure');

    /* The phone column is nulled inside trip_manifest for BOARDING_STAFF —
     * in the projection, not by a caller remembering to strip it. */
    const { rows } = await c.query('SELECT * FROM trip_manifest($1,$2::user_role)', [tripId, actor.role]);
    const { rows: [t] } = await c.query(
      `SELECT t.id, t.departure_at AS "departureAt", t.status, r.origin, r.destination,
              v.name AS vehicle, v.registration
         FROM trips t JOIN routes r ON r.id = t.route_id
         LEFT JOIN vehicles v ON v.id = t.vehicle_id WHERE t.id = $1`, [tripId]);
    if (!t) throw new AppError('NOT_FOUND', 'Trip not found');

    const counts = rows.reduce((a, p) => {
      a.expected++;
      if (p.boarding_status === 'BOARDED') a.boarded++;
      else if (p.boarding_status === 'DENIED_BOARDING') a.denied++;
      else if (p.boarding_status === 'NO_SHOW') a.noShow++;
      else a.awaiting++;
      return a;
    }, { expected: 0, boarded: 0, denied: 0, noShow: 0, awaiting: 0 });

    return { trip: t, counts, passengers: rows };
  });
}

/** The scan log for a trip — evidence, including refused attempts. */
/* L-2. THE DEFECT: the manifest correctly forced boarding staff to their
 * assigned trip, but this took a tripId and did not — so a staff member could
 * read the scan log of any departure. Same scope rule now, from the same
 * function, so the two can never disagree again. */
export async function boardingEvents(tripId: string, actor: Actor, limit = 200) {
  await requirePermission(actor.role, 'boarding.read');
  await requireTripScope(actor, tripId);
  const { rows } = await query(
    `SELECT e.id, e.result, e.method, e.reason, e.token_prefix AS "tokenPrefix",
            e.occurred_at AS "occurredAt", u.name AS "staffName", bp.name AS "passengerName",
            bp.seat_number AS "seatNumber"
       FROM boarding_events e
       LEFT JOIN users u ON u.id = e.staff_user_id
       LEFT JOIN booking_passengers bp ON bp.id = e.passenger_id
      WHERE e.trip_id = $1 ORDER BY e.occurred_at DESC LIMIT $2`, [tripId, limit]);
  return rows;
}

/* ---------------------------------------------------------------- M-1 · student passes
 *
 * The student's own boarding passes, for the Dashboard. This is the ONLY path
 * that discloses qr_token, and it does so one booking at a time behind the
 * canonical ownership guard.
 *
 * Why not add qrToken to BOOKING_SQL: that projection backs GET /bookings/mine,
 * so the scannable secret for every pass a student has ever held would be handed
 * out on one unremarkable list request, and would sit in any log or cache of it.
 * A pass token is a bearer credential for a seat — it is read deliberately, for
 * one booking, or not at all.
 *
 * Authorization is bookingFor(), unchanged and not reimplemented: ownership OR
 * booking.read. Nothing is taken from the request but the booking id — not the
 * user id, not the role, not the booking code, not a passenger id.
 *
 * pickupPoint is absent on purpose. No column holds one, and inventing a default
 * would print fabricated operational instruction onto a boarding pass.
 */
export async function passesForBooking(bookingId: string, actor: Actor) {
  await bookingFor(actor, bookingId);          // throws NOT_FOUND / FORBIDDEN

  const { rows } = await query(
    `SELECT bp.name, bp.student_id AS "studentId", bp.seat_number AS "seatNumber",
            bp.seat_type AS "seatType", bp.boarding_status AS "boardingStatus",
            pass.qr_token AS "qrToken", pass.status AS "passStatus",
            (SELECT max(e.occurred_at) FROM boarding_events e
              WHERE e.passenger_id = bp.id AND e.result = 'VALID') AS "boardedAt",
            r.origin || ' → ' || r.destination AS route,
            t.departure_at AS "departureAt",
            t.departure_at - ($2 || ' minutes')::interval AS "reportingAt",
            v.name AS vehicle,
            b.code AS "bookingCode", b.boarding_code AS "boardingCode",
            b.unit_price AS "fareShare", b.total_amount AS total,
            (SELECT p.status FROM payments p WHERE p.booking_id = b.id
              ORDER BY CASE p.status WHEN 'SUCCESS' THEN 0 WHEN 'NOT_APPLICABLE' THEN 1 ELSE 2 END,
                       p.created_at DESC LIMIT 1) AS "paymentStatus"
       FROM booking_passengers bp
       JOIN bookings b ON b.id = bp.booking_id
       JOIN trips t    ON t.id = b.trip_id
       JOIN routes r   ON r.id = t.route_id
       LEFT JOIN vehicles v ON v.id = t.vehicle_id
       /* INNER join: a passenger with no pass yet has no pass to show. The
        * Dashboard renders its own "issued on payment" state from an empty list. */
       JOIN boarding_passes pass ON pass.passenger_id = bp.id
      WHERE bp.booking_id = $1
      ORDER BY bp.seat_row_order, bp.seat_number`,
    [bookingId, String(REPORTING_LEAD_MIN)]);

  return rows;
}
