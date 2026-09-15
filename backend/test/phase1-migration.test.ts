import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

function localUrl(database: string) {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required');
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) ||
      !/^\/dlt_phase1_test/.test(url.pathname)) {
    throw new Error('Migration safety test requires the disposable local dlt_phase1_test database');
  }
  url.pathname = `/${database}`;
  return url.toString();
}

async function recreateDatabase(name: string) {
  assert.match(name, /^dlt_phase1_migration_check_\d+$/);
  const admin = new pg.Client({ connectionString: localUrl('postgres') });
  await admin.connect();
  try {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
      [name]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(name: string) {
  assert.match(name, /^dlt_phase1_migration_check_\d+$/);
  const admin = new pg.Client({ connectionString: localUrl('postgres') });
  await admin.connect();
  try {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
      [name]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  } finally {
    await admin.end();
  }
}

async function applyMigrations(c: pg.Client, through: string) {
  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (file > through) break;
    await c.query(await readFile(join(migrationsDir, file), 'utf8'));
  }
}

test('023 converts only eligible future DLT-01 inventories to the verified 40-seat layout', async () => {
  const db = `dlt_phase1_migration_check_${process.pid}`;
  await recreateDatabase(db);
  const c = new pg.Client({ connectionString: localUrl(db) });
  await c.connect();
  try {
    await applyMigrations(c, '022_trip_operational_safety.sql');

    const { rows: [vehicle] } = await c.query(
      `INSERT INTO vehicles (name, registration, row_count)
       VALUES ('DLT-01','TS07 AA 1111',11) RETURNING id`);
    const { rows: [route] } = await c.query(
      `INSERT INTO routes (code, origin, destination, duration_min)
       VALUES ('WXN-MYP','Woxsen','Miyapur',90) RETURNING id`);

    async function seededTrip(daysFromNow: number) {
      const { rows: [trip] } = await c.query(
        `INSERT INTO trips (route_id, vehicle_id, departure_at, price, status)
         VALUES ($1,$2,now() + ($3 || ' days')::interval,259,'DRAFT') RETURNING id`,
        [route.id, vehicle.id, daysFromNow]);
      await c.query('SELECT materialise_trip_seats($1)', [trip.id]);
      return trip.id;
    }

    const eligible = await seededTrip(10);
    const protectedFuture = await seededTrip(11);
    const pastSnapshot = await seededTrip(-10);
    await c.query(
      `UPDATE trip_seats SET status='BLOCKED', block_reason='operator fixture'
        WHERE trip_id=$1 AND seat_number='11A'`,
      [protectedFuture]);

    await c.query(await readFile(join(migrationsDir, '023_vehicle_40_seat_configuration.sql'), 'utf8'));

    const { rows: [v] } = await c.query(
      'SELECT row_count, capacity FROM vehicles WHERE id=$1', [vehicle.id]);
    assert.equal(v.row_count, 10);
    assert.equal(v.capacity, 40);

    const counts = await c.query(
      `SELECT trip_id,
              count(*)::int AS total,
              count(*) FILTER (WHERE seat_row=11)::int AS row11
         FROM trip_seats WHERE trip_id = ANY($1::uuid[]) GROUP BY trip_id`,
      [[eligible, protectedFuture, pastSnapshot]]);
    const byTrip = new Map(counts.rows.map(r => [r.trip_id, r]));
    assert.deepEqual(byTrip.get(eligible), { trip_id: eligible, total: 40, row11: 0 });
    assert.deepEqual(byTrip.get(protectedFuture),
      { trip_id: protectedFuture, total: 44, row11: 4 });
    assert.deepEqual(byTrip.get(pastSnapshot), { trip_id: pastSnapshot, total: 44, row11: 4 });
  } finally {
    await c.end().catch(() => undefined);
    await dropDatabase(db);
  }
});
