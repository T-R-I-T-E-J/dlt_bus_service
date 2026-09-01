/* DLT · integrations/email — the delivery boundary.
 *
 * Imported by domain/auth.ts and by auth.test.ts, and MISSING until the
 * consistency audit.
 *
 * This is the module that makes email verification and password reset real.
 * There is no provider bound to it — that is the outstanding infrastructure
 * dependency, not an oversight — so in every environment except test it FAILS
 * LOUDLY rather than pretending to send. A silent no-op here would mean a
 * student who cannot verify their account and cannot reset their password, with
 * nothing in the logs to say why.
 *
 * WRITTEN, NOT EXECUTED. No provider credentials exist.
 */

import { AppError } from '../../domain/errors.ts';

export interface EmailMessage {
  to: string;
  template: 'verify-email' | 'password-reset' | 'booking-confirmed' | 'trip-cancelled' | 'refund-processed';
  vars: Record<string, unknown>;
}

export interface EmailTransport {
  readonly name: string;
  send(msg: EmailMessage): Promise<void>;
}

/* ---------------------------------------------------------------- test transport
 *
 * `outbox` is what auth.test.ts reads to recover a verification or reset code.
 * This is the ONLY legitimate way to read a code — the domain never returns one
 * (F-06), and no other code path may expose it.
 */
export const outbox: EmailMessage[] = [];

export const memoryTransport: EmailTransport = {
  name: 'memory',
  async send(msg) { outbox.push(msg); },
};

/* ---------------------------------------------------------------- real transport
 *
 * A single HTTP-API provider adapter. The shape below is deliberately generic:
 * bind it to whichever provider is chosen and adjust the request body in ONE
 * place. Templates live provider-side so copy can change without a deploy.
 */
export function httpTransport(cfg: {
  apiUrl: string; apiKey: string; fromAddress: string; fromName: string;
}): EmailTransport {
  return {
    name: 'http',
    async send(msg) {
      const res = await fetch(cfg.apiUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: { email: cfg.fromAddress, name: cfg.fromName },
          to: [{ email: msg.to }],
          template: msg.template,
          variables: msg.vars,
        }),
      });
      if (!res.ok) {
        /* Log our own reference and the status. NEVER the body — it contains the
         * verification or reset code. */
        console.error('[email] %s -> %s for template %s', cfg.apiUrl, res.status, msg.template);
        throw new AppError('INTERNAL', 'We could not send that email. Try again shortly.');
      }
    },
  };
}

/** Refuses to send, loudly. The default outside test, so a half-configured
 *  deployment cannot silently swallow account verification. */
const unconfiguredTransport: EmailTransport = {
  name: 'unconfigured',
  async send(msg) {
    console.error('[email] NO TRANSPORT CONFIGURED — refusing to send %s to %s. ' +
      'Set EMAIL_API_URL and EMAIL_API_KEY.', msg.template, msg.to);
    throw new AppError('INTERNAL',
      'Email delivery is not configured on this server. Contact support.');
  },
};

let transport: EmailTransport = (() => {
  if (process.env.NODE_ENV === 'test' || process.env.EMAIL_TRANSPORT === 'memory')
    return memoryTransport;
  if (process.env.EMAIL_API_URL && process.env.EMAIL_API_KEY)
    return httpTransport({
      apiUrl: process.env.EMAIL_API_URL,
      apiKey: process.env.EMAIL_API_KEY,
      fromAddress: process.env.EMAIL_FROM ?? 'no-reply@dlt.co.in',
      fromName: process.env.EMAIL_FROM_NAME ?? 'DLT',
    });
  return unconfiguredTransport;
})();

/** For tests and for a deliberate runtime swap. */
export function setTransport(t: EmailTransport): void { transport = t; }
export function currentTransport(): string { return transport.name; }

export function sendEmail(msg: EmailMessage): Promise<void> {
  return transport.send(msg);
}
