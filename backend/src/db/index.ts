/* DLT · db/index.ts — the connection pool and the transaction helper.
 *
 * Imported by all six domain modules and was MISSING until the consistency
 * audit: the backend could not have compiled or started. Nothing here contains
 * business logic; it exists so `query` and `tx` mean the same thing everywhere.
 *
 * WRITTEN, NOT EXECUTED.
 */

import pg from 'pg';

/* Money is integer rupees everywhere in this schema, but NUMERIC/BIGINT come
 * back from pg as strings by default. Parse them once, here, rather than
 * discovering a string where a number was expected somewhere in the money path.
 * bigint (20) is left as a string on purpose — audit_logs.id can exceed
 * Number.MAX_SAFE_INTEGER and is only ever used as an opaque cursor. */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v === null ? null : Number(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  /* A statement that runs longer than this is a bug, not a slow query. Bounded
   * so one pathological query cannot hold a seat row lock indefinitely and
   * stall every student trying to book. */
  statement_timeout: Number(process.env.PGSTATEMENT_TIMEOUT ?? 10_000),
});

pool.on('error', (err) => {
  /* An idle client erroring must not take the process down. */
  console.error('[db] idle client error', err.message);
});

export type Client = pg.PoolClient;

/** A one-shot query on a pooled connection. */
export function query(sql: string, params: unknown[] = []) {
  return pool.query(sql, params);
}

/** Runs `fn` inside a transaction: BEGIN, then COMMIT, or ROLLBACK on any
 *  throw. Every domain mutation goes through this, which is what makes an
 *  action and its audit entry atomic — a rollback loses both rather than
 *  recording something that never happened. */
export async function tx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw e;
  } finally {
    c.release();
  }
}

/** Startup check. Refuses to run against a database that has not been migrated,
 *  or against a PostgreSQL too old for the partial indexes the seat constraints
 *  depend on. Better to fail at boot than to fail on the first seat. */
export async function assertReady(): Promise<{ version: number; migrations: number; auditAppendOnly: boolean }> {
  const { rows: [v] } = await query('SHOW server_version_num');
  const version = Number(v.server_version_num);
  if (version < 150000)
    throw new Error(`PostgreSQL 15+ required (found ${version}) — the seat constraints use features 14 lacks`);

  const { rows: [m] } = await query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_name = 'schema_migrations'`);
  if (!m.n) throw new Error('Database has no schema_migrations table — run the migrations first');

  const { rows: [applied] } = await query('SELECT count(*)::int AS n FROM schema_migrations');
  if (applied.n < 18)
    throw new Error(`Only ${applied.n} of 18 migrations applied — run the migrations first`);

  /* H-3 layer 3 · FAIL CLOSED on audit-log privilege.
   *
   * Migration 009 revokes DELETE/UPDATE from dlt_app and adds triggers that bind
   * even the table owner. This asserts the role we are ACTUALLY connected as
   * cannot mutate the audit trail — because the failure mode being guarded
   * against is a deployment that connects as the migration owner by mistake,
   * which no migration can prevent.
   *
   * Refusing to boot is deliberate: an audit trail that can be rewritten is
   * worse than an outage, because every reason-mandatory workflow depends on it. */
  const { rows: [priv] } = await query(
    `SELECT has_table_privilege(current_user,'audit_logs','DELETE') AS del,
            has_table_privilege(current_user,'audit_logs','UPDATE') AS upd,
            has_table_privilege(current_user,'audit_logs','INSERT') AS ins,
            current_user AS role`);

  if (!priv.ins)
    throw new Error(`Runtime role "${priv.role}" cannot INSERT into audit_logs — grant SELECT, INSERT.`);

  if (priv.del || priv.upd) {
    /* The triggers still refuse the operation, so this is defence in depth
     * rather than the only control — but a misconfigured role must be visible
     * at boot, not discovered during an incident. */
    const detail = [priv.del && 'DELETE', priv.upd && 'UPDATE'].filter(Boolean).join(' and ');
    if (process.env.ALLOW_AUDIT_PRIVILEGE === 'i-understand-the-risk') {
      console.error('[db] WARNING: role "%s" holds %s on audit_logs. ' +
        'Triggers still refuse it, but this role is over-privileged. ' +
        'Connect as dlt_app in production.', priv.role, detail);
    } else {
      throw new Error(
        `Runtime role "${priv.role}" holds ${detail} on audit_logs. ` +
        'Admin Spec §9–§10 requires an append-only audit trail. Connect as dlt_app ' +
        '(migration 009 creates it), or set ALLOW_AUDIT_PRIVILEGE=i-understand-the-risk ' +
        'for local development.');
    }
  }

  return { version, migrations: applied.n, auditAppendOnly: !priv.del && !priv.upd };
}

export async function close(): Promise<void> {
  await pool.end();
}
