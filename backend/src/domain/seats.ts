/* DLT · domain/seats.ts — trip retrieval, seat availability, holds.
 *
 * The rules are dlt-store.js's rules. What changes is where the decision is
 * made: every one of these functions delegates the indivisible part to a
 * PostgreSQL function that takes a row lock, so two devices cannot both win.
 * There is no check-then-act window anywhere in this file, and that is
 * deliberate — the F-01 defect lived in exactly such a window.
 *
 * WRITTEN, NOT EXECUTED.
 */

import type { PoolClient } from 'pg';
import { query, tx, type Client } from '../db/index.ts';
import { AppError } from './errors.ts';
import { audit } from './audit.ts';

export const HOLD_TTL_MIN = 10;

/* B-1 · REPORTING LEAD. How long before departure a student is told to be at the
 * stop. This is an OPERATIONAL POLICY, not a display format: boarding staff work
 * to it, and the prototype derived it in the browser where the server and the
 * screens could silently disagree. One constant, server-side, projected into
 * every TripView so no client ever computes it. */
export const REPORTING_LEAD_MIN = Number(process.env.REPORTING_LEAD_MIN ?? 15);
/* Master Specification and the PRD both say five ("Up to 5 passengers per
 * booking", "Maximum 5 passengers per booking"), and the booking screen has
 * always offered five. The backend enforced four, here and in
 * create_booking_from_holds — migration 012 moves the database half. */
export const MAX_SEATS_PER_BOOKING = 5;

/* H-2 · GUEST HOLD ABUSE LIMITS
 *
 * THE DEFECT: holds are anonymous by documented design (F-09, PRD §7, UX §4),
 * and a guest is identified only by a cookie the server mints on demand. The
 * 4-seat cap was per TOKEN, and tokens are free — so a script could request a
 * fresh cookie, hold 4 seats, discard it, and repeat. Eleven iterations lock a
 * 44-seat coach; a loop sustains it indefinitely, with no account, no payment
 * and nothing to trace but an IP.
 *
 * Anonymous seat selection is PRESERVED. Requiring a session before the first
 * hold would close this completely but contradicts the documentation and
 * resurrects F-09, so it was rejected.
 *
 * Two new limits, both configurable, chosen to be generous to real students:
 *
 *   GUEST_HOLDS_PER_IP = 12 per window
 *       A real student holds at most 4, and re-picking seats a few times is
 *       normal. 12 is three full baskets. Deliberately well above genuine use
 *       because Woxsen students share campus NAT and Indian mobile carriers use
 *       large-scale CGNAT — a tight per-IP limit would lock out a whole hostel.
 *       Counted per (ip, trip) so one busy departure cannot exhaust the budget
 *       for another, and only GUEST holds count: a signed-in student is never
 *       rate-limited by this, so the abuse path costs an account.
 *
 *   GUEST_HOLD_CEILING_PCT = 40% of a trip's seats
 *       Guests can never hold more than this share at once, so a coach cannot
 *       be locked out however many tokens an attacker mints. 40% leaves ample
 *       room for genuine anonymous browsing on a busy trip while guaranteeing
 *       the majority of seats stay reachable. Signed-in students are exempt.
 */
export const GUEST_HOLDS_PER_IP = Number(process.env.GUEST_HOLDS_PER_IP ?? 12);
export const GUEST_HOLD_IP_WINDOW_MIN = Number(process.env.GUEST_HOLD_IP_WINDOW_MIN ?? 10);
export const GUEST_HOLD_CEILING_PCT = Number(process.env.GUEST_HOLD_CEILING_PCT ?? 40);

/** Who is holding: a signed-in student, or a browser that has not signed in
 *  yet (F-09 — the documentation promises seat selection without an account). */
export type Holder =
  | { userId: string; guestToken?: null; ip?: string }
  | { userId?: null; guestToken: string; ip?: string };

const holderArgs = (h: Holder) => [h.userId ?? null, h.guestToken ?? null];

/* Postgres error codes the seat functions raise, mapped to the errors the
 * screens already know how to display. A losing racer must get a DETERMINISTIC
 * conflict, not a generic 500. */
function mapSeatError(e: any): never {
  const code = e?.code;
  if (code === '23505') throw new AppError('CONFLICT', e.message);       // unique_violation
  if (code === '23514') throw new AppError('INVALID', e.message);        // check_violation
  if (code === 'P0002' || code === '02000') throw new AppError('NOT_FOUND', e.message);
  if (code === '22023') throw new AppError('VALIDATION', e.message);
  if (code === '42501') throw new AppError('FORBIDDEN', e.message);
  throw e;
}

