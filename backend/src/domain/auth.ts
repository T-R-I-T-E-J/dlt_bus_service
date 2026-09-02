/* DLT · domain/auth.ts — the authentication rules.
 *
 * Ported from dlt-store.js's `auth` object. The rules are the same rules; what
 * changes is that they now run where the student cannot reach them. Every
 * behaviour the browser tests pinned down is preserved deliberately, and each
 * place where the prototype was WRONG is marked with its finding id.
 *
 * This layer knows nothing about HTTP. It takes plain arguments, returns plain
 * values, and throws typed errors. That is what makes it testable without a
 * server and portable if the transport ever changes.
 *
 * WRITTEN, NOT EXECUTED. No TypeScript compiler or Node runtime exists in the
 * environment this was authored in.
 */

import argon2 from 'argon2';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { tx, query } from '../db/index.ts';
import { audit } from './audit.ts';
import { AppError } from './errors.ts';
import { sendEmail } from '../integrations/email/index.ts';

/* ---------------------------------------------------------------- config */

const SESSION_TTL_DAYS = 14;
const RESET_TTL_MIN = 30;
const VERIFY_TTL_HOURS = 48;
const LOGIN_MAX = 5;
const LOGIN_WINDOW = '15 minutes';

/* OWASP's argon2id baseline. Tune memoryCost to the host, never below 19 MiB. */
const ARGON2 = {
  type: argon2.argon2id,
  memoryCost: 19456,   // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/* HD-3. A hash to verify against when the account does not exist, so a missing
 * account costs the same time as a wrong password.
 *
 * Previously a TOP-LEVEL await at module scope. That is valid ESM but it made
 * every import of this module wait on an argon2 hash, and — worse — an argon2
 * that failed to build threw during IMPORT, producing a boot failure with no
 * useful stack. Now computed once, lazily, on the first sign-in attempt. */
let decoyHash: Promise<string> | null = null;
function getDecoyHash(): Promise<string> {
  decoyHash ??= argon2.hash(randomBytes(32).toString('hex'), ARGON2);
  return decoyHash;
}

/* ---------------------------------------------------------------- helpers */

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** A short human-typeable code for email verification and password reset. */
const newCode = () => randomBytes(4).toString('hex').toUpperCase(); // 8 chars

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface PublicUser {
  id: string; email: string; name: string; role: string; phone: string | null;
  studentId: string | null; university: string | null; status: string;
  emailVerified: boolean; createdAt: string;
  emergencyContact: { name: string; phone: string; relation: string | null } | null;
}

/* The exact shape dlt-store.js's publicUser() returned, so the client contract
 * does not change. Note what is absent: no hash, no salt, no reset code, no
 * session token. This projection is the only way a user reaches a response. */
const PUBLIC_USER_SQL = `
  SELECT u.id, u.email, u.name, u.role, u.phone, u.status,
         (u.email_verified_at IS NOT NULL) AS "emailVerified",
         u.created_at AS "createdAt",
         sp.student_id AS "studentId", sp.university,
         CASE WHEN sp.emergency_contact_name IS NULL THEN NULL
              ELSE json_build_object('name', sp.emergency_contact_name,
                                     'phone', sp.emergency_contact_phone,
                                     'relation', sp.emergency_contact_relation) END
           AS "emergencyContact"
    FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id`;

/* ---------------------------------------------------------------- validation
 *
 * Identical to the prototype's messages, because the screens display them
 * verbatim and the copy was reviewed. Validation runs server-side even though
 * the client also validates: the client's copy is a courtesy, this one is the
 * rule. (Security Spec §3 — validate all client input server-side.)
 */

function validateSignup(i: SignupInput) {
  if (!i.name || i.name.trim().length < 3) throw new AppError('VALIDATION', 'Enter your full name');
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(i.email ?? ''))
    throw new AppError('VALIDATION', 'Enter a valid email address');
  if (!i.password || i.password.length < 8)
    throw new AppError('VALIDATION', 'Use at least 8 characters');
  if (!/^[6-9]\d{9}$/.test((i.phone ?? '').replace(/\s/g, '')))
    throw new AppError('VALIDATION', 'Enter a valid Indian mobile number');
}

export interface SignupInput {
  name: string; email: string; password: string; phone: string;
  studentId?: string | null;
}

/* ---------------------------------------------------------------- signup */

