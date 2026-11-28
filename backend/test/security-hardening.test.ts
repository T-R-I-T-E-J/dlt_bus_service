import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import argon2 from 'argon2';
import { createApp } from '../src/app.ts';
import { pool, query, close } from '../src/db/index.ts';
import * as auth from '../src/domain/auth.ts';
import { holdSeat, GUEST_HOLD_CEILING_PCT } from '../src/domain/seats.ts';
import { createBooking } from '../src/domain/payments.ts';
import { createPasswordWorkLimiter } from '../src/domain/password-work.ts';
import { outbox } from '../src/integrations/email/index.ts';
import { resetTables } from './_reset.ts';

let server: Server, base: string;
before(() => {
  server = createApp().app.listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await close();
});
beforeEach(async () => {
  await resetTables(pool, 'users, routes, vehicles, trips, audit_logs');
  outbox.length = 0;
});

async function trip() {
  const route = (await query("INSERT INTO routes(code,origin,destination,duration_min) VALUES('SECURITY','Security Origin','Security Destination',90) RETURNING id")).rows[0].id;
  const vehicle = (await query("INSERT INTO vehicles(name,registration,row_count,status) VALUES('Security Coach','TS09SECURITY',11,'AVAILABLE') RETURNING id")).rows[0].id;
  const id = (await query("INSERT INTO trips(route_id,vehicle_id,departure_at,price,status) VALUES($1,$2,now()+interval '3 days',320,'DRAFT') RETURNING id", [route, vehicle])).rows[0].id;
  await query('SELECT materialise_trip_seats($1)', [id]);
  await query("UPDATE trips SET status='OPEN' WHERE id=$1", [id]);
  return id;
}
async function request(path: string, body?: unknown, cookie = '', ip = '198.51.100.40') {
  const response = await fetch(base + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': ip },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result: any = await response.json();
  return { response, status: response.status, body: result };
}

test('an unverified session can read its existing ticket but cannot acquire inventory or checkout until verified', async () => {
  const input = { name: 'Security Student', email: 'security-student@example.invalid', password: 'security-test-password', phone: '9876543210' };
  const signup = await request('/auth/signup', input);
  assert.equal(signup.status, 201);
  const code = String(outbox.at(-1)!.vars.code);
  assert.match(code, /^[A-F0-9]{16}$/);
  const login = await request('/auth/login', { email: input.email, password: input.password });
  assert.equal(login.status, 200);
  const cookie = login.response.headers.getSetCookie().find(s => s.startsWith('dlt_session='))!.split(';')[0];
  const id = await trip();
  const user = signup.body.user.id;

  // A pre-existing paid ticket must remain readable after the new admission rule.
  await holdSeat(id, '1A', { userId: user });
  const booking = await createBooking({ tripId: id, holder: { userId: user }, contactPhone: input.phone,
    passengers: [{ seatNumber: '1A', name: input.name, studentId: 'SEC12345' }], idempotencyKey: 'security-existing-pass' });
  const payment = (await query("INSERT INTO payments(booking_id,amount,status,provider,provider_payment_id) VALUES($1,320,'SUCCESS','RAZORPAY','pay_security_fixture') RETURNING id", [booking.id])).rows[0].id;
  await query('SELECT * FROM settle_booking_v2($1,$2)', [booking.id, payment]);
  const passes = await request(`/bookings/${booking.id}/passes`, undefined, cookie);
  assert.equal(passes.status, 200);
  assert.ok(passes.body.passes[0].qrToken);

  assert.equal((await request(`/trips/${id}/seats/1B/hold`, {}, cookie)).status, 403);
  assert.equal((await request('/bookings', {}, cookie)).status, 403);
  assert.equal((await request('/payments/create', { bookingId: booking.id }, cookie)).status, 403);
  assert.equal((await request(`/trips/${id}/waitlist`, { seatsWanted: 1 }, cookie)).status, 403);
  assert.equal((await request(`/waitlist/${booking.id}/claim`, {}, cookie)).status, 403);
  assert.equal((await request('/auth/me', undefined, cookie)).status, 200);
  assert.equal((await request('/auth/verify-email', { code }, cookie)).status, 200);
  assert.equal((await request(`/trips/${id}/seats/1B/hold`, {}, cookie)).status, 200);
});

test('simultaneous holds from one empty basket never exceed five places', async () => {
  const id = await trip();
  const user = (await query("INSERT INTO users(email,name,role,email_verified_at) VALUES('basket-security@example.invalid','Basket Student','STUDENT',now()) RETURNING id")).rows[0].id;
  const seats = (await query('SELECT seat_number FROM trip_seats WHERE trip_id=$1 ORDER BY seat_number', [id])).rows;
  const results = await Promise.allSettled(seats.map(s => holdSeat(id, s.seat_number, { userId: user })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 5);
  assert.equal((await query("SELECT count(*)::int n FROM trip_seats WHERE trip_id=$1 AND status='HELD'", [id])).rows[0].n, 5);
  assert.equal(results.filter(r => r.status === 'rejected' && /deadlock/.test(String(r.reason))).length, 0);
});

test('simultaneous distinct guests cannot overshoot the exact trip ceiling', async () => {
  const id = await trip();
  const seats = (await query('SELECT seat_number FROM trip_seats WHERE trip_id=$1 ORDER BY seat_number', [id])).rows;
  const results = await Promise.allSettled(seats.map((s, i) => holdSeat(id, s.seat_number,
    { guestToken: `security-guest-${i}`, ip: `198.51.100.${i + 1}` })));
  const ceiling = Math.max(5, Math.floor(seats.length * GUEST_HOLD_CEILING_PCT / 100));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, ceiling);
  assert.equal((await query("SELECT count(*)::int n FROM trip_seats WHERE trip_id=$1 AND status='HELD'", [id])).rows[0].n, ceiling);
});

test('invalid reset codes are rejected without any password hashing', async t => {
  const hashing = t.mock.method(argon2, 'hash', async () => { throw new Error('Invalid code reached KDF'); });
  await assert.rejects(auth.resetPassword('00000000', 'a-new-valid-password'), /expired/);
  assert.equal(hashing.mock.callCount(), 0);
});

test('password admission bounds active work and queue, then recovers after failures', async () => {
  const run = createPasswordWorkLimiter(1, 1);
  let release!: () => void;
  let started = 0;
  const first = run(() => new Promise<void>(resolve => { started += 1; release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const second = run(async () => { started += 1; throw new Error('Expected work failure'); });
  const checkedSecond = assert.rejects(second, /Expected work failure/);
  await assert.rejects(run(async () => { started += 1; }), (error: any) => error.code === 'RATE_LIMITED');
  assert.equal(started, 1);
  release();
  await first;
  await checkedSecond;
  assert.equal(await run(async () => 'recovered'), 'recovered');
});

test('signup and code-route budgets reject requests before expensive work', async t => {
  const hashing = t.mock.method(argon2, 'hash', async () => { throw new Error('Budget test reached KDF'); });
  const signupLimit = Number(process.env.SIGNUP_RATE_LIMIT_PER_MINUTE ?? 240);
  for (let i = 0; i < signupLimit; i++)
    assert.equal((await request('/auth/signup', {}, '', '198.51.100.90')).status, 400);
  const limitedSignup = await request('/auth/signup', {}, '', '198.51.100.90');
  assert.equal(limitedSignup.status, 429);
  assert.equal(limitedSignup.body.error.code, 'RATE_LIMITED');
  const codeLimit = Number(process.env.AUTH_CODE_RATE_LIMIT_PER_MINUTE ?? 480);
  for (let i = 0; i < codeLimit; i++)
    assert.equal((await request('/auth/reset-password', { code: '00000000', password: 'a-new-valid-password' }, '', '198.51.100.91')).status, 400);
  assert.equal((await request('/auth/reset-password', { code: '00000000', password: 'a-new-valid-password' }, '', '198.51.100.91')).status, 429);
  assert.equal(hashing.mock.callCount(), 0);
});
