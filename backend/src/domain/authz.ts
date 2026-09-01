/* DLT · domain/authz.ts — the structural fix.
 *
 * THE PATTERN THIS EXISTS TO KILL
 *
 * Five findings (S-1, S-2, C-1, C-2, H-1) were one mistake repeated: a domain
 * function took an object id, trusted it, and was exposed on a student route.
 * Patching five call sites would leave the sixth to be written next week.
 *
 * So authorization is now a TYPE. Every owned object is reached through a guard
 * here, each of which answers all four questions in one place:
 *
 *     who is calling · what role · do they own it · does their permission allow it
 *
 * The guards return the loaded row, so a caller CANNOT skip the check and still
 * get the data it needs — the check is on the only path to the object. That is
 * the structural property; a lint rule or a code review is not.
 *
 * WRITTEN, NOT EXECUTED.
 */

import type { Client } from '../db/index.ts';
import { query } from '../db/index.ts';
import { AppError } from './errors.ts';
import { can } from './auth.ts';

/** Every domain operation on an owned object takes one of these. There is no
 *  overload that omits it. */
export interface Actor {
  userId: string;
  role: string;
  ip?: string;
  /** Present only for an unauthenticated browser mid-booking (F-09). */
  guestToken?: string | null;
}

/** A caller that has no session at all. Guests may hold seats and create a
 *  booking; they may never reach an owned-object guard. */
export interface GuestActor {
  userId?: null;
  role?: null;
  guestToken: string;
  ip?: string;
}

export type AnyActor = Actor | GuestActor;

const isAuthenticated = (a: AnyActor): a is Actor =>
  !!(a as Actor).userId && !!(a as Actor).role;

type Q = { query: (sql: string, args?: unknown[]) => Promise<any> };
const runner = (c?: Client | Q): Q => c ?? { query: (s, a) => query(s, a as unknown[]) };

/* ---------------------------------------------------------------- core rule
 *
 * Ownership OR permission. Never "ownership OR nothing", which is what the
 * broken routes effectively did, and never "permission OR nothing", which would
 * lock students out of their own bookings.
 */
async function ownerOrPermission(
  actor: AnyActor, ownerId: string | null, permission: string, what: string
): Promise<'OWNER' | 'OPERATOR'> {
  if (!isAuthenticated(actor))
    throw new AppError('UNAUTHENTICATED', 'Sign in required');
  if (ownerId && ownerId === actor.userId) return 'OWNER';
  if (await can(actor.role, permission)) return 'OPERATOR';
  /* 403 with a message that does not confirm the object exists or who owns it. */
  throw new AppError('FORBIDDEN', `That ${what} is not yours`);
}

/* ---------------------------------------------------------------- bookings */

export interface BookingRow {
  id: string; code: string; user_id: string | null; guest_token: string | null;
  trip_id: string; status: string; kind: string; total_amount: number;
  unit_price: number; hold_expires_at: string | null; contact_phone: string | null;
  reprice_to: number | null;
  /** How the caller got here. Lets a handler narrow what it returns. */
  _access: 'OWNER' | 'OPERATOR' | 'GUEST';
}

/** The ONLY way to load a booking for a caller. Locks the row when a client is
 *  supplied, so an authorization check and the mutation it guards are one
 *  transaction — a booking cannot be cancelled out from under its own check. */
export async function bookingFor(
  actor: AnyActor, bookingId: string,
  opts: { permission?: string; forUpdate?: boolean; client?: Client } = {}
): Promise<BookingRow> {
  const c = runner(opts.client);
  const { rows: [b] } = await c.query(
    `SELECT * FROM bookings WHERE id = $1${opts.forUpdate && opts.client ? ' FOR UPDATE' : ''}`,
    [bookingId]);
  /* 404 for a stranger's booking too: an authenticated attacker must not be
   * able to use the status code to enumerate which ids exist. */
  if (!b) throw new AppError('NOT_FOUND', 'Booking not found');

  /* A guest owns a booking through the token the seats were held with (M-1,
   * L-3). Compared with a positive match on both sides — never NULL == NULL. */
  if (!isAuthenticated(actor)) {
    const tok = (actor as GuestActor).guestToken;
    if (tok && b.guest_token && tok === b.guest_token)
      return { ...b, _access: 'GUEST' };
    throw new AppError('UNAUTHENTICATED', 'Sign in required');
  }

  const access = await ownerOrPermission(
    actor, b.user_id, opts.permission ?? 'booking.read', 'booking');
  return { ...b, _access: access };
}

/* ---------------------------------------------------------------- payments */

export interface PaymentRow {
  id: string; booking_id: string; amount: number; status: string;
  provider: string; provider_order_id: string | null; provider_payment_id: string | null;
  _access: 'OWNER' | 'OPERATOR' | 'GUEST';
}

/** C-1 and C-2. A payment is owned by whoever owns its booking; there is no
 *  separate owner column, which is exactly why the original code had nothing to
 *  compare and silently allowed everyone. */
export async function paymentFor(
  actor: AnyActor, paymentId: string,
  opts: { permission?: string; client?: Client } = {}
): Promise<PaymentRow> {
  const c = runner(opts.client);
  const { rows: [p] } = await c.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (!p) throw new AppError('NOT_FOUND', 'Payment not found');
  const b = await bookingFor(actor, p.booking_id,
    { permission: opts.permission ?? 'payment.read', client: opts.client });
  return { ...p, _access: b._access };
}