export async function signUp(input: SignupInput, ctx: { ip?: string }): Promise<PublicUser> {
  validateSignup(input);
  const email = input.email.trim().toLowerCase();
  const passwordHash = await argon2.hash(input.password, ARGON2);

  return tx(async (c) => {
    const dup = await c.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (dup.rowCount) throw new AppError('CONFLICT', 'An account already exists for that email');

    const { rows: [u] } = await c.query(
      `INSERT INTO users (email, name, phone, role, status)
       VALUES ($1,$2,$3,'STUDENT','ACTIVE') RETURNING id`,
      [email, input.name.trim(), input.phone.replace(/\s/g, '')]
    );
    await c.query(
      'INSERT INTO user_credentials (user_id, password_hash, kdf) VALUES ($1,$2,$3)',
      [u.id, passwordHash, 'argon2id']
    );
    await c.query(
      'INSERT INTO student_profiles (user_id, student_id) VALUES ($1,$2)',
      [u.id, input.studentId ?? null]
    );

    /* F-15: verification is reachable. The prototype generated a token and then
     * offered no route to it, so an account read "not verified" forever. */
    await issueVerification(c, u.id, email, input.name.trim());

    await audit(c, { actorId: u.id, ip: ctx.ip }, 'auth.signup', 'user', u.id, null, email, null);
    return publicUser(c, u.id);
  });
}

async function issueVerification(c: PoolClient, userId: string, email: string, name: string) {
  const code = newCode();
  await c.query(
    `INSERT INTO email_verifications (user_id, code_hash, expires_at)
     VALUES ($1,$2, now() + ($3 || ' hours')::interval)`,
    [userId, sha256(code), String(VERIFY_TTL_HOURS)]
  );
  /* The code leaves the system by email and by no other route. It is not
   * returned here, not logged, and not present in any response body. */
  await sendEmail({ to: email, template: 'verify-email', vars: { name, code } });
}

