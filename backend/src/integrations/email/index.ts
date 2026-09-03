/* DLT · integrations/email — the delivery boundary.
 *
 * Imported by domain/auth.ts and by auth.test.ts, and MISSING until the
 * consistency audit.
 *
 * This is the module that makes email verification and password reset real.
 * Two real transports exist: smtpTransport (any SMTP server, Gmail with an
 * App Password is the one actually configured — see PRODUCTION_DEPLOYMENT.md
 * §3) and httpTransport (a generic provider-API adapter, for whenever a
 * transactional-email API is chosen instead). In every environment except
 * test, with neither configured, sending FAILS LOUDLY rather than pretending
 * to send. A silent no-op here would mean a student who cannot verify their
 * account and cannot reset their password, with nothing in the logs to say
 * why.
 *
 * Credentials for whichever transport is configured live ONLY in the
 * environment (EMAIL_SMTP_* / EMAIL_API_*) — never in this file, never in a
 * test, never in a log line. The catch blocks below are deliberate about
 * this: nodemailer/fetch error objects can echo back connection details, but
 * never the password, and only the error's own message is logged, never the
 * message body (which carries the verification or reset code).
 */

import nodemailer from 'nodemailer';
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

/* ---------------------------------------------------------------- SMTP transport
 *
 * Real SMTP (nodemailer), for a provider that speaks SMTP rather than a
 * bespoke HTTP API — Gmail's own smtp.gmail.com with an account App
 * Password is the configured case (587, STARTTLS: secure:false, then
 * upgraded, exactly what nodemailer does with `secure:false` on 587 — NOT
 * implicit TLS, which is port 465 with `secure:true`).
 *
 * Unlike httpTransport, there is no provider-side template to hand a name
 * to — SMTP is just "send these bytes." renderTemplate() below is this
 * codebase's one place composing the subject/body for each template name,
 * so a template's copy has exactly one home regardless of which transport
 * is configured to send it.
 */
function renderTemplate(template: EmailMessage['template'], vars: Record<string, unknown>):
  { subject: string; text: string; html: string } {
  const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const wrap = (bodyHtml: string) =>
    `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#0E1014">` +
    `<p style="font-weight:700;font-size:18px;margin:0 0 16px">DLT — Woxsen → Miyapur</p>` +
    bodyHtml +
    `<p style="margin:24px 0 0;font-size:12.5px;color:#5F6560">` +
    `If you did not request this, you can ignore this email.</p></div>`;

  switch (template) {
    case 'verify-email': {
      const name = esc(vars.name), code = esc(vars.code);
      return {
        subject: 'Verify your DLT account',
        text: `Hi ${name},\n\nYour DLT verification code is: ${code}\n\n` +
          `Enter it on the sign-in screen to verify your account.\n\n` +
          `If you did not request this, you can ignore this email.`,
        html: wrap(`<p>Hi ${name},</p>` +
          `<p>Your DLT verification code is:</p>` +
          `<p style="font-size:26px;font-weight:700;letter-spacing:.08em;margin:14px 0">${code}</p>` +
          `<p>Enter it on the sign-in screen to verify your account.</p>`),
      };
    }
    case 'password-reset': {
      const name = esc(vars.name), code = esc(vars.code), minutes = esc(vars.minutes);
      return {
        subject: 'Reset your DLT password',
        text: `Hi ${name},\n\nYour DLT password reset code is: ${code}\n` +
          `This code expires in ${minutes} minutes.\n\n` +
          `If you did not request this, you can ignore this email — your password will not change.`,
        html: wrap(`<p>Hi ${name},</p>` +
          `<p>Your DLT password reset code is:</p>` +
          `<p style="font-size:26px;font-weight:700;letter-spacing:.08em;margin:14px 0">${code}</p>` +
          `<p>This code expires in ${minutes} minutes.</p>` +
          `<p>If you did not request this, your password will not change.</p>`),
      };
    }
    /* booking-confirmed / trip-cancelled / refund-processed: the template
     * name exists (EmailMessage's own type) but nothing in domain/ calls
     * sendEmail with any of the three yet — grep domain/*.ts for
     * sendEmail( and there are exactly two call sites, both above. The
     * vars shape below is therefore a reasonable, NOT a verified, guess —
     * whoever wires the real trigger (a booking confirming, a trip
     * cancelling, a refund settling) should confirm these field names
     * against what that call site actually has on hand before relying on
     * this rendering anything but the generic fallback. */
    case 'booking-confirmed': {
      const code = esc(vars.bookingCode ?? vars.code), when = esc(vars.when ?? vars.departureAt);
      return {
        subject: `Booking confirmed — ${code || 'DLT'}`,
        text: `Your DLT booking ${code} is confirmed for ${when}. See your boarding pass on the Dashboard.`,
        html: wrap(`<p>Your booking <strong>${code}</strong> is confirmed for ${when}.</p>` +
          `<p>See your boarding pass on the Dashboard.</p>`),
      };
    }
    case 'trip-cancelled': {
      const when = esc(vars.when ?? vars.departureAt), reason = esc(vars.reason);
      return {
        subject: 'Your DLT departure was cancelled',
        text: `Your DLT departure on ${when} has been cancelled.${reason ? ' ' + reason : ''} ` +
          `A refund, if due, has been raised against your original payment method.`,
        html: wrap(`<p>Your departure on ${when} has been cancelled.${reason ? ' ' + reason : ''}</p>` +
          `<p>A refund, if due, has been raised against your original payment method.</p>`),
      };
    }
    case 'refund-processed': {
      const amount = esc(vars.amount), code = esc(vars.bookingCode ?? vars.code);
      return {
        subject: 'Your DLT refund has been processed',
        text: `A refund of Rs ${amount} for booking ${code} has been processed to your original payment method.`,
        html: wrap(`<p>A refund of <strong>&#8377;${amount}</strong> for booking ${code} ` +
          `has been processed to your original payment method.</p>`),
      };
    }
    default: {
      /* Exhaustiveness: every EmailMessage['template'] is handled above.
       * This only runs if that union type ever grows without this switch
       * growing with it — a generic body rather than a silent throw, so a
       * forgotten template doesn't turn into a support incident. */
      return {
        subject: 'DLT notification',
        text: `You have a DLT notification (${String(template)}).`,
        html: wrap(`<p>You have a DLT notification.</p>`),
      };
    }
  }
}