/* ---------------------------------------------------------------- trips */

export interface TripView {
  id: string; departureAt: string; price: number; status: string;
  /** B-1: derived server-side from departure_at and the reporting lead. */
  reportingAt: string;
  /** B-1: derived server-side from departure_at + routes.duration_min. */
  arrivalEstimateAt: string;
  origin: string; destination: string; durationMin: number;
  vehicle: { id: string; name: string; registration: string } | null;
  capacity: number; available: number; booked: number; held: number;
  bookable: boolean; soldOut: boolean;
  assignedStaff: { id: string; name: string }[];
}

/* Counts come from the seat rows in the same statement as the trip, so a list
 * can never show an availability that never existed at any single instant. */
const TRIP_SQL = `
  SELECT t.id, t.departure_at AS "departureAt", t.price, t.status,
         /* B-1: the reporting and arrival estimates are computed HERE, from the
          * departure and the route duration, so the policy has exactly one home.
          * A client that wants them asks; it never derives them.
          *
          * The lead is INTERPOLATED, not bound: it is Number()-coerced at module
          * load, so there is no injection surface, and binding it would force an
          * extra parameter into every caller's numbering — which is how an
          * unreferenced $3 crept in and would have made Postgres refuse the
          * bind outright. */
         t.departure_at - (${REPORTING_LEAD_MIN} || ' minutes')::interval AS "reportingAt",
         t.departure_at + (r.duration_min || ' minutes')::interval AS "arrivalEstimateAt",
         r.origin, r.destination, r.duration_min AS "durationMin",
         CASE WHEN v.id IS NULL THEN NULL ELSE
           json_build_object('id', v.id, 'name', v.name, 'registration', v.registration)
         END AS vehicle,
         COALESCE(s.capacity,0)  AS capacity,
         COALESCE(s.available,0) AS available,
         COALESCE(s.booked,0)    AS booked,
         COALESCE(s.held,0)      AS held,
         COALESCE(staff.rows, '[]'::json) AS "assignedStaff"
    FROM trips t
    JOIN routes r   ON r.id = t.route_id
    LEFT JOIN vehicles v ON v.id = t.vehicle_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS capacity,
             count(*) FILTER (WHERE status = 'AVAILABLE')::int AS available,
             count(*) FILTER (WHERE status = 'BOOKED')::int    AS booked,
             count(*) FILTER (WHERE status = 'HELD')::int      AS held
        FROM trip_seat_view WHERE trip_id = t.id
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('id', u.id, 'name', u.name)) AS rows
        FROM trip_staff ts JOIN users u ON u.id = ts.user_id WHERE ts.trip_id = t.id
    ) staff ON true`;

const decorate = (t: any): TripView => ({
  ...t,
  bookable: t.status === 'OPEN' && t.available > 0,
  soldOut: t.available === 0 && ['OPEN', 'BOOKING_CLOSED'].includes(t.status),
});

/** Public listing: published trips only, soonest first. */
export async function listTrips(opts: { days?: number; limit?: number } = {}): Promise<TripView[]> {
  const { rows } = await query(
    `${TRIP_SQL}
      WHERE t.status IN ('OPEN','BOOKING_CLOSED','BOARDING')
        AND t.departure_at BETWEEN now() - interval '1 hour'
                              AND now() + ($1 || ' days')::interval
      ORDER BY t.departure_at
      LIMIT $2`,
    [String(opts.days ?? 14), opts.limit ?? 50]);
  return rows.map(decorate);
}

export async function getTrip(id: string): Promise<TripView> {
  const { rows: [t] } = await query(`${TRIP_SQL} WHERE t.id = $1`, [id]);
  if (!t) throw new AppError('NOT_FOUND', 'That departure does not exist');
  return decorate(t);
}

/* ---------------------------------------------------------------- seat map */

export interface SeatCell {
  seatNumber: string; row: number; seatType: 'WINDOW' | 'AISLE';
  status: 'AVAILABLE' | 'HELD' | 'BOOKED' | 'BLOCKED';
  mine: boolean; holdExpiresAt: string | null;
}

/* `mine` is computed server-side from the session or guest cookie. The client
 * is never told WHO holds a seat — only whether it is available and whether it
 * is theirs. Leaking hold ownership would let one student watch another. */