export async function resendVerification(userId: string): Promise<{ sent: true }> {
  return tx(async (c) => {
    const { rows: [u] } = await c.query(
      'SELECT email, name, email_verified_at FROM users WHERE id = $1', [userId]);
    if (!u) throw new AppError('NOT_FOUND', 'Account not found');
    if (u.email_verified_at) throw new AppError('CONFLICT', 'That address is already verified');
    await c.query('UPDATE email_verifications SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
    await issueVerification(c, userId, u.email, u.name);
    return { sent: true as const };
  });
}

export async function verifyEmail(code: string): Promise<PublicUser> {
  return tx(async (c) => {
    const { rows: [v] } = await c.query(
      `SELECT id, user_id FROM email_verifications
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [sha256((code ?? '').trim().toUpperCase())]
    );
    if (!v) throw new AppError('INVALID', 'That verification link is not valid');
    await c.query('UPDATE email_verifications SET used_at = now() WHERE id = $1', [v.id]);
    await c.query('UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1', [v.user_id]);
    await audit(c, { actorId: v.user_id }, 'auth.email_verified', 'user', v.user_id, 'false', 'true', null);
    return publicUser(c, v.user_id);
  });
}

/* ---------------------------------------------------------------- login */

export interface LoginResult { user: PublicUser; sessionToken: string; expiresAt: Date }

export async function signIn(
  emailRaw: string, password: string,
  ctx: { ip?: string; userAgent?: string; guestToken?: string | null }
): Promise<LoginResult> {
  const email = (emailRaw ?? '').trim().toLowerCase();

  /* F-06: two independent budgets. The account key protects the password; the
   * IP key protects everything else. An attacker hammering one address burns
   * their own IP budget first, so they cannot lock a victim out for free — and
   * because register_login_failure never extends a live window, repeated
   * attempts cannot stretch a lockout either. */
  const accountKey = `email:${email}`;
  const ipKey = ctx.ip ? `ip:${ctx.ip}` : null;

  for (const key of [accountKey, ipKey].filter(Boolean) as string[]) {
    const { rows: [l] } = await query('SELECT is_login_locked($1) AS until', [key]);
    if (l?.until) {
      const mins = Math.ceil((new Date(l.until).getTime() - Date.now()) / 60000);
      throw new AppError('RATE_LIMITED', `Too many attempts. Try again in ${mins} minutes.`);
    }
  }

  const { rows: [cred] } = await query(
    `SELECT u.id, u.status, c.password_hash
       FROM users u LEFT JOIN user_credentials c ON c.user_id = u.id
      WHERE u.email = $1`, [email]);

  /* Always verify SOMETHING, so a missing account and a wrong password take the
   * same time and leak nothing by timing. */
  const ok = await argon2.verify(cred?.password_hash ?? await getDecoyHash(), password ?? '')
    .catch(() => false);

  if (!cred || !ok) {
    await query('SELECT register_login_failure($1, $2, $3::interval)', [accountKey, LOGIN_MAX, LOGIN_WINDOW]);
    if (ipKey) await query('SELECT register_login_failure($1, $2, $3::interval)', [ipKey, LOGIN_MAX * 4, LOGIN_WINDOW]);
    /* One message for both cases: never disclose whether the address exists. */
    throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  if (cred.status !== 'ACTIVE')
    throw new AppError('FORBIDDEN', 'This account is not active. Contact support.');

  /* argon2 parameters change over time; rehash on login when they have. */
  if (argon2.needsRehash(cred.password_hash, ARGON2)) {
    const fresh = await argon2.hash(password, ARGON2);
    await query('UPDATE user_credentials SET password_hash = $1, updated_at = now() WHERE user_id = $2',
      [fresh, cred.id]);
  }

  return tx(async (c) => {
    await c.query('SELECT clear_login_failures($1)', [accountKey]);

    const raw = newToken();
    const { rows: [s] } = await c.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent, last_seen_at)
       VALUES ($1,$2, now() + ($3 || ' days')::interval, $4, $5, now())
       RETURNING expires_at`,
      [cred.id, sha256(raw), String(SESSION_TTL_DAYS), ctx.ip ?? null, ctx.userAgent ?? null]
    );

    /* F-08: seats held anonymously become this student's on sign-in, so the
     * booking flow survives authentication instead of restarting. */
    let adopted = 0;
    if (ctx.guestToken) {
      const r = await c.query(
        `UPDATE trip_seats SET hold_by = $1, hold_guest_token = NULL, updated_at = now()
          WHERE hold_guest_token = $2 AND status = 'HELD' AND hold_expires_at > now()`,
        [cred.id, ctx.guestToken]);
      adopted = r.rowCount ?? 0;
    }

    await audit(c, { actorId: cred.id, ip: ctx.ip }, 'auth.signin', 'user', cred.id,
      null, adopted ? `${adopted} held seat(s) adopted` : null, null);

    return { user: await publicUser(c, cred.id), sessionToken: raw, expiresAt: s.expires_at };
  });
}

/* ---------------------------------------------------------------- sessions */

export async function resolveSession(rawToken: string | undefined) {
  if (!rawToken) return null;
  const { rows: [s] } = await query(
    `SELECT id, user_id, role, email, name, status, email_verified_at
       FROM active_sessions WHERE token_hash = $1`, [sha256(rawToken)]);
  if (!s) return null;
  /* last_seen is best-effort and must never block the request */
  void query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [s.id]).catch(() => {});
  return { sessionId: s.id, userId: s.user_id, role: s.role as string,
    email: s.email, name: s.name, emailVerified: !!s.email_verified_at };
}

export async function signOut(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  await query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = 'signed out'
      WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(rawToken)]);
}

export async function signOutEverywhere(userId: string): Promise<number> {
  const { rows: [r] } = await query('SELECT revoke_user_sessions($1,$2) AS n',
    [userId, 'signed out of all devices']);
  return r.n;
}

/* ---------------------------------------------------------------- reset */

/* F-06, the defect: the prototype RETURNED the reset code to whoever asked for
 * it. Anyone who knew an address could read its reset code. Here the code
 * leaves only by email, and the response is the same whether or not the account
 * exists — so this endpoint cannot be used to enumerate students either. */
export async function requestPasswordReset(
  emailRaw: string, ctx: { ip?: string }
): Promise<{ sent: true }> {
  const email = (emailRaw ?? '').trim().toLowerCase();
  await tx(async (c) => {
    const { rows: [u] } = await c.query(
      'SELECT id, name FROM users WHERE email = $1 AND status = $2', [email, 'ACTIVE']);
    if (!u) return;                       // silent: no disclosure, same response
    const code = newCode();
    await c.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [u.id]);
    await c.query(
      `INSERT INTO password_resets (user_id, code_hash, expires_at)
       VALUES ($1,$2, now() + ($3 || ' minutes')::interval)`,
      [u.id, sha256(code), String(RESET_TTL_MIN)]);
    await sendEmail({ to: email, template: 'password-reset', vars: { name: u.name, code, minutes: RESET_TTL_MIN } });
    await audit(c, { ip: ctx.ip }, 'auth.reset_requested', 'user', u.id, null, null, null);
  });
  return { sent: true };
}