export function smtpTransport(cfg: {
  host: string; port: number; secure: boolean; user: string; pass: string;
  fromAddress: string; fromName: string;
}): EmailTransport {
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,              // false + port 587 = STARTTLS (upgraded after connecting)
    auth: { user: cfg.user, pass: cfg.pass },
    /* Some hosts (Railway included) route containers with no IPv6 egress.
     * Gmail's SMTP host resolves an AAAA record; without this, Node's
     * connection attempt reaches that address and hangs until the platform's
     * own edge timeout kills the request — the atomic signup transaction
     * never gets a chance to fail cleanly and roll back. family:4 skips the
     * AAAA record entirely. The timeouts bound the IPv4 attempt too, so a
     * genuine SMTP outage surfaces as a normal error instead of a hang. */
    family: 4,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return {
    name: 'smtp',
    async send(msg) {
      const { subject, text, html } = renderTemplate(msg.template, msg.vars);
      try {
        await transporter.sendMail({
          from: `"${cfg.fromName}" <${cfg.fromAddress}>`,
          to: msg.to,
          subject, text, html,
        });
      } catch (e) {
        /* The thrown error's message can include the SMTP server's own
         * response text, which does not contain the password — nodemailer
         * never echoes the auth credential back in an error. It is not
         * logged here regardless, only that a send failed and for what. */
        console.error('[email] smtp send failed via %s for template %s: %s',
          cfg.host, msg.template, (e as Error).message);
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
      'Set EMAIL_SMTP_HOST/EMAIL_SMTP_USER/EMAIL_SMTP_PASS, or EMAIL_API_URL/EMAIL_API_KEY.',
      msg.template, msg.to);
    throw new AppError('INTERNAL',
      'Email delivery is not configured on this server. Contact support.');
  },
};

let transport: EmailTransport = (() => {
  if (process.env.NODE_ENV === 'test' || process.env.EMAIL_TRANSPORT === 'memory')
    return memoryTransport;
  /* SMTP takes priority when both are somehow configured — it's the one
   * actually wired to a real account (Gmail) as of this pass. */
  if (process.env.EMAIL_SMTP_HOST && process.env.EMAIL_SMTP_USER && process.env.EMAIL_SMTP_PASS)
    return smtpTransport({
      host: process.env.EMAIL_SMTP_HOST,
      port: Number(process.env.EMAIL_SMTP_PORT ?? 587),
      /* 465 is implicit TLS (secure:true); every other port, 587 included,
       * is STARTTLS (secure:false — nodemailer upgrades the connection
       * itself after EHLO). EMAIL_SMTP_SECURE can still force it either
       * way for a provider that doesn't follow that convention. */
      secure: process.env.EMAIL_SMTP_SECURE
        ? process.env.EMAIL_SMTP_SECURE === 'true'
        : Number(process.env.EMAIL_SMTP_PORT ?? 587) === 465,
      user: process.env.EMAIL_SMTP_USER,
      pass: process.env.EMAIL_SMTP_PASS,
      fromAddress: process.env.EMAIL_FROM ?? process.env.EMAIL_SMTP_USER,
      fromName: process.env.EMAIL_FROM_NAME ?? 'DLT',
    });
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
