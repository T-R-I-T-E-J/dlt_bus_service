/* DLT · test/auth.test.ts — integration tests for the authentication layer.
 *
 * These run against a REAL throwaway PostgreSQL database, not a mock. Mocking
 * the database here would test nothing: half of what is being asserted is that
 * a constraint, a trigger or a lock behaves as claimed.
 *
 *   createdb dlt_test
 *   DATABASE_URL=postgres://localhost/dlt_test npm run migrate
 *   DATABASE_URL=postgres://localhost/dlt_test npm test
 *
 * STATUS: WRITTEN, NOT EXECUTED. No Node runtime, no PostgreSQL and no package
 * installer exist in the environment these were authored in. Every assertion
 * below is a claim about what SHOULD happen, not a result that HAS happened.
 * Do not report any of them as passing until they have actually been run.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as auth from '../src/domain/auth.ts';
import { query, tx } from '../src/db/index.ts';
import { AppError } from '../src/domain/errors.ts';
import { outbox } from '../src/integrations/email/index.ts';   // test transport

const STUDENT = { name: 'Aarav Menon', email: 'aarav@woxsen.edu.in',
  password: 'correct-horse-battery', phone: '9876543210', studentId: 'WU204118' };

async function truncateAll() {
  await query(`TRUNCATE users, sessions, user_credentials, student_profiles,
    password_resets, email_verifications, login_attempts, audit_logs RESTART IDENTITY CASCADE`);
}
const codeFromLastEmail = () => outbox.at(-1)!.vars.code as string;
const rejectsWith = async (p: Promise<unknown>, code: string, match?: RegExp) => {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AppError, `expected AppError, got ${e}`);
    assert.equal(e.code, code);
    if (match) assert.match(e.message, match);
    return true;
  });
};

describe('authentication', () => {
  beforeEach(async () => { await truncateAll(); outbox.length = 0; });

  /* ---------------------------------------------------------- signup */

  describe('signup', () => {
    test('creates an account with a profile and no session', async () => {
      const u = await auth.signUp(STUDENT, {});
      assert.equal(u.email, 'aarav@woxsen.edu.in');
      assert.equal(u.role, 'STUDENT');
      assert.equal(u.emailVerified, false);
      assert.equal(u.studentId, 'WU204118');
      const { rows } = await query('SELECT count(*)::int n FROM sessions');
      assert.equal(rows[0].n, 0, 'signup must not sign anybody in');
    });

    test('never stores the password in a recoverable form', async () => {
      await auth.signUp(STUDENT, {});
      const { rows: [c] } = await query('SELECT password_hash, kdf FROM user_credentials');
      assert.equal(c.kdf, 'argon2id');
      assert.ok(c.password_hash.startsWith('$argon2id$'), 'must be an argon2id encoded hash');
      assert.ok(!c.password_hash.includes(STUDENT.password));
    });

    test('two accounts differ in hash even with the same password (per-user salt)', async () => {
      await auth.signUp(STUDENT, {});
      await auth.signUp({ ...STUDENT, email: 'diya@woxsen.edu.in', studentId: 'WU204119' }, {});
      const { rows } = await query('SELECT password_hash FROM user_credentials');
      assert.notEqual(rows[0].password_hash, rows[1].password_hash);
    });

    test('rejects a duplicate email regardless of case', async () => {
      await auth.signUp(STUDENT, {});
      await rejectsWith(auth.signUp({ ...STUDENT, email: 'AARAV@WOXSEN.EDU.IN' }, {}),
        'CONFLICT', /already exists/);
    });

    test('validates name, email, password length and Indian mobile', async () => {
      await rejectsWith(auth.signUp({ ...STUDENT, name: 'Al' }, {}), 'VALIDATION', /full name/);
      await rejectsWith(auth.signUp({ ...STUDENT, email: 'not-an-email' }, {}), 'VALIDATION', /valid email/);
      await rejectsWith(auth.signUp({ ...STUDENT, password: 'short' }, {}), 'VALIDATION', /8 characters/);
      await rejectsWith(auth.signUp({ ...STUDENT, phone: '1234567890' }, {}), 'VALIDATION', /mobile/);
    });

    test('F-15 · signup issues a verification the student can actually use', async () => {
      await auth.signUp(STUDENT, {});
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0].template, 'verify-email');
      const u = await auth.verifyEmail(codeFromLastEmail());
      assert.equal(u.emailVerified, true);
    });

    test('a verification code is single-use and expires', async () => {
      await auth.signUp(STUDENT, {});
      const code = codeFromLastEmail();
      await auth.verifyEmail(code);
      await rejectsWith(auth.verifyEmail(code), 'INVALID', /not valid/);
      await query(`UPDATE email_verifications SET used_at = NULL, expires_at = now() - interval '1 hour'`);
      await rejectsWith(auth.verifyEmail(code), 'INVALID');
    });
  });

  /* ---------------------------------------------------------- login */

  describe('login', () => {
    beforeEach(async () => { await auth.signUp(STUDENT, {}); outbox.length = 0; });

    test('issues a session and returns the token only to the caller', async () => {
      const r = await auth.signIn(STUDENT.email, STUDENT.password, { ip: '10.0.0.1' });
      assert.equal(r.user.email, STUDENT.email);
      assert.ok(r.sessionToken.length >= 32);
      const { rows: [s] } = await query('SELECT token_hash FROM sessions');
      assert.notEqual(s.token_hash, r.sessionToken, 'the raw token must never be stored');
    });

    test('resolves that session, and stops resolving it after sign-out', async () => {
      const r = await auth.signIn(STUDENT.email, STUDENT.password, {});
      assert.equal((await auth.resolveSession(r.sessionToken))?.email, STUDENT.email);
      await auth.signOut(r.sessionToken);
      assert.equal(await auth.resolveSession(r.sessionToken), null);
    });

    test('an expired session does not resolve', async () => {
      const r = await auth.signIn(STUDENT.email, STUDENT.password, {});
      await query(`UPDATE sessions SET expires_at = now() - interval '1 second'`);
      assert.equal(await auth.resolveSession(r.sessionToken), null);
    });

    test('a suspended account cannot sign in, and its live sessions stop resolving', async () => {
      const r = await auth.signIn(STUDENT.email, STUDENT.password, {});
      await query(`UPDATE users SET status = 'SUSPENDED'`);
      assert.equal(await auth.resolveSession(r.sessionToken), null);
      await rejectsWith(auth.signIn(STUDENT.email, STUDENT.password, {}), 'FORBIDDEN', /not active/);
    });

    test('a wrong password and an unknown address are indistinguishable', async () => {
      const a = await auth.signIn(STUDENT.email, 'wrong', {}).catch(e => e);
      const b = await auth.signIn('nobody@woxsen.edu.in', 'wrong', {}).catch(e => e);
      assert.equal(a.message, b.message);
      assert.equal(a.code, b.code);
    });

    test('signing out of all devices revokes every session', async () => {
      const a = await auth.signIn(STUDENT.email, STUDENT.password, {});
      const b = await auth.signIn(STUDENT.email, STUDENT.password, {});
      assert.equal(await auth.signOutEverywhere(a.user.id), 2);
      assert.equal(await auth.resolveSession(a.sessionToken), null);
      assert.equal(await auth.resolveSession(b.sessionToken), null);
    });

    test('F-08 · anonymous seat holds are adopted on sign-in', async () => {
      /* fixture: one OPEN trip with a guest-held seat */
      const seat = await seedGuestHeldSeat('guest-abc');
      const r = await auth.signIn(STUDENT.email, STUDENT.password, { guestToken: 'guest-abc' });
      const { rows: [s] } = await query('SELECT hold_by, hold_guest_token FROM trip_seats WHERE id = $1', [seat]);
      assert.equal(s.hold_by, r.user.id);
      assert.equal(s.hold_guest_token, null);
    });
  });

  /* ---------------------------------------------------------- brute force */

  describe('F-06 · brute-force protection', () => {
    beforeEach(async () => { await auth.signUp(STUDENT, {}); });

    test('locks the account after five failures', async () => {
      for (let i = 0; i < 5; i++)
        await auth.signIn(STUDENT.email, 'wrong', { ip: '10.0.0.1' }).catch(() => {});
      await rejectsWith(auth.signIn(STUDENT.email, STUDENT.password, { ip: '10.0.0.1' }),
        'RATE_LIMITED', /Try again in/);
    });

    test('THE DEFECT: further attempts do not extend the window', async () => {
      for (let i = 0; i < 5; i++)
        await auth.signIn(STUDENT.email, 'wrong', { ip: '10.0.0.1' }).catch(() => {});
      const { rows: [first] } = await query('SELECT locked_until FROM login_attempts WHERE key = $1',
        [`email:${STUDENT.email}`]);
      for (let i = 0; i < 5; i++)
        await auth.signIn(STUDENT.email, 'wrong', { ip: '10.0.0.1' }).catch(() => {});
      const { rows: [after] } = await query('SELECT locked_until FROM login_attempts WHERE key = $1',
        [`email:${STUDENT.email}`]);
      assert.deepEqual(after.locked_until, first.locked_until,
        'a victim must not be lockable indefinitely by a stranger');
    });

    test('a successful sign-in clears the counter', async () => {
      for (let i = 0; i < 3; i++)
        await auth.signIn(STUDENT.email, 'wrong', {}).catch(() => {});
      await auth.signIn(STUDENT.email, STUDENT.password, {});
      const { rows } = await query('SELECT * FROM login_attempts WHERE key = $1', [`email:${STUDENT.email}`]);
      assert.equal(rows.length, 0);
    });

    test('the lockout survives a process restart (it is in the database)', async () => {
      for (let i = 0; i < 5; i++) await auth.signIn(STUDENT.email, 'wrong', {}).catch(() => {});
      const { rows: [l] } = await query('SELECT is_login_locked($1) AS until', [`email:${STUDENT.email}`]);
      assert.ok(l.until, 'in-memory rate limiting would be gone here');
    });
  });

  /* ---------------------------------------------------------- reset */

  describe('F-06 · password reset', () => {
    beforeEach(async () => { await auth.signUp(STUDENT, {}); outbox.length = 0; });

    test('THE DEFECT: the response never contains the code', async () => {
      const r = await auth.requestPasswordReset(STUDENT.email, {});
      assert.deepEqual(r, { sent: true });
      assert.ok(!JSON.stringify(r).includes(codeFromLastEmail()));
    });

    test('the code is stored hashed, never in clear', async () => {
      await auth.requestPasswordReset(STUDENT.email, {});
      const { rows: [p] } = await query('SELECT code_hash FROM password_resets');
      assert.notEqual(p.code_hash, codeFromLastEmail());
      assert.equal(p.code_hash.length, 64);
    });

    test('an unknown address gets the same response and sends nothing', async () => {
      const r = await auth.requestPasswordReset('stranger@woxsen.edu.in', {});
      assert.deepEqual(r, { sent: true });
      assert.equal(outbox.length, 0);
    });

    test('a reset changes the password, is single-use, and kills every session', async () => {
      const live = await auth.signIn(STUDENT.email, STUDENT.password, {});
      await auth.requestPasswordReset(STUDENT.email, {});
      const code = codeFromLastEmail();
      await auth.resetPassword(code, 'a-brand-new-password');
      assert.equal(await auth.resolveSession(live.sessionToken), null, 'an attacker session must die');
      await rejectsWith(auth.signIn(STUDENT.email, STUDENT.password, {}), 'INVALID_CREDENTIALS');
      await auth.signIn(STUDENT.email, 'a-brand-new-password', {});
      await rejectsWith(auth.resetPassword(code, 'yet-another-one'), 'INVALID', /expired/);
    });

    test('an expired code is refused', async () => {
      await auth.requestPasswordReset(STUDENT.email, {});
      await query(`UPDATE password_resets SET expires_at = now() - interval '1 minute'`);
      await rejectsWith(auth.resetPassword(codeFromLastEmail(), 'a-brand-new-password'), 'INVALID');
    });

    test('requesting a new code invalidates the previous one', async () => {
      await auth.requestPasswordReset(STUDENT.email, {});
      const first = codeFromLastEmail();
      await auth.requestPasswordReset(STUDENT.email, {});
      await rejectsWith(auth.resetPassword(first, 'a-brand-new-password'), 'INVALID');
      await auth.resetPassword(codeFromLastEmail(), 'a-brand-new-password');
    });

    test('changing a password requires the current one and re-authenticates', async () => {
      const s = await auth.signIn(STUDENT.email, STUDENT.password, {});
      await rejectsWith(auth.changePassword(s.user.id, 'not-it', 'a-brand-new-password'),
        'INVALID_CREDENTIALS');
      await auth.changePassword(s.user.id, STUDENT.password, 'a-brand-new-password');
      assert.equal(await auth.resolveSession(s.sessionToken), null);
    });
  });

  /* ---------------------------------------------------------- authorization */

  describe('role enforcement', () => {
    test('permissions come from the database, per role', async () => {
      assert.equal(await auth.can('STUDENT', 'boarding.scan'), false);
      assert.equal(await auth.can('BOARDING_STAFF', 'boarding.scan'), true);
      assert.equal(await auth.can('BOARDING_STAFF', 'boarding.manual'), false,
        'least privilege: staff scan, they do not board by hand');
      assert.equal(await auth.can('BOARDING_STAFF', 'report.read'), false);
      assert.equal(await auth.can('OPS_ADMIN', 'refund.create'), true);
      assert.equal(await auth.can('OPS_ADMIN', 'refund.override'), false,
        'F-12 · the policy override is Super Admin only');
      assert.equal(await auth.can('SUPER_ADMIN', 'refund.override'), true);
      assert.equal(await auth.can('OPS_ADMIN', 'booking.manual'), false);
      assert.equal(await auth.can('SUPER_ADMIN', 'booking.manual'), true);
    });

    test('SUPER_ADMIN holds everything OPS_ADMIN holds', async () => {
      const { rows } = await query(
        `SELECT permission FROM role_permissions WHERE role='OPS_ADMIN'
         EXCEPT SELECT permission FROM role_permissions WHERE role='SUPER_ADMIN'`);
      assert.equal(rows.length, 0);
    });

    test('requirePermission throws FORBIDDEN rather than returning false', async () => {
      await rejectsWith(auth.requirePermission('STUDENT', 'refund.override'), 'FORBIDDEN');
    });

    test('a role change revokes live sessions, so a demoted admin loses admin', async () => {
      await auth.signUp(STUDENT, {});
      const s = await auth.signIn(STUDENT.email, STUDENT.password, {});
      await query(`UPDATE users SET role='OPS_ADMIN' WHERE id=$1`, [s.user.id]);
      await query('SELECT revoke_user_sessions($1,$2)', [s.user.id, 'role changed']);
      assert.equal(await auth.resolveSession(s.sessionToken), null);
    });
  });

  /* ---------------------------------------------------------- disclosure */

  describe('what must never leave the server', () => {
    test('the public user projection carries no secret of any kind', async () => {
      const u = await auth.signUp(STUDENT, {});
      const keys = Object.keys(u);
      for (const forbidden of ['passwordHash', 'password_hash', 'passwordSalt', 'kdf',
        'resetToken', 'verifyToken', 'code', 'token', 'sessionToken'])
        assert.ok(!keys.includes(forbidden), `${forbidden} must not be exposed`);
    });

    test('audit entries record auth events without recording secrets', async () => {
      await auth.signUp(STUDENT, {});
      await auth.requestPasswordReset(STUDENT.email, {});
      const { rows } = await query(`SELECT action, before_value, after_value, reason FROM audit_logs`);
      const actions = rows.map(r => r.action);
      assert.ok(actions.includes('auth.signup'));
      assert.ok(actions.includes('auth.reset_requested'));
      const blob = JSON.stringify(rows);
      assert.ok(!blob.includes(codeFromLastEmail()), 'a reset code must never reach the audit log');
      assert.ok(!blob.includes(STUDENT.password));
    });
  });
});

/* ---------------------------------------------------------------- fixtures */

async function seedGuestHeldSeat(guestToken: string): Promise<string> {
  return tx(async (c) => {
    const { rows: [r] } = await c.query(
      `INSERT INTO routes (code,origin,destination,duration_min)
       VALUES ('WX-MYP','Woxsen','Miyapur Metro',75)
       ON CONFLICT (code) DO UPDATE SET origin=EXCLUDED.origin RETURNING id`);
    const { rows: [v] } = await c.query(
      `INSERT INTO vehicles (name,registration,row_count) VALUES ('DLT-01','TS07 AA 1111',11)
       RETURNING id`);
    const { rows: [t] } = await c.query(
      `INSERT INTO trips (route_id,vehicle_id,departure_at,price,status)
       VALUES ($1,$2, now() + interval '2 days', 259,'OPEN') RETURNING id`, [r.id, v.id]);
    await c.query('SELECT materialise_trip_seats($1)', [t.id]);
    const { rows: [s] } = await c.query(
      `UPDATE trip_seats SET status='HELD', hold_guest_token=$1,
              hold_expires_at = now() + interval '10 minutes'
        WHERE trip_id=$2 AND seat_number='2B' RETURNING id`, [guestToken, t.id]);
    return s.id;
  });
}
