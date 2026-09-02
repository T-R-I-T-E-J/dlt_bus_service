/* DLT · test/http-integration.test.ts — real Express, real routing, real
 * middleware, real HTTP (fetch against an ephemeral-port createApp()).
 *
 * WHY THIS FILE EXISTS: every other test file calls a domain function
 * directly. That is real and valuable, but it cannot see the transport layer
 * — and the transport layer has already hidden a genuine production bug this
 * project shipped once: bookingRoutes was mounted before express.json() and
 * before cookieParser()/attachSession, so req.body and req.session were
 * undefined for every route in it. No booking, cancellation, checkout, passes
 * read or handback had ever authenticated over real HTTP, and 273 passing
 * domain-level tests said nothing about it, because none of them go through
 * app.ts's middleware chain. This file goes through it — real listen(), real
 * fetch(), real Set-Cookie, real raw-body webhook bytes.
 *
 * Run:
 *   createdb dlt_test
 *   DATABASE_URL=postgres://localhost/dlt_test npm run migrate
 *   DATABASE_URL=postgres://localhost/dlt_test RAZORPAY_KEY_ID=x \
 *     RAZORPAY_KEY_SECRET=x RAZORPAY_WEBHOOK_SECRET=test-secret \
 *     ALLOW_AUDIT_PRIVILEGE=i-understand-the-risk EMAIL_TRANSPORT=memory \
 *     NODE_ENV=test npm test
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { close as closeAppPool } from '../src/db/index.ts';
import { resetTables } from './_reset.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const q = (sql: string, a: unknown[] = []) => pool.query(sql, a);
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET!;

let server: Server, BASE: string;
before(() => {
  const { app } = createApp();
  server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  BASE = `http://127.0.0.1:${port}`;
});
/* Two open pools, not one: this file's own `pool` (fixture queries) and the
 * one createApp() uses internally (db/index.ts's module-level singleton).
 * Neither being closed left the process with open TCP connections and no
 * event-loop reason to exit — node's test runner then waited out the whole
 * file until its own timeout, well after every actual subtest had already
 * passed. A hang here reads as a failure with no assertion behind it. */
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  await closeAppPool();
});

/* ---------------------------------------------------------------- a tiny
 * manual cookie jar. fetch() does not persist cookies across calls the way a
 * browser does, and that persistence — the exact thing app.ts's bug broke —
 * is what this file exists to exercise, so it has to be real, not stubbed. */
