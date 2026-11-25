#!/usr/bin/env node
// Destructive load fixtures ONLY in a disposable local test database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import argon2 from 'argon2';

const target = new URL(process.env.DATABASE_URL || 'postgres://invalid/invalid');
if (process.env.NODE_ENV !== 'test' || !['localhost', '127.0.0.1'].includes(target.hostname)
  || !/^\/dlt_phase1_test(?:_|$)/.test(target.pathname))
  throw new Error('Burst fixtures require NODE_ENV=test and a disposable local dlt_phase1_test database. Never run against production.');
const { createApp } = await import('../src/app.ts');
const { resetTables } = await import('../test/_reset.ts');
const { close } = await import('../src/db/index.ts');
const { closeCache } = await import('../src/domain/cache.ts');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sha = text => createHash('sha256').update(text).digest('hex');
const password = 'disposable-burst-check-password';
let server;
const summary = [];
try {
  await resetTables(db, 'users, routes, vehicles, trips, audit_logs');
  const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const clients = [];
  for (let i = 0; i < 200; i++) {
    const { rows: [u] } = await db.query(`INSERT INTO users(email,name,role,phone,email_verified_at)
      VALUES ($1,$2,'STUDENT','9876543210',now()) RETURNING id`, [`burst${i}@example.com`, `Burst Student ${i}`]);
    await db.query('INSERT INTO user_credentials(user_id,password_hash) VALUES($1,$2)', [u.id, hash]);
    const token = `disposable-burst-${i}`;
    await db.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day')", [u.id, sha(token)]);
    clients.push({ id: u.id, cookie: `dlt_session=${token}`, email: `burst${i}@example.com` });
  }
  const { rows: [route] } = await db.query("INSERT INTO routes(code,origin,destination,duration_min) VALUES('BURST','Woxsen','Miyapur',75) RETURNING id");
  const { rows: [vehicle] } = await db.query("INSERT INTO vehicles(name,registration,row_count) VALUES('Burst Test','TS07 AA 9999',11) RETURNING id");
  const { rows: [trip] } = await db.query(`INSERT INTO trips(route_id,vehicle_id,departure_at,price,status)
    VALUES($1,$2,now()+interval '3 days',320,'DRAFT') RETURNING id`, [route.id, vehicle.id]);
  await db.query('SELECT materialise_trip_seats($1)', [trip.id]);
  await db.query("UPDATE trips SET status='OPEN' WHERE id=$1", [trip.id]);
  server = createApp().app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, { client, method = 'GET', body, headers = {} } = {}) => {
    const start = performance.now();
    const r = await fetch(base + path, { method, signal: AbortSignal.timeout(30_000),
      headers: { ...(client ? { Cookie: client.cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = { text }; }
    return { status: r.status, data, ms: performance.now() - start };
  };
  const record = (name, results) => {
    const statuses = {}; for (const r of results) statuses[r.status] = (statuses[r.status] || 0) + 1;
    const times = results.map(r => r.ms).sort((a,b) => a-b);
    summary.push({ name, requests: results.length, statuses, p95ms: Math.round(times[Math.ceil(times.length * .95) - 1]) });
    assert.ok(results.every(r => r.status < 500), `${name}: unexpected server error ${JSON.stringify(statuses)}`);
  };
  for (const count of [100, 200]) {
    const reads = await Promise.all(clients.slice(0, count).map(client => request(`/trips/${trip.id}/seats`, { client })));
    record(`${count} concurrent seat-map readers`, reads); assert.ok(reads.every(r => r.status === 200));
  }
  const holds = await Promise.all(clients.map(client => request(`/trips/${trip.id}/seats/2B/hold`, { client, method: 'POST', body: {} })));
  record('200 clients race for one seat', holds);
  assert.equal(holds.filter(r => r.status === 200).length, 1);
  assert.equal(holds.filter(r => r.status === 409).length, 199);
  const winner = clients[holds.findIndex(r => r.status === 200)];
  const input = { tripId: trip.id, contactPhone: '9876543210', passengers: [{ seatNumber: '2B', name: 'Burst Passenger', studentId: 'WU90001', phone: '9876543210' }] };
  const bookings = await Promise.all(Array.from({ length: 200 }, () => request('/bookings', {
    client: winner, method: 'POST', body: input, headers: { 'Idempotency-Key': 'disposable-burst-booking' },
  })));
  record('200 duplicate booking clicks', bookings);
  assert.ok(bookings.every(r => r.status === 201));
  assert.equal(new Set(bookings.map(r => r.data.booking.id)).size, 1);
  const booking = bookings[0].data.booking;
  const { rows: [payment] } = await db.query(`INSERT INTO payments(booking_id,amount,status,provider,provider_order_id,provider_payment_id)
    VALUES($1,320,'SUCCESS','RAZORPAY','disposable_burst_order','disposable_burst_payment') RETURNING id`, [booking.id]);
  await db.query('SELECT settle_booking($1,$2)', [booking.id, payment.id]);
  const { rows: [seat] } = await db.query("SELECT status,booking_id FROM trip_seats WHERE trip_id=$1 AND seat_number='2B'", [trip.id]);
  assert.equal(seat.status, 'BOOKED'); assert.equal(seat.booking_id, booking.id);
  assert.equal((await db.query('SELECT count(*)::int n FROM bookings WHERE trip_id=$1', [trip.id])).rows[0].n, 1);
  const logins = await Promise.all(clients.map(client => request('/auth/login', {
    method: 'POST', body: { email: client.email, password }, headers: { 'X-Forwarded-For': '192.0.2.200' },
  })));
  record('200 legitimate logins behind one campus IP', logins);
  assert.ok(logins.every(r => r.status === 200), `Campus login burst was throttled: ${JSON.stringify(summary.at(-1))}`);
  const { rows: [staff] } = await db.query("INSERT INTO users(email,name,role) VALUES('burststaff@example.com','Burst Staff','BOARDING_STAFF') RETURNING id");
  await db.query('INSERT INTO trip_staff(trip_id,user_id,assigned_by) VALUES($1,$2,$3)', [trip.id, staff.id, clients[0].id]);
  await db.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day')", [staff.id, sha('burst-staff-token')]);
  // Historical fixture: the confirmed ticket was bought before boarding opened.
  const fixture = await db.connect();
  try {
    await fixture.query('BEGIN');
    await fixture.query('SET LOCAL session_replication_role=replica');
    await fixture.query("UPDATE trips SET status='BOARDING',departure_at=now()+interval '10 minutes' WHERE id=$1", [trip.id]);
    await fixture.query('COMMIT');
  } finally { fixture.release(); }
  const { rows: [pass] } = await db.query('SELECT qr_token FROM boarding_passes WHERE booking_id=$1', [booking.id]);
  const scans = await Promise.all(Array.from({ length: 100 }, () => request('/boarding/scan', {
    client: { cookie: 'dlt_session=burst-staff-token' }, method: 'POST', body: { code: pass.qr_token },
  })));
  record('100 simultaneous scans of one pass', scans);
  assert.equal(scans.filter(r => r.data.result === 'VALID').length, 1);
  assert.equal(scans.filter(r => r.data.result === 'ALREADY BOARDED').length, 99);
  console.log('[burst] PASSED: one seat, one booking, one successful boarding; no 5xx responses.');
} finally {
  console.log('[burst] ' + JSON.stringify(summary));
  if (server) await new Promise(resolve => server.close(resolve));
  await Promise.all([db.end(), close(), closeCache()]);
}
