#!/usr/bin/env node
/* DLT · scripts/migrate.mjs — the forward-only migration runner.
 *
 * Applies backend/migrations/*.sql in filename order, once each, recording
 * every applied file in schema_migrations. There are deliberately no
 * down-migrations: a mistake in production is fixed by a new forward migration,
 * never by reversing one.
 *
 *   DATABASE_URL=postgres://localhost/dlt_dev node scripts/migrate.mjs
 *   node scripts/migrate.mjs --dry-run     # list what would run
 *
 * WRITTEN, NOT EXECUTED.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'migrations');
const dryRun = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows: [v] } = await client.query('SHOW server_version_num');
if (Number(v.server_version_num) < 150000) {
  console.error(`PostgreSQL 15+ required; found ${v.server_version_num}.`);
  await client.end();
  process.exit(1);
}

/* 001 creates schema_migrations itself, so on a clean database the table does
 * not exist yet and nothing has been applied. */
let applied = new Set();
const { rows: [t] } = await client.query(
  `SELECT count(*)::int n FROM information_schema.tables WHERE table_name='schema_migrations'`);
if (t.n) {
  const { rows } = await client.query('SELECT filename FROM schema_migrations');
  applied = new Set(rows.map(r => r.filename));
}

const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
const pending = files.filter(f => !applied.has(f));

console.log(`${files.length} migration(s) on disk, ${applied.size} applied, ${pending.length} pending.`);
if (!pending.length) { console.log('Nothing to do.'); await client.end(); process.exit(0); }

/* A file that appears BEFORE an already-applied one is a rebased history: the
 * database and the repository disagree about the past. Refuse rather than
 * applying it out of order into a schema that no longer matches its
 * assumptions. */
const highestApplied = files.filter(f => applied.has(f)).pop();
const outOfOrder = pending.filter(f => highestApplied && f < highestApplied);
if (outOfOrder.length) {
  console.error('REFUSING: these migrations sort before the last applied one (%s):', highestApplied);
  outOfOrder.forEach(f => console.error('   ', f));
  console.error('Forward-only means new migrations get later numbers. Renumber them.');
  await client.end();
  process.exit(1);
}

for (const f of pending) {
  if (dryRun) { console.log('would apply', f); continue; }
  const sql = await readFile(join(dir, f), 'utf8');
  process.stdout.write(`applying ${f} ... `);
  try {
    /* Each file owns its own BEGIN/COMMIT, so a failure inside one leaves the
     * database at the previous migration rather than half-migrated. */
    await client.query(sql);
    console.log('ok');
  } catch (e) {
    console.log('FAILED');
    console.error(`\n${f}: ${e.message}\n`);
    if (e.position) {
      const upto = sql.slice(0, Number(e.position));
      console.error('at line', upto.split('\n').length, '—', upto.split('\n').pop().trim());
    }
    await client.end();
    process.exit(1);
  }
}

const { rows: [n] } = await client.query('SELECT count(*)::int n FROM schema_migrations');
console.log(`\nDone. ${n.n} migration(s) recorded.`);
await client.end();