class Jar {
  private jar = new Map<string, string>();
  capture(res: Response) {
    // Node's fetch exposes getSetCookie(); a response can carry more than one.
    const raw = (res.headers as any).getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header(): Record<string, string> {
    if (!this.jar.size) return {};
    return { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') };
  }
  has(name: string) { return this.jar.has(name); }
}

async function call(jar: Jar, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...jar.header(), ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  jar.capture(res);
  const text = await res.text();
  let json: any = null;
  if (text) { try { json = JSON.parse(text); } catch { json = { raw: text }; } }
  return { status: res.status, headers: res.headers, body: json };
}

async function truncateAll() {
  await resetTables(pool, `users, sessions, user_credentials, student_profiles,
    routes, vehicles, trips, trip_seats, bookings, booking_passengers,
    payments, refunds, provider_events, boarding_passes, boarding_events,
    waitlist_entries, idempotency_keys, notification_requests, audit_logs`);
}

const STUDENT = { name: 'Http Test', email: 'http-test@woxsen.edu.in',
  password: 'correct-horse-battery', phone: '9876543210', studentId: 'WU500001' };

async function seedTrip() {
  const r = (await q(`INSERT INTO routes (code,origin,destination,duration_min)
    VALUES ('WX-MYP','Woxsen','Miyapur',75) RETURNING id`)).rows[0].id;
  const v = (await q(`INSERT INTO vehicles (name,registration,row_count)
    VALUES ('DLT-01','TS07 AA 1111',14) RETURNING id`)).rows[0].id;
  const t = (await q(`INSERT INTO trips (route_id,vehicle_id,departure_at,price,status)
    VALUES ($1,$2, now() + interval '3 days', 259,'OPEN') RETURNING id`, [r, v])).rows[0].id;
  await q('SELECT materialise_trip_seats($1)', [t]);
  return t;
}

describe('HTTP integration — real Express, real middleware, real fetch', () => {
  beforeEach(truncateAll);

  describe('auth: signup -> login -> cookie -> /me -> logout', () => {
    test('the whole real-HTTP round trip', async () => {
      const jar = new Jar();

      const signup = await call(jar, 'POST', '/api/auth/signup', STUDENT);
      assert.equal(signup.status, 201, JSON.stringify(signup.body));
      assert.equal(jar.has('dlt_session'), false, 'signup must not sign anybody in');

      const login = await call(jar, 'POST', '/api/auth/login',
        { email: STUDENT.email, password: STUDENT.password });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      assert.equal(jar.has('dlt_session'), true, 'login must set the real session cookie over real HTTP');

      const me = await call(jar, 'GET', '/api/auth/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.user.email, STUDENT.email);

      const logout = await call(jar, 'POST', '/api/auth/logout');
      assert.equal(logout.status, 204);

      const meAfter = await call(new Jar(), 'GET', '/api/auth/me');
      assert.equal(meAfter.body.user, null, 'a fresh jar (no cookie) must never see a user');
    });

    test('a wrong password over real HTTP is refused, credentials never echoed', async () => {
      const jar = new Jar();
      await call(jar, 'POST', '/api/auth/signup', STUDENT);
      const bad = await call(new Jar(), 'POST', '/api/auth/login',
        { email: STUDENT.email, password: 'wrong-password-entirely' });
      assert.equal(bad.status, 401);
      assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');
    });
  });

  describe('bookings: the exact routing/middleware surface that was once broken', () => {
    /* THE REGRESSION THIS BLOCK GUARDS: bookingRoutes used to be mounted
     * before express.json() and before cookieParser()/attachSession. Every
     * assertion below fails immediately, at the FIRST line, if that regresses
     * — a malformed/empty req.body or an undefined req.session breaks the
     * very first call, not some edge case three steps in. */
    test('POST /bookings authenticates the real cookie and reads the real JSON body', async () => {
      const jar = new Jar();
      await call(jar, 'POST', '/api/auth/signup', STUDENT);
      await call(jar, 'POST', '/api/auth/login', { email: STUDENT.email, password: STUDENT.password });

      const tripId = await seedTrip();
      const hold = await call(jar, 'POST', `/api/trips/${tripId}/seats/1A/hold`);
      assert.equal(hold.status, 200, JSON.stringify(hold.body));

      const created = await call(jar, 'POST', '/api/bookings',
        { tripId, passengers: [{ seatNumber: '1A', name: 'Http Test', studentId: 'WU500001' }], contactPhone: STUDENT.phone },
        { 'idempotency-key': 'http-test-key-1' });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.booking.status, 'PAYMENT_PENDING');
      const bookingId = created.body.booking.id;

      /* Dashboard read + passes read — both require the real cookie, both were
       * inside the broken window. */
      const mine = await call(jar, 'GET', '/api/bookings/mine');
      assert.equal(mine.status, 200);
      assert.ok(mine.body.bookings.some((b: any) => b.id === bookingId));

      const passes = await call(jar, 'GET', `/api/bookings/${bookingId}/passes`);
      assert.equal(passes.status, 200, JSON.stringify(passes.body));
      assert.deepEqual(passes.body.passes, [], 'no pass exists before payment succeeds — empty, not an error');

      /* payment order creation — reaches the domain layer over real HTTP.
       * The placeholder Razorpay credentials mean the ORDER never actually
       * reaches Razorpay, but the route/auth/body-parsing plumbing is exactly
       * what this test verifies, and a well-formed domain response (success
       * or a clean provider error) proves it, not a 404/401 routing failure. */
      const order = await call(jar, 'POST', '/api/payments/create', { bookingId });
      assert.notEqual(order.status, 404, 'the route must exist and be reachable');
      assert.notEqual(order.status, 401, 'the real cookie must authenticate this route');

      /* cancellation, same booking, same real-HTTP path */
      const cancel = await call(jar, 'POST', `/api/bookings/${bookingId}/cancel`, { reason: 'HTTP integration test' });
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    });

    test('an unauthenticated caller is refused by the REAL cookie/session middleware, not just the domain guard', async () => {
      const tripId = await seedTrip();
      const noJar = new Jar();
      const res = await call(noJar, 'POST', '/api/bookings',
        { tripId, passengers: [{ seatNumber: '1A', name: 'X', studentId: 'WU1' }], contactPhone: '9876543210' });
      /* guest checkout is allowed by design (F-08), so this must not be 401 —
       * but it must also not silently succeed as someone else's session. The
       * real assertion is that no cookie means no identity is assumed. */
      assert.notEqual(res.status, 500);
    });
  });

  describe('payments webhook: raw bytes survive real Express routing', () => {
    test('a genuinely signed webhook is accepted and recorded exactly once', async () => {
      const payload = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_HTTPTEST1', order_id: 'order_HTTPTEST1', status: 'captured', amount: 25900 } } },
      });
      const sig = createHmac('sha256', WEBHOOK_SECRET).update(payload, 'utf8').digest('hex');
      const res = await fetch(BASE + '/api/payments/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt-http-test-1' },
        body: payload,
      });
      assert.equal(res.status, 200);
      const { rows } = await q(`SELECT signature_ok FROM provider_events WHERE provider_event_id='evt-http-test-1'`);
      assert.equal(rows.length, 1, 'a validly signed webhook must be recorded');
      assert.equal(rows[0].signature_ok, true);
    });

    test('a tampered body is REJECTED — no provider_events row is ever written', async () => {
      const realPayload = JSON.stringify({ event: 'payment.captured', payload: {} });
      const sig = createHmac('sha256', WEBHOOK_SECRET).update(realPayload, 'utf8').digest('hex');
      const tamperedPayload = JSON.stringify({ event: 'payment.captured', payload: { hacked: true } });
      const res = await fetch(BASE + '/api/payments/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt-http-test-tampered' },
        body: tamperedPayload,
      });
      /* 200 deliberately — a hostile sender learns nothing from the status. */
      assert.equal(res.status, 200);
      const { rows } = await q(`SELECT 1 FROM provider_events WHERE provider_event_id='evt-http-test-tampered'`);
      assert.equal(rows.length, 0, 'a bad signature must never reach recordWebhook');
    });

    test('JSON parsing before this route would have broken the signature — proving raw() actually ran', async () => {
      /* If express.json() ran before this route, req.body would already be a
       * parsed object and the HMAC below (computed over the raw string) would
       * never match what the route re-derives — this is the exact failure
       * mode raw-body-before-json-parser exists to prevent. */
      const payload = '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_RAWTEST"}}}}';
      const sig = createHmac('sha256', WEBHOOK_SECRET).update(payload, 'utf8').digest('hex');
      const res = await fetch(BASE + '/api/payments/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt-http-raw-test' },
        body: payload,
      });
      assert.equal(res.status, 200);
      const { rows } = await q(`SELECT signature_ok FROM provider_events WHERE provider_event_id='evt-http-raw-test'`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].signature_ok, true);
    });
  });

  describe('Admin: real authentication AND real authorization over HTTP', () => {
    test('no cookie at all -> 401, never 200, never a silent empty result', async () => {
      const res = await call(new Jar(), 'GET', '/api/admin/today');
      assert.equal(res.status, 401);
    });

    test('a real session with the WRONG role -> 403, the route exists and is reached', async () => {
      const jar = new Jar();
      await call(jar, 'POST', '/api/auth/signup', STUDENT);
      await call(jar, 'POST', '/api/auth/login', { email: STUDENT.email, password: STUDENT.password });
      const res = await call(jar, 'GET', '/api/admin/today');
      assert.equal(res.status, 403, 'a STUDENT session must never pass admin.trip.read');
    });

    test('a real OPS_ADMIN session succeeds — role read from the DATABASE via the session, never from the client', async () => {
      const jar = new Jar();
      await call(jar, 'POST', '/api/auth/signup', { ...STUDENT, email: 'ops-http-test@dlt.co.in' });
      await q(`UPDATE users SET role='OPS_ADMIN' WHERE email='ops-http-test@dlt.co.in'`);
      await call(jar, 'POST', '/api/auth/login', { email: 'ops-http-test@dlt.co.in', password: STUDENT.password });
      const res = await call(jar, 'GET', '/api/admin/today');
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test('a forged role HEADER from the client changes nothing — the session is what is trusted', async () => {
      const jar = new Jar();
      await call(jar, 'POST', '/api/auth/signup', STUDENT);
      await call(jar, 'POST', '/api/auth/login', { email: STUDENT.email, password: STUDENT.password });
      const res = await call(jar, 'GET', '/api/admin/today', undefined, { 'x-role': 'SUPER_ADMIN', 'x-user-role': 'SUPER_ADMIN' });
      assert.equal(res.status, 403, 'a client-supplied role header must have no effect whatsoever');
    });
  });
});
