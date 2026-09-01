#!/usr/bin/env node
/* DLT · scripts/seed-dev.mjs — demo data, DEVELOPMENT ONLY.
 *
 * PRODUCTION_BACKEND.md §2.5 requires that seeded students, trips and payment
 * cases can never reach production. This script enforces that itself rather
 * than relying on nobody running it by mistake:
 *
 *   1. the database name must end in _dev or _test
 *   2. NODE_ENV must not be 'production'
 *   3. the database must be empty of users, or --force is required
 *
 * It is NOT a migration. Migrations describe the schema; demo data does not
 * belong in the schema's history.
 *
 * WRITTEN, NOT EXECUTED.
 */

import pg from 'pg';
import { randomBytes } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const dbName = decodeURIComponent(new URL(url.replace(/^postgres(ql)?:/, 'http:')).pathname.slice(1));

if (process.env.NODE_ENV === 'production') {
  console.error('REFUSING: NODE_ENV=production.');
  process.exit(1);
}
if (!/_(dev|test)$/.test(dbName)) {
  console.error(`REFUSING: database "${dbName}" does not end in _dev or _test.`);
  console.error('Demo data must never reach a production database. Rename, or seed a copy.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

const { rows: [u] } = await client.query('SELECT count(*)::int n FROM users');
if (u.n > 0 && !process.argv.includes('--force')) {
  console.error(`REFUSING: ${dbName} already has ${u.n} user(s). Pass --force to add anyway.`);
  await client.end();
  process.exit(1);
}

/* Passwords are NOT seeded. argon2 hashing belongs to the auth service, and a
 * hash pasted into a seed script is a credential in source control. Create
 * accounts through POST /auth/signup, or set one with:
 *
 *   node --experimental-strip-types -e "import('../src/domain/auth.ts').then(a =>
 *     a.signUp({name:'Aarav Menon', email:'aarav@woxsen.edu.in',
 *               password:process.env.PW, phone:'9876543210'}, {}))"
 */
console.log(`Seeding ${dbName} — routes, vehicles and trips only. No accounts, no passwords.`);

await client.query('BEGIN');

const { rows: [route] } = await client.query(
  `INSERT INTO routes (code, origin, destination, duration_min)
   VALUES ('WX-MYP', 'Woxsen University', 'Miyapur Metro', 75)
   ON CONFLICT (code) DO UPDATE SET origin = EXCLUDED.origin
   RETURNING id`);

const vehicles = [];
for (const [name, reg, rows] of [
  ['DLT-01', 'TS07 UA 1101', 11],
  ['DLT-02', 'TS07 UA 1102', 11],
]) {
  const { rows: [v] } = await client.query(
    `INSERT INTO vehicles (name, registration, row_count) VALUES ($1,$2,$3)
     ON CONFLICT ((upper(replace(registration,' ','')))) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name`, [name, reg, rows]);
  vehicles.push(v);
}

/* Two departures a day for the next week, published and bookable. */
let made = 0;
for (let d = 1; d <= 7; d++) {
  for (const [hour, vehicle] of [[8, vehicles[0]], [17, vehicles[1]]]) {
    const { rows: [t] } = await client.query(
      `INSERT INTO trips (route_id, vehicle_id, departure_at, price, status)
       VALUES ($1, $2, (current_date + $3::int) + ($4::int || ' hours')::interval, 259, 'OPEN')
       RETURNING id`, [route.id, vehicle.id, d, hour]);
    await client.query('SELECT materialise_trip_seats($1)', [t.id]);
    made++;
  }
}

await client.query('COMMIT');
console.log(`Done: 1 route, ${vehicles.length} vehicles, ${made} open trips with seat maps.`);
console.log('Create accounts via POST /auth/signup — no seeded credentials exist.');
await client.end();
