/* DLT · src/app.ts — route registration and the server entry.
 *
 * MISSING until the consistency audit: five route modules existed and nothing
 * mounted any of them. The backend had no entry point.
 *
 * WRITTEN, NOT EXECUTED.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { assertReady, close } from './db/index.ts';
import { razorpayConfigFromEnv, createRazorpayProvider } from './integrations/razorpay/index.ts';
import { currentTransport } from './integrations/email/index.ts';
import authRoutes, { attachSession, authErrorHandler } from './http/auth.routes.ts';
import { noStoreForAuthenticated, retryAfterHeader } from './http/security-headers.ts';
import tripRoutes from './http/trips.routes.ts';
import bookingRoutes from './http/bookings.routes.ts';
import boardingRoutes from './http/boarding.routes.ts';
import adminRoutes from './http/admin.routes.ts';
import { sweepExpiredHolds } from './domain/seats.ts';
import { processPendingEvents, dispatchPendingRefunds } from './domain/payments.ts';

export function createApp() {
  const app = express();
  const provider = createRazorpayProvider(razorpayConfigFromEnv());

  app.set('trust proxy', 1);            // behind TLS termination; req.ip must be real
  app.use(helmet());

  /* THE WEBHOOK MUST BE MOUNTED BEFORE express.json().
   *
   * Razorpay signs the exact bytes it sent, and their documentation is explicit
   * that the body must not be parsed or cast before verification. If the JSON
   * parser ran first, the raw buffer would be gone and EVERY signature would
   * fail. bookingRoutes attaches its own raw() parser to this path. */
  app.use('/api', bookingRoutes(provider));

  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());

  /* Resolves the session cookie into req.session for every route below. The
   * role on it comes from the database, and is the only role any authorization
   * check reads. */
  app.use(attachSession);

  /* HD-6: no-store on authenticated JSON. After attachSession so req.session
   * exists; before the routes so every handler is covered. */
  app.use(noStoreForAuthenticated);

  app.use('/api', authRoutes);
  app.use('/api', tripRoutes);
  app.use('/api', boardingRoutes);
  app.use('/api', adminRoutes);

  app.get('/api/health', async (_req, res) => {
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

  return [
    every(30_000, 'sweep', sweepExpiredHolds),
    every(20_000, 'events', () => processPendingEvents(provider)),
    every(60_000, 'refunds', () => dispatchPendingRefunds(provider)),
  ];
}

/* ---------------------------------------------------------------- entry */

if (process.env.NODE_ENV !== 'test') {
  const { app, provider } = createApp();
  /* Fail at boot rather than on the first seat: an unmigrated or too-old
   * database is a deployment error, not a request error. */
  const ready = await assertReady();
  console.log('[dlt] postgres %s, %d migrations, email: %s, audit append-only: %s',
    ready.version, ready.migrations, currentTransport(), ready.auditAppendOnly);

  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => console.log('[dlt] listening on %d', port));
  const timers = startJobs(provider);

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      timers.forEach(clearInterval);
      server.close(() => { void close().then(() => process.exit(0)); });
    });
  }
}
