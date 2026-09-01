/* DLT · test/_reset.ts — fixture teardown that clears the append-only audit log.
 *
 * Migration 009 puts a BEFORE TRUNCATE trigger on audit_logs that raises for
 * every role, the table owner included, and `TRUNCATE users … CASCADE` reaches
 * it through audit_logs.actor_id. `SET LOCAL session_replication_role = replica`
 * suspends user triggers for the length of one transaction; it reverts at
 * COMMIT, so the H-3 immutability assertions (their own sessions, default role)
 * still see TRUNCATE / DELETE / UPDATE refused.
 *
 * This MUST run on a single checked-out client, not pool.query('BEGIN; …'):
 * a multi-statement string through the pool leaves the connection's transaction
 * state opaque to node-pg, and a later pool.connect() can receive it mid-txn.
 */
import type { Pool } from 'pg';

export async function resetTables(pool: Pool, tableList: string): Promise<void> {
  const c = await pool.connect();
  try {
    /* Defensive: a test that left its connection in an aborted transaction
     * would otherwise make every later reset fail with 25P02. */
    await c.query('ROLLBACK').catch(() => { /* nothing open */ });
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(`TRUNCATE ${tableList} RESTART IDENTITY CASCADE`);
    await c.query('COMMIT');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw e;
  } finally {
    c.release();
  }
}