export async function seatMap(tripId: string, holder?: Holder | null): Promise<{ row: number; seats: SeatCell[] }[]> {
  const { rows } = await query(
    `SELECT seat_number AS "seatNumber", seat_row AS row, seat_type AS "seatType", status,
            (($2::uuid IS NOT NULL AND hold_by = $2::uuid)
              OR ($3::text IS NOT NULL AND hold_guest_token = $3::text)) AS mine,
            CASE WHEN (($2::uuid IS NOT NULL AND hold_by = $2::uuid)
                    OR ($3::text IS NOT NULL AND hold_guest_token = $3::text))
                 THEN hold_expires_at ELSE NULL END AS "holdExpiresAt"
       FROM trip_seat_view WHERE trip_id = $1
      ORDER BY seat_row, seat_number`,
    [tripId, holder?.userId ?? null, holder?.guestToken ?? null]);
  if (!rows.length) throw new AppError('NOT_FOUND', 'That departure has no seat map');

  const byRow = new Map<number, SeatCell[]>();
  for (const s of rows) {
    if (!byRow.has(s.row)) byRow.set(s.row, []);
    byRow.get(s.row)!.push(s as SeatCell);
  }
  return [...byRow.entries()].map(([row, seats]) => ({ row, seats }));
}

/** The student's current basket for a trip. */
export async function myHeld(tripId: string, holder: Holder): Promise<SeatCell[]> {
  const { rows } = await query(
    `SELECT seat_number AS "seatNumber", seat_row AS row, seat_type AS "seatType",
            status, true AS mine, hold_expires_at AS "holdExpiresAt"
       FROM trip_seat_view
      WHERE trip_id = $1 AND status = 'HELD'
        AND (($2::uuid IS NOT NULL AND hold_by = $2::uuid)
          OR ($3::text IS NOT NULL AND hold_guest_token = $3::text))
      ORDER BY seat_row, seat_number`,
    [tripId, ...holderArgs(holder)]);
  return rows as SeatCell[];
}

/* ---------------------------------------------------------------- holds */

/** Take a seat. The database serialises competing callers; the loser gets
 *  CONFLICT with the seat's real state, never a partial success. */
export async function holdSeat(tripId: string, seatNumber: string, holder: Holder): Promise<SeatCell> {
  return tx(async (c) => {
    /* §12 basket cap, checked inside the same transaction as the hold so two
     * parallel requests cannot both see three seats and both add a fourth. */
    /* Lock this holder's HELD rows in the subquery (FOR UPDATE cannot sit on an
     * aggregate), then count them. A concurrent hold from the same holder blocks
     * on those locked rows, so two parallel requests cannot both see three and
     * both add a fourth — the §12 cap holds under a race. */
    const { rows: [n] } = await c.query(
      `SELECT count(*)::int AS held FROM (
         SELECT 1 FROM trip_seats
          WHERE trip_id = $1 AND status = 'HELD' AND hold_expires_at > now()
            AND (($2::uuid IS NOT NULL AND hold_by = $2::uuid)
              OR ($3::text IS NOT NULL AND hold_guest_token = $3::text))
          FOR UPDATE
       ) locked`,
      [tripId, ...holderArgs(holder)]);

    const already = await c.query(
      `SELECT 1 FROM trip_seats WHERE trip_id=$1 AND seat_number=$2 AND status='HELD'
        AND (($3::uuid IS NOT NULL AND hold_by=$3::uuid)
          OR ($4::text IS NOT NULL AND hold_guest_token=$4::text))`,
      [tripId, seatNumber, ...holderArgs(holder)]);

    if (!already.rowCount && n.held >= MAX_SEATS_PER_BOOKING)
      throw new AppError('VALIDATION', `You can hold up to ${MAX_SEATS_PER_BOOKING} seats in one booking`);

    /* H-2: the two guest ceilings, checked inside this transaction so parallel
     * requests cannot both pass. Signed-in students are exempt from both. */
    if (!already.rowCount && !holder.userId) {
      await enforceGuestLimits(c, tripId, holder);
    }

    try {
      const { rows: [s] } = await c.query(
        `SELECT * FROM hold_seat($1,$2,$3::uuid,$4::text, ($5 || ' minutes')::interval)`,
        [tripId, seatNumber, ...holderArgs(holder), String(HOLD_TTL_MIN)]);
      return {
        seatNumber: s.seat_number, row: s.seat_row, seatType: s.seat_type,
        status: s.status, mine: true, holdExpiresAt: s.hold_expires_at,
      };
    } catch (e) { mapSeatError(e); }
  });
}

/* H-2 enforcement. Two independent ceilings: a per-IP budget on how fast one
 * source may mint holds, and an absolute share of a trip guests may hold at
 * once. The second is what actually guarantees a coach cannot be locked out —
 * the first only makes it expensive. */
