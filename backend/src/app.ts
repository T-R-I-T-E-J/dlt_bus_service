/* DLT · src/app.ts — route registration and the server entry.
 *
 * MISSING until the consistency audit: five route modules existed and nothing
 * mounted any of them. The backend had no entry point.
 *
 * WRITTEN, NOT EXECUTED.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { assertReady, close } from './db/index.ts';
import { razorpayConfigFromEnv, createRazorpayProvider } from './integrations/razorpay/index.ts';
import { currentTransport } from './integrations/email/index.ts';
import authRoutes, { attachSession, authErrorHandler } from './http/auth.routes.ts';
import { noStoreForAuthenticated, retryAfterHeader } from './http/security-headers.ts';
import tripRoutes from './http/trips.routes.ts';
import pollRoutes from './http/polls.routes.ts';
import bookingRoutes from './http/bookings.routes.ts';
import boardingRoutes from './http/boarding.routes.ts';
import adminRoutes from './http/admin.routes.ts';
import { sweepExpiredHolds } from './domain/seats.ts';
import { processPendingEvents, dispatchPendingRefunds, automaticRefundsEnabled } from './domain/payments.ts';
import { closeCache } from './domain/cache.ts';

function requestPath(req: Request) {
  return req.path || req.originalUrl.split('?')[0] || req.originalUrl;
}

function apiTiming(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  const originalWriteHead = res.writeHead;
  let wroteTiming = false;

  res.writeHead = function writeHeadWithTiming(this: Response, ...args: any[]) {
    if (!wroteTiming) {
      wroteTiming = true;
      const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
      if (!res.hasHeader('Server-Timing')) res.setHeader('Server-Timing', `app;dur=${ms.toFixed(1)}`);
      if (!res.hasHeader('X-DLT-Response-Time')) res.setHeader('X-DLT-Response-Time', `${Math.round(ms)}ms`);
    }
    return originalWriteHead.apply(this, args as any);
  } as typeof res.writeHead;

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    const payload = {
      level: res.statusCode >= 500 ? 'error' : 'info',
      msg: 'api_request',
      method: req.method,
      path: requestPath(req),
      status: res.statusCode,
      duration_ms: Number(ms.toFixed(1)),
      cache: res.getHeader('X-DLT-Cache') || undefined,
      requestId: req.get('x-request-id') || req.get('x-vercel-id') || req.get('x-railway-request-id') || undefined,
    };
    const line = JSON.stringify(payload);
    if (res.statusCode >= 500) console.error(line);
    else console.log(line);
  });

  next();
}

export function createApp() {
  const app = express();
  const provider = createRazorpayProvider(razorpayConfigFromEnv());

  app.set('trust proxy', 1);            // behind TLS termination; req.ip must be real
  app.use(helmet());
  app.use('/api', apiTiming);

  /* Cookies and the session they resolve to are independent of the request
   * body, so both run BEFORE bookingRoutes without touching the webhook's raw
   * bytes. This is a fix, not a preference: bookingRoutes was mounted before
   * these ran, so req.session and req.cookies were undefined for every route
   * in it — requireAuth threw UNAUTHENTICATED unconditionally, and a guest
   * checkout read an always-empty guestToken. No booking, cancellation,
   * checkout, passes read or handback ever authenticated over real HTTP. */
  app.use(cookieParser());
  app.use(attachSession);

  /* HD-6: no-store on authenticated JSON. After attachSession so req.session
   * exists; before every route, bookingRoutes included, so every handler is
   * covered. */
  app.use(noStoreForAuthenticated);

  /* THE WEBHOOK MUST BE MOUNTED BEFORE express.json().
   *
   * Razorpay signs the exact bytes it sent, and their documentation is explicit
   * that the body must not be parsed or cast before verification. If the JSON
   * parser ran first, the raw buffer would be gone and EVERY signature would
   * fail. bookingRoutes attaches its own raw() parser to that one path, and a
   * per-route express.json() to the others that need a parsed body — see
   * bookings.routes.ts for why it cannot be a router-level middleware here. */
  app.use('/api', bookingRoutes(provider));

  app.use(express.json({ limit: '64kb' }));

  app.use('/api', authRoutes);
  app.use('/api', tripRoutes);
  app.use('/api', pollRoutes);
  app.use('/api', boardingRoutes);
  app.use('/api', adminRoutes);

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      email: currentTransport(),
      provider: provider.name,
    });
  });

  app.get('/api/healthz', (_req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
  });

  app.get('/api/ready', async (_req, res) => {
    try {
      const db = await assertReady();
      res.json({ ok: true, db, email: currentTransport(), provider: provider.name });
    } catch (e) {
      res.status(503).json({ ok: false, error: (e as Error).message });
    }
  });

  /* HD-6: Retry-After on domain rate limits, before the handler that writes the
   * status. Order matters — headers must be set while the response is open. */
  app.use(retryAfterHeader);

  /* One error handler for the whole surface: maps AppError to a status, and
   * turns anything else into a generic 500 without leaking a message or stack. */
  app.use(authErrorHandler);
  return { app, provider };
}

/* ---------------------------------------------------------------- jobs
 *
 * Three schedules the system genuinely needs. Deliberately in-process for a
 * single instance; move to a real scheduler when there is more than one, since
 * running these twice concurrently is safe (every one is idempotent and uses
 * SKIP LOCKED) but wasteful.
 */
export function startJobs(provider: ReturnType<typeof createRazorpayProvider>) {
  const every = (ms: number, name: string, fn: () => Promise<unknown>) =>
    setInterval(() => { void fn().catch(e => console.error('[job:%s]', name, e.message)); }, ms);

  const timers = [
    every(30_000, 'sweep', sweepExpiredHolds),
    every(20_000, 'events', () => processPendingEvents(provider)),
  ];
  if (automaticRefundsEnabled())
    timers.push(every(60_000, 'refunds', () => dispatchPendingRefunds(provider)));
  else
    console.log('[dlt] automatic refund dispatch is OFF (AUTO_REFUNDS_ENABLED=false)');
  return timers;
}

async function waitForDatabaseReady() {
  const maxMs = Number(process.env.DB_BOOT_WAIT_MS ?? 240_000);
  const started = Date.now();
  let attempt = 0;

  while (true) {
    try {
      return await assertReady();
    } catch (e) {
      attempt += 1;
      const elapsed = Date.now() - started;
      if (elapsed >= maxMs) throw e;

      const delay = Math.min(10_000, 1_000 * attempt);
      console.error('[dlt] database readiness failed; retrying in %dms (attempt %d): %s',
        delay, attempt, (e as Error).message);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/* ---------------------------------------------------------------- entry */

if (process.env.NODE_ENV !== 'test') {
  const { app, provider } = createApp();
  /* Fail at boot rather than on the first seat, but give Neon/Railway a short
   * window to recover from transient cold-start network timeouts. */
  const ready = await waitForDatabaseReady();
  console.log('[dlt] postgres %s, %d migrations, email: %s, audit append-only: %s',
    ready.version, ready.migrations, currentTransport(), ready.auditAppendOnly);

  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => console.log('[dlt] listening on %d', port));
  const timers = startJobs(provider);

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      timers.forEach(clearInterval);
      server.close(() => {
        void Promise.all([close(), closeCache()]).then(() => process.exit(0));
      });
    });
  }
}
