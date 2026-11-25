#!/usr/bin/env node
// Operator-only role provisioning for a fresh installation. No HTTP endpoint.
import pg from 'pg';
const [email, reason] = process.argv.slice(2);
if (!email || !reason || reason.trim().length < 10)
  throw new Error('Usage: node scripts/configure-boarding-staff.mjs VERIFIED_EMAIL "reason of at least 10 characters"');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await c.connect(); await c.query('BEGIN');
  if (!(await c.query("SELECT id FROM users WHERE role='SUPER_ADMIN' AND status='ACTIVE' LIMIT 1")).rowCount)
    throw new Error('Bootstrap the initial Super Admin before provisioning boarding staff.');
  const { rows: [u] } = await c.query('SELECT id,role,status,email_verified_at FROM users WHERE email=$1 FOR UPDATE', [email.trim()]);
  if (!u || u.status !== 'ACTIVE' || !u.email_verified_at)
    throw new Error('The staff member must register and verify their email normally first.');
  if (u.role !== 'STUDENT') throw new Error('Only an ordinary student account can be provisioned by this setup tool.');
  await c.query("UPDATE users SET role='BOARDING_STAFF',updated_at=now() WHERE id=$1", [u.id]);
  await c.query("UPDATE sessions SET revoked_at=now(),revoked_reason='Boarding staff provisioning' WHERE user_id=$1 AND revoked_at IS NULL", [u.id]);
  await c.query(`INSERT INTO audit_logs(actor_name,action,entity_type,entity_id,before_value,after_value,reason)
    VALUES('VPS operator','admin.staff_provisioned','user',$1,'STUDENT','BOARDING_STAFF',$2)`, [u.id, reason.trim()]);
  await c.query('COMMIT');
  console.log('Boarding role provisioned and audit recorded. The staff member must sign in again and be assigned to a trip.');
} catch (e) {
  await c.query('ROLLBACK').catch(() => {}); console.error(e.message); process.exitCode = 1;
} finally { await c.end(); }