async function enforceGuestLimits(c: Client, tripId: string, holder: Holder) {
  /* 1. absolute ceiling on guest-held seats for this trip */
  const { rows: [cap] } = await c.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'HELD' AND hold_guest_token IS NOT NULL
                               AND hold_expires_at > now())::int AS guest_held
       FROM trip_seats WHERE trip_id = $1`, [tripId]);
  const ceiling = Math.max(MAX_SEATS_PER_BOOKING,
    Math.floor(cap.total * (GUEST_HOLD_CEILING_PCT / 100)));
  if (cap.guest_held >= ceiling)
    throw new AppError('RATE_LIMITED',
      'A lot of people are choosing seats on this departure right now. ' +
      'Sign in to hold a seat, or try again in a few minutes.');

  /* 2. per-IP budget, scoped to this trip. Recorded in guest_hold_attempts so it
   * survives a restart and is shared across instances — express-rate-limit is
   * per-process and would multiply behind more than one server (HD-2). */
  if (!holder.ip) return;               // no IP available: ceiling alone applies
  const { rows: [rate] } = await c.query(
    `INSERT INTO guest_hold_attempts (ip, trip_id, attempts, window_started_at)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (ip, trip_id) DO UPDATE SET
       attempts = CASE WHEN guest_hold_attempts.window_started_at + ($3 || ' minutes')::interval <= now()
                       THEN 1 ELSE guest_hold_attempts.attempts + 1 END,
       window_started_at = CASE WHEN guest_hold_attempts.window_started_at + ($3 || ' minutes')::interval <= now()
                       THEN now() ELSE guest_hold_attempts.window_started_at END
     RETURNING attempts`,
    [holder.ip, tripId, String(GUEST_HOLD_IP_WINDOW_MIN)]);
  if (rate.attempts > GUEST_HOLDS_PER_IP)
    throw new AppError('RATE_LIMITED',
      'Too many seat selections from this network. Sign in to continue holding seats.');
}

/** F-20: a deliberate release, reported as a release and not as an expiry. */
export async function releaseSeat(tripId: string, seatNumber: string, holder: Holder): Promise<boolean> {
  const { rows: [r] } = await query(
    'SELECT release_seat($1,$2,$3::uuid,$4::text) AS ok', [tripId, seatNumber, ...holderArgs(holder)]);
  return !!r.ok;
}

export async function releaseAll(tripId: string, holder: Holder): Promise<number> {
  const { rows: [r] } = await query(
    'SELECT release_all_held($1,$2::uuid,$3::text) AS n', [tripId, ...holderArgs(holder)]);
  return r.n;
}

/* ---------------------------------------------------------------- sweep */

/* Runs on a short timer AND opportunistically before a seat-map read, so a
 * student never sees a lapsed hold shown as taken. It is idempotent and safe to
 * call concurrently — every statement inside is a bounded UPDATE. */
export async function sweepExpiredHolds(): Promise<{ seatsReleased: number; bookingsAbandoned: number }> {
  const { rows: [r] } = await query('SELECT * FROM sweep_expired_holds()');
  const out = { seatsReleased: r.seats_released, bookingsAbandoned: r.bookings_abandoned };
  if (out.seatsReleased > 0) {
    /* Freed seats may be owed to someone waiting (F-02). */
    const { rows } = await query(
      `SELECT DISTINCT trip_id FROM waitlist_entries WHERE status = 'WAITING'`);
    for (const t of rows) await query('SELECT offer_seat_to_waitlist($1)', [t.trip_id]);
  }
  await query('SELECT expire_waitlist_offers()');
  return out;
}

/* ---------------------------------------------------------------- waitlist */

export interface WaitlistView {
  id: string; tripId: string; status: string; position: number;
  seatsWanted: number; offerExpiresAt: string | null; seatNumber: string | null;
}

export async function joinWaitlist(tripId: string, userId: string, seatsWanted = 1): Promise<WaitlistView> {
  return tx(async (c) => {
    const { rows: [t] } = await c.query('SELECT status FROM trips WHERE id = $1', [tripId]);
    if (!t) throw new AppError('NOT_FOUND', 'That departure does not exist');
    if (t.status !== 'OPEN') throw new AppError('INVALID', 'That departure is not taking bookings');

    const { rows: [pos] } = await c.query(
      `SELECT COALESCE(max(position),0) + 1 AS next FROM waitlist_entries WHERE trip_id = $1`, [tripId]);
    try {
      const { rows: [e] } = await c.query(
        `INSERT INTO waitlist_entries (trip_id, user_id, seats_wanted, position)
         VALUES ($1,$2,$3,$4) RETURNING id, trip_id, status, position, seats_wanted`,
        [tripId, userId, seatsWanted, pos.next]);
      await audit(c, { actorId: userId }, 'waitlist.joined', 'trip', tripId, null, `position ${e.position}`, null);
      return { id: e.id, tripId, status: e.status, position: e.position,
        seatsWanted: e.seats_wanted, offerExpiresAt: null, seatNumber: null };
    } catch (e: any) {
      if (e.code === '23505') throw new AppError('CONFLICT', 'You are already on the waitlist for this departure');
      throw e;
    }
  });
}

export async function myWaitlist(userId: string): Promise<WaitlistView[]> {
  const { rows } = await query(
    `SELECT w.id, w.trip_id AS "tripId", w.status, w.position,
            w.seats_wanted AS "seatsWanted", w.offer_expires_at AS "offerExpiresAt",
            ts.seat_number AS "seatNumber"
       FROM waitlist_entries w
       LEFT JOIN trip_seats ts ON ts.id = w.reserved_seat_id
      WHERE w.user_id = $1 AND w.status IN ('WAITING','CLAIM_OFFERED','CLAIMED')
      ORDER BY w.created_at DESC`, [userId]);
  return rows as WaitlistView[];
}

/* F-02: the accept side that did not exist. The seat was already reserved by
 * offer_seat_to_waitlist; claiming turns it into an ordinary 10-minute basket
 * so the student finishes through the normal booking flow. */
export async function claimOffer(entryId: string, userId: string): Promise<SeatCell> {
  try {
    const { rows: [s] } = await query('SELECT * FROM claim_waitlist_offer($1,$2)', [entryId, userId]);
    return { seatNumber: s.seat_number, row: s.seat_row, seatType: s.seat_type,
      status: s.status, mine: true, holdExpiresAt: s.hold_expires_at };
  } catch (e) { mapSeatError(e); }
}

export async function declineOffer(entryId: string, userId: string): Promise<boolean> {
  const { rows: [r] } = await query('SELECT decline_waitlist_offer($1,$2) AS ok', [entryId, userId]);
  return !!r.ok;
}

/* ---------------------------------------------------------------- notify
 *
 * B-2. The operator side of GET_NOTIFIED existed since Phase 6 (/admin/requests
 * reads and decides them) and nothing could CREATE one — the same shape of gap
 * as F-13. This is the student side.
 *
 * Anonymous is supported deliberately: the sold-out and empty states are shown
 * to students who are not signed in, and asking them to create an account
 * before expressing interest would defeat the point of the signal.
 *
 * F-28: the tripId is stored. The prototype accepted one that no caller passed,
 * so every notify request lost the departure it was about. */
export async function requestNotify(input: {
  tripId?: string | null; email?: string | null; userId?: string | null;
}): Promise<{ recorded: true; alreadyRequested: boolean }> {
  const email = (input.email ?? '').trim().toLowerCase();
  if (!input.userId && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email))
    throw new AppError('VALIDATION', 'Enter a valid email address');

  return tx(async (c) => {
    if (input.tripId) {
      const { rows: [t] } = await c.query('SELECT id FROM trips WHERE id = $1', [input.tripId]);
      if (!t) throw new AppError('NOT_FOUND', 'That departure does not exist');
    }

    /* One open request per person per trip. For a signed-in student the partial
     * unique index on (user_id, kind) already prevents duplicates, so this is
     * checked explicitly for the anonymous case and reported as success either
     * way — telling someone "you already asked" is friendlier than an error,
     * and it must not become a way to probe who has signed up. */
    const { rows: [dup] } = await c.query(
      `SELECT id FROM notification_requests
        WHERE kind = 'GET_NOTIFIED' AND status = 'PENDING'
          AND trip_id IS NOT DISTINCT FROM $1
          AND (($2::uuid IS NOT NULL AND user_id = $2::uuid)
            OR ($2::uuid IS NULL AND lower(email) = $3))`,
      [input.tripId ?? null, input.userId ?? null, email || null]);
    if (dup) return { recorded: true as const, alreadyRequested: true };

    await c.query(
      `INSERT INTO notification_requests (kind, user_id, trip_id, email, reason)
       VALUES ('GET_NOTIFIED', $1, $2, $3, $4)`,
      [input.userId ?? null, input.tripId ?? null, email || null,
       input.tripId ? 'Asked to be notified about this departure'
                    : 'Asked to be notified about new departures']);
    return { recorded: true as const, alreadyRequested: false };
  });
}

export const _sql = { TRIP_SQL };
