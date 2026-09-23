/* DLT · http/security-headers.ts — HD-6.
 *
 * Two small controls that belong at the boundary rather than in any handler:
 *
 *   1. `Cache-Control: no-store` on every AUTHENTICATED JSON response.
 *      Booking views carry passenger names, student IDs and phone numbers. A
 *      shared or campus machine, a browser back-button, or an intermediary
 *      cache should not retain them. Applied only when a session is present, so
 *      genuinely public reads (the trip list) stay cacheable.
 *
 *   2. `Retry-After` on every 429.
 *      The remediation added real rate limits (H-2 guest holds, login lockout).
 *      A 429 with no `Retry-After` leaves a client guessing, and a guessing
 *      client retries in a tight loop — which is indistinguishable from the
 *      abuse the limit exists to stop.
 *
 * WRITTEN, NOT EXECUTED.
 */

import type { Request, Response, NextFunction } from 'express';

/** Mount AFTER attachSession, so `req.session` is resolved. */
export function noStoreForAuthenticated(req: Request, res: Response, next: NextFunction) {
  res.on('pipe', () => {});             // no-op; keeps the header logic in one place
  const original = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (req.session) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      /* Vary on Cookie regardless, so a shared cache can never serve one
       * student's response to another even if no-store is ignored. */
      res.setHeader('Vary', 'Cookie');
    }
    return original(body);
  }) as Response['json'];
  next();
}

/** Seconds until a rate limit clears. Read from the error where the domain knows
 *  it, otherwise a conservative default. */
export function retryAfterSeconds(err: unknown): number {
  const msg = String((err as Error)?.message ?? '');
  /* The domain's own message says "Try again in N minutes" for the login
   * lockout — reuse it rather than inventing a second source of truth. */
  const mins = msg.match(/in (\d+) minutes?/);
  if (mins) return Math.max(1, Number(mins[1])) * 60;
  return 60;
}

/** Sets Retry-After on a 429 that does not already carry one. Express's
 *  rate-limit middleware sets it for transport limits; the DOMAIN limits
 *  (RATE_LIMITED from login lockout and guest holds) do not, which is the gap. */
export function retryAfterHeader(err: unknown, _req: Request, res: Response, next: NextFunction) {
  const code = (err as { code?: string })?.code;
  if (code === 'RATE_LIMITED' && !res.headersSent && !res.getHeader('Retry-After'))
    res.setHeader('Retry-After', String(retryAfterSeconds(err)));
  next(err);
}
