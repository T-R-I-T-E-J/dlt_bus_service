/* DLT · http/auth.routes.ts — the HTTP boundary for authentication.
 *
 * This file contains NO business rules. It parses, sets cookies, maps domain
 * errors to status codes, and calls domain/auth.ts. If a rule appears here it
 * is in the wrong file — that separation is what let the browser prototype's
 * rule defects be found and fixed in one place.
 *
 * WRITTEN, NOT EXECUTED.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import * as auth from '../domain/auth.ts';
import { AppError } from '../domain/errors.ts';

export const SESSION_COOKIE = 'dlt_session';
export const GUEST_COOKIE = 'dlt_guest';

/* HttpOnly so no script can read it — including any script an XSS injects.
 * Secure so it never crosses plain HTTP. SameSite=Lax so a third-party form
 * cannot POST as the student while allowing normal top-level navigation back
 * from the Razorpay Checkout page. */
const cookieOpts = (expires: Date) => ({
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  expires,
});

const router = Router();

/* Transport-level throttle. This is NOT the brute-force control — that lives in
 * the database (register_login_failure) and survives a restart, a redeploy and
 * a second server. This only blunts the crude flood. */
const loginThrottle = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true });
const resetThrottle = rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: true });

const ctxOf = (req: Request) => ({
  ip: req.ip,
  userAgent: req.get('user-agent') ?? undefined,
  guestToken: req.cookies?.[GUEST_COOKIE] ?? null,
});

/* ---------------------------------------------------------------- schemas */

const SignupBody = z.object({
  name: z.string().min(3).max(120),
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
  phone: z.string().min(10).max(15),
  studentId: z.string().max(32).nullish(),
});
const LoginBody = z.object({ email: z.string().max(254), password: z.string().max(200) });
const CodeBody = z.object({ code: z.string().min(4).max(64) });
const ResetBody = z.object({ code: z.string().min(4).max(64), password: z.string().min(8).max(200) });
const EmailBody = z.object({ email: z.string().max(254) });
const ChangeBody = z.object({ currentPassword: z.string().max(200), password: z.string().min(8).max(200) });
const ProfileBody = z.object({
  name: z.string().min(3).max(120),
  phone: z.string().min(10).max(15),
  emergencyContact: z.object({ name: z.string().max(120), phone: z.string().max(15), relation: z.string().max(60).nullish() }).nullable(),
});
const StudentIdChangeBody = z.object({ studentId: z.string().min(1).max(32), reason: z.string().max(500).nullish() });
const DeletionBody = z.object({ reason: z.string().max(500).nullish() });

/* ---------------------------------------------------------------- middleware */

export async function attachSession(req: Request, _res: Response, next: NextFunction) {
  req.session = await auth.resolveSession(req.cookies?.[SESSION_COOKIE]);
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.session) return next(new AppError('UNAUTHENTICATED', 'Sign in required'));
  next();
}

/** Route guard. The permission is checked against the role in the DATABASE,
 *  read from the session — never from anything the client sent. */
export function requirePermission(permission: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.session) throw new AppError('UNAUTHENTICATED', 'Sign in required');
      await auth.requirePermission(req.session.role, permission);
      next();
    } catch (e) { next(e); }
  };
}

/* ---------------------------------------------------------------- routes */

router.post('/auth/signup', async (req, res, next) => {
  try {
    const body = SignupBody.parse(req.body);
    const user = await auth.signUp(body, { ip: req.ip });
    /* Signup does NOT sign you in. Verification comes first (SRS FR-001), and
     * the screens already expect to land on the sign-in panel. */
    res.status(201).json({ user });
  } catch (e) { next(e); }
});

router.post('/auth/login', loginThrottle, async (req, res, next) => {
  try {
    const { email, password } = LoginBody.parse(req.body);
    const { user, sessionToken, expiresAt } = await auth.signIn(email, password, ctxOf(req));
    res.cookie(SESSION_COOKIE, sessionToken, cookieOpts(new Date(expiresAt)));
    res.clearCookie(GUEST_COOKIE, { path: '/' });   // holds are now the account's
    /* The token itself is never in the body — only in the HttpOnly cookie.
     * `permissions` is the role's full grant list, read from role_permissions —
     * presentation only (Admin.dc.html draws buttons from it); every route
     * still re-checks the session's role itself. */
    res.json({ user, permissions: await auth.permissionsFor(user.role) });
  } catch (e) { next(e); }
});