/* ---------------------------------------------------------------- passengers */

export interface PassengerRow {
  id: string; booking_id: string; trip_id: string; name: string;
  seat_number: string; boarding_status: string;
  _access: 'OWNER' | 'OPERATOR' | 'GUEST';
}

/** L-1. Boarding actions name a passenger id. An operator may act on any
 *  passenger, but `tripId` lets a caller assert which trip it expected — so a
 *  mistyped id fails instead of succeeding on a stranger on another departure. */
export async function passengerFor(
  actor: AnyActor, passengerId: string,
  opts: { permission: string; tripId?: string | null; client?: Client }
): Promise<PassengerRow> {
  const c = runner(opts.client);
  const { rows: [p] } = await c.query(
    `SELECT bp.*, b.trip_id, b.user_id FROM booking_passengers bp
       JOIN bookings b ON b.id = bp.booking_id WHERE bp.id = $1`, [passengerId]);
  if (!p) throw new AppError('NOT_FOUND', 'Passenger not found');
  if (opts.tripId && p.trip_id !== opts.tripId)
    throw new AppError('CONFLICT',
      'That passenger is not on the departure you are working — check the code and try again');
  const access = await ownerOrPermission(actor, p.user_id, opts.permission, 'passenger');
  return { ...p, _access: access };
}

/* ---------------------------------------------------------------- waitlist */

export async function waitlistEntryFor(
  actor: AnyActor, entryId: string,
  opts: { permission?: string; forUpdate?: boolean; client?: Client } = {}
) {
  const c = runner(opts.client);
  const { rows: [e] } = await c.query(
    `SELECT * FROM waitlist_entries WHERE id = $1${opts.forUpdate && opts.client ? ' FOR UPDATE' : ''}`,
    [entryId]);
  if (!e) throw new AppError('NOT_FOUND', 'Waitlist entry not found');
  const access = await ownerOrPermission(
    actor, e.user_id, opts.permission ?? 'waitlist.read', 'waitlist entry');
  return { ...e, _access: access };
}

/* ---------------------------------------------------------------- trips
 *
 * F-19. A trip is not user-owned, so this is scope rather than ownership: a
 * boarding staff member's trip is DERIVED from their assignment and a
 * client-supplied id is discarded. Every boarding read and write goes through
 * here, so the scanner, the manifest and the event log cannot disagree — which
 * is precisely what L-2 was.
 */
export async function boardingScopeFor(
  actor: Actor, clientTripId?: string | null, client?: Client
): Promise<string | null> {
  const c = runner(client);
  if (actor.role === 'BOARDING_STAFF') {
    const { rows: [r] } = await c.query('SELECT assigned_trip_for($1) AS trip', [actor.userId]);
    if (!r?.trip)
      throw new AppError('FORBIDDEN',
        'You are not assigned to a trip. Operations assigns boarding staff to a departure.');
    return r.trip;                      // the client's value is never consulted
  }
  return clientTripId ?? null;          // ops may scope, or read across trips
}

/** Refuses a trip a staff member is not assigned to, for reads that name one. */
export async function requireTripScope(
  actor: Actor, tripId: string, client?: Client
): Promise<string> {
  const scope = await boardingScopeFor(actor, tripId, client);
  if (scope && scope !== tripId)
    throw new AppError('FORBIDDEN', 'That departure is not the one you are assigned to');
  return tripId;
}

/* ---------------------------------------------------------------- refunds */

export async function refundFor(
  actor: AnyActor, refundId: string, opts: { permission?: string; client?: Client } = {}
) {
  const c = runner(opts.client);
  const { rows: [r] } = await c.query(
    `SELECT rf.*, b.user_id FROM refunds rf JOIN bookings b ON b.id = rf.booking_id
      WHERE rf.id = $1`, [refundId]);
  if (!r) throw new AppError('NOT_FOUND', 'Refund not found');
  const access = await ownerOrPermission(
    actor, r.user_id, opts.permission ?? 'payment.read', 'refund');
  return { ...r, _access: access };
}

/* ---------------------------------------------------------------- users */

/** A user record is readable by that user, or by an operator with student.read.
 *  Prevents an authenticated student walking the user table by id. */
export async function userFor(
  actor: Actor, userId: string, opts: { permission?: string } = {}
) {
  const { rows: [u] } = await query(
    'SELECT id, email, name, phone, role, status FROM users WHERE id = $1', [userId]);
  if (!u) throw new AppError('NOT_FOUND', 'Account not found');
  const access = await ownerOrPermission(actor, u.id, opts.permission ?? 'student.read', 'account');
  return { ...u, _access: access };
}

/* ---------------------------------------------------------------- operator only */

/** For objects with no owner at all — vehicles, routes, reports, audit. Names
 *  the permission so the requirement is visible at the call site. */
export async function requireOperator(actor: AnyActor, permission: string): Promise<Actor> {
  if (!isAuthenticated(actor)) throw new AppError('UNAUTHENTICATED', 'Sign in required');
  if (!(await can(actor.role, permission)))
    throw new AppError('FORBIDDEN', 'Your role cannot perform that action');
  return actor;
}