export async function resetPassword(code: string, password: string): Promise<{ ok: true }> {
  if (!password || password.length < 8)
    throw new AppError('VALIDATION', 'Use at least 8 characters');
  const hash = await argon2.hash(password, ARGON2);

  return tx(async (c) => {
    const { rows: [r] } = await c.query(
      `SELECT id, user_id FROM password_resets
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
        FOR UPDATE`, [sha256((code ?? '').trim().toUpperCase())]);
    if (!r) throw new AppError('INVALID', 'That reset link has expired');

    await c.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [r.id]);
    await c.query(
      'UPDATE user_credentials SET password_hash = $1, kdf = $2, updated_at = now() WHERE user_id = $3',
      [hash, 'argon2id', r.user_id]);
    /* A password change ends every existing session: if the reset happened
     * because the account was compromised, the attacker's session must die. */
    await c.query('SELECT revoke_user_sessions($1,$2)', [r.user_id, 'password reset']);
    await c.query('SELECT clear_login_failures($1)',
      [`email:${(await c.query('SELECT email FROM users WHERE id=$1', [r.user_id])).rows[0].email}`]);
    await audit(c, { actorId: r.user_id }, 'auth.password_reset', 'user', r.user_id, null, null, null);
    return { ok: true as const };
  });
}

export async function changePassword(
  userId: string, currentPassword: string, nextPassword: string
): Promise<{ ok: true }> {
  if (!nextPassword || nextPassword.length < 8)
    throw new AppError('VALIDATION', 'Use at least 8 characters');
  const { rows: [c0] } = await query(
    'SELECT password_hash FROM user_credentials WHERE user_id = $1', [userId]);
  if (!c0 || !(await argon2.verify(c0.password_hash, currentPassword).catch(() => false)))
    throw new AppError('INVALID_CREDENTIALS', 'Your current password is incorrect');

  const hash = await argon2.hash(nextPassword, ARGON2);
  return tx(async (c) => {
    await c.query('UPDATE user_credentials SET password_hash = $1, updated_at = now() WHERE user_id = $2',
      [hash, userId]);
    await c.query('SELECT revoke_user_sessions($1,$2)', [userId, 'password changed']);
    await audit(c, { actorId: userId }, 'auth.password_changed', 'user', userId, null, null, null);
    return { ok: true as const };
  });
}

/* ---------------------------------------------------------------- profile
 *
 * Name, phone and emergency contact are the student's to change immediately —
 * Account's own copy says so ("Name, phone and emergency contact are yours to
 * change"). A student ID is identity information; it goes through a request
 * instead (§ requests below), which is why updateProfile never writes it.
 */

export interface ProfileUpdate {
  name: string; phone: string;
  emergencyContact: { name: string; phone: string; relation?: string | null } | null;
}

function validateProfile(i: ProfileUpdate) {
  if (!i.name || i.name.trim().length < 3) throw new AppError('VALIDATION', 'Enter your full name');
  if (!/^[6-9]\d{9}$/.test((i.phone ?? '').replace(/\s/g, '')))
    throw new AppError('VALIDATION', 'Enter a valid Indian mobile number');
  if (i.emergencyContact) {
    const ec = i.emergencyContact;
    if (!ec.name || !ec.name.trim())
      throw new AppError('VALIDATION', 'Enter the emergency contact\'s name');
    if (!/^[6-9]\d{9}$/.test((ec.phone ?? '').replace(/\s/g, '')))
      throw new AppError('VALIDATION', 'Enter a valid emergency contact number');
  }
}

export async function updateProfile(userId: string, input: ProfileUpdate, actor: { userId: string }): Promise<PublicUser> {
  validateProfile(input);
  return tx(async (c) => {
    await c.query(
      'UPDATE users SET name=$2, phone=$3, updated_at=now() WHERE id=$1',
      [userId, input.name.trim(), input.phone.replace(/\s/g, '')]
    );
    await c.query(
      `UPDATE student_profiles
          SET emergency_contact_name = $2, emergency_contact_phone = $3,
              emergency_contact_relation = $4, updated_at = now()
        WHERE user_id = $1`,
      [userId, input.emergencyContact ? input.emergencyContact.name.trim() : null,
       input.emergencyContact ? input.emergencyContact.phone.replace(/\s/g, '') : null,
       input.emergencyContact ? (input.emergencyContact.relation || null) : null]
    );
    await audit(c, actor, 'auth.profile_updated', 'user', userId, null, null, null);
    return publicUser(c, userId);
  });
}