router.post('/auth/logout', async (req, res, next) => {
  try {
    await auth.signOut(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  } catch (e) { next(e); }
});

router.post('/auth/logout-all', requireAuth, async (req, res, next) => {
  try {
    const n = await auth.signOutEverywhere(req.session!.userId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ revoked: n });
  } catch (e) { next(e); }
});

/** Replaces the prototype's synchronous DLT.auth.current(). */
router.get('/auth/me', async (req, res, next) => {
  try {
    if (!req.session) return res.json({ user: null, permissions: [] });
    const user = await auth.currentUser(req.session.userId);
    res.json({ user, permissions: user ? await auth.permissionsFor(user.role) : [] });
  } catch (e) { next(e); }
});

router.post('/auth/verify-email', async (req, res, next) => {
  try {
    const { code } = CodeBody.parse(req.body);
    res.json({ user: await auth.verifyEmail(code) });
  } catch (e) { next(e); }
});

router.post('/auth/resend-verification', requireAuth, resetThrottle, async (req, res, next) => {
  try { res.json(await auth.resendVerification(req.session!.userId)); } catch (e) { next(e); }
});

router.post('/auth/forgot-password', resetThrottle, async (req, res, next) => {
  try {
    const { email } = EmailBody.parse(req.body);
    /* Always { sent: true }, whether or not the account exists, and NEVER the
     * code itself — the F-06 defect. */
    res.json(await auth.requestPasswordReset(email, { ip: req.ip }));
  } catch (e) { next(e); }
});

router.post('/auth/reset-password', async (req, res, next) => {
  try {
    const { code, password } = ResetBody.parse(req.body);
    res.json(await auth.resetPassword(code, password));
  } catch (e) { next(e); }
});

router.post('/auth/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, password } = ChangeBody.parse(req.body);
    await auth.changePassword(req.session!.userId, currentPassword, password);
    res.clearCookie(SESSION_COOKIE, { path: '/' });   // every session died
    res.json({ ok: true, reauthenticate: true });
  } catch (e) { next(e); }
});

router.patch('/auth/profile', requireAuth, async (req, res, next) => {
  try {
    const body = ProfileBody.parse(req.body);
    const user = await auth.updateProfile(req.session!.userId, body, { userId: req.session!.userId });
    res.json({ user });
  } catch (e) { next(e); }
});

router.get('/auth/requests/mine', requireAuth, async (req, res, next) => {
  try { res.json({ requests: await auth.myPendingRequests(req.session!.userId) }); }
  catch (e) { next(e); }
});

router.post('/auth/requests/student-id-change', requireAuth, resetThrottle, async (req, res, next) => {
  try {
    const { studentId, reason } = StudentIdChangeBody.parse(req.body);
    res.status(201).json(await auth.requestStudentIdChange(
      req.session!.userId, studentId, reason ?? null, { userId: req.session!.userId }));
  } catch (e) { next(e); }
});

router.post('/auth/requests/account-deletion', requireAuth, resetThrottle, async (req, res, next) => {
  try {
    const { reason } = DeletionBody.parse(req.body);
    res.status(201).json(await auth.requestAccountDeletion(
      req.session!.userId, reason ?? null, { userId: req.session!.userId }));
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- errors */

const STATUS: Record<string, number> = {
  VALIDATION: 400, INVALID: 400,
  UNAUTHENTICATED: 401, INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, RATE_LIMITED: 429,
  INTERNAL: 500,
};

export function authErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err instanceof AppError)
    /* INTERNAL was missing from this map, so an infrastructure failure the
     * client did nothing to cause (e.g. the email provider rejecting a send)
     * fell through to the `?? 400` default and was reported as a client
     * error — the browser's console and this app's own frontend error
     * handling both read a 400 as "something you submitted was wrong",
     * which was never true here. */
    return res.status(STATUS[err.code] ?? 400).json({ error: { code: err.code, message: err.message } });
  if (err instanceof z.ZodError)
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'Check the details and try again' } });
  /* Never leak an internal message, a stack, or a database error to a client. */
  console.error('[auth] unhandled', err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side' } });
}

export default router;
