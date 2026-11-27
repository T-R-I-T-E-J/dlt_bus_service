#!/usr/bin/env node
// One-time infrastructure operation. Promotes an existing verified account only.
// Does not create an account, set passwords, or bypass email verification.
import pg from 'pg';

const [email, reason] = process.argv.slice(2);
if (!email || !reason || reason.trim().length < 10)
  throw new Error('Usage: node scripts/bootstrap-admin.mjs VERIFIED_EMAIL "reason of at least 10 characters"');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await c.connect();
  await c.query('BEGIN');
  await c.query("SELECT pg_advisory_xact_lock(hashtext('dlt.first-admin'))");
  const existing = await c.query("SELECT id FROM users WHERE role='SUPER_ADMIN' LIMIT 1");
  if (existing.rowCount) throw new Error('A Super Admin already exists; use the existing admin workflow.');
  const { rows: [u] } = await c.query(
    'SELECT id, role, status, email_verified_at FROM users WHERE email=$1 FOR UPDATE', [email.trim()]);
  if (!u || u.status !== 'ACTIVE' || !u.email_verified_at)
    throw new Error('The account must already exist, be active, and have verified its email normally.');
  await c.query("UPDATE users SET role='SUPER_ADMIN',updated_at=now() WHERE id=$1", [u.id]);
  await c.query("UPDATE sessions SET revoked_at=now(),revoked_reason='Initial Super Admin bootstrap' WHERE user_id=$1 AND revoked_at IS NULL", [u.id]);
  await c.query(`INSERT INTO audit_logs
    (actor_name,action,entity_type,entity_id,before_value,after_value,reason)
    VALUES ('VPS operator','admin.initial_bootstrap','user',$1,$2,'SUPER_ADMIN',$3)`,
    [u.id, u.role, reason.trim()]);
  await c.query('COMMIT');
  console.log('Initial Super Admin created from the verified account. Sign in again; previous sessions were revoked.');
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