/* ---------------------------------------------------------------- account requests
 *
 * notification_requests already carries STUDENT_ID_CHANGE and ACCOUNT_DELETION
 * (migration 001) and domain/admin.ts already decides both — approving an ID
 * change writes student_profiles.student_id, approving a deletion anonymises
 * the account. What was missing is the student-facing half: nothing let a
 * student FILE either request. This is that half, not a new mechanism.
 *
 * requests_one_open_per_kind (migration 001, F-15) is a partial unique index on
 * (user_id, kind) WHERE status='PENDING' — the database itself refuses a
 * second open request of the same kind, which is why the 23505 branch below is
 * reachable and is the one place "already pending" is decided.
 */

const STUDENT_ID_RE = /^[A-Za-z0-9]{4,20}$/;

export async function requestStudentIdChange(
  userId: string, requestedValue: string, reason: string | null, actor: { userId: string }
): Promise<{ requested: true }> {
  const value = (requestedValue ?? '').trim();
  if (!STUDENT_ID_RE.test(value))
    throw new AppError('VALIDATION', 'Enter a valid student ID (4–20 letters or numbers)');
  return tx(async (c) => {
    const { rows: [u] } = await c.query(
      'SELECT student_id FROM student_profiles WHERE user_id=$1', [userId]);
    try {
      await c.query(
        `INSERT INTO notification_requests (kind, user_id, requested_value, current_value, reason)
         VALUES ('STUDENT_ID_CHANGE', $1, $2, $3, $4)`,
        [userId, value, u?.student_id ?? null, reason || null]);
    } catch (e: any) {
      if (e.code === '23505')
        throw new AppError('CONFLICT', 'You already have a student ID change request pending review');
      throw e;
    }
    await audit(c, actor, 'request.filed', 'notification_request', userId, null, 'STUDENT_ID_CHANGE', reason || null);
    return { requested: true as const };
  });
}

export async function requestAccountDeletion(
  userId: string, reason: string | null, actor: { userId: string }
): Promise<{ requested: true }> {
  return tx(async (c) => {
    try {
      await c.query(
        `INSERT INTO notification_requests (kind, user_id, reason)
         VALUES ('ACCOUNT_DELETION', $1, $2)`,
        [userId, reason || null]);
    } catch (e: any) {
      if (e.code === '23505')
        throw new AppError('CONFLICT', 'A deletion request is already filed and waiting on review');
      throw e;
    }
    await audit(c, actor, 'request.filed', 'notification_request', userId, null, 'ACCOUNT_DELETION', reason || null);
    return { requested: true as const };
  });
}

/** The student's own open requests — never another student's. Used only to
 *  show "already pending" state; the decision itself stays admin.ts's alone. */
export async function myPendingRequests(userId: string): Promise<Array<{ kind: string; createdAt: string }>> {
  const { rows } = await query(
    `SELECT kind, created_at AS "createdAt" FROM notification_requests
      WHERE user_id = $1 AND status = 'PENDING'
      ORDER BY created_at DESC`,
    [userId]);
  return rows;
}

/* ---------------------------------------------------------------- authorization */

/* Role enforcement reads the database, not the request. The client's copy of a
 * role is presentation only — it decides which buttons to draw, never what may
 * happen. (PRODUCTION_BACKEND.md §2.1.) */
export async function can(role: string, permission: string): Promise<boolean> {
  const { rows: [r] } = await query('SELECT has_permission($1::user_role,$2) AS ok', [role, permission]);
  return !!r?.ok;
}

export async function requirePermission(role: string, permission: string): Promise<void> {
  if (!(await can(role, permission)))
    throw new AppError('FORBIDDEN', 'Your role cannot perform that action');
}

async function publicUser(c: PoolClient, id: string): Promise<PublicUser> {
  const { rows: [u] } = await c.query(`${PUBLIC_USER_SQL} WHERE u.id = $1`, [id]);
  return u as PublicUser;
}

/** The replacement for the prototype's synchronous DLT.auth.current(). */
export async function currentUser(id: string): Promise<PublicUser | null> {
  const { rows: [u] } = await query(`${PUBLIC_USER_SQL} WHERE u.id = $1`, [id]);
  return (u as PublicUser) ?? null;
}

export const _internals = { sha256, newCode, ARGON2, PUBLIC_USER_SQL, getDecoyHash };
