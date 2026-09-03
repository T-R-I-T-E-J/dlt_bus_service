/* DLT · integrations/email — the delivery boundary.
 *
 * Imported by domain/auth.ts and by auth.test.ts, and MISSING until the
 * consistency audit.
 *
 * This is the module that makes email verification and password reset real.
 * Two real transports exist: httpTransport (Resend's HTTPS API — the one
 * actually configured in production, since Railway firewalls outbound SMTP
 * below the Pro plan) and smtpTransport (any SMTP server; kept for local dev
 * or a non-Railway host — see PRODUCTION_DEPLOYMENT.md §3 for the Gmail
 * setup it was written against). In every environment except test, with
 * neither configured, sending FAILS LOUDLY rather than pretending to send. A
 * silent no-op here would mean a student who cannot verify their account and
 * cannot reset their password, with nothing in the logs to say why.
 *
 * Credentials for whichever transport is configured live ONLY in the
 * environment (RESEND_API_KEY / EMAIL_SMTP_*) — never in this file, never in
 * a test, never in a log line. The catch blocks below are deliberate about
 * this: nodemailer/fetch error objects can echo back connection details, but
 * never the password/key, and only the error's own message is logged, never
 * the message body (which carries the verification or reset code).
 */

import nodemailer from 'nodemailer';
import { promises as dns } from 'node:dns';
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
 * HTTP-API provider adapter, bound to Resend (api.resend.com/emails). Chosen
 * because Railway firewalls outbound SMTP (25/465/587/2525) entirely below
 * the Pro plan — confirmed against Railway's own docs, not a guess — so
 * plain nodemailer/SMTP cannot deliver from this host regardless of DNS or
 * timeout tuning. Resend speaks plain HTTPS, which Railway never blocks.
 *
 * Templates are rendered locally with the same renderTemplate() SMTP uses
 * (below) — Resend has no server-side named-template+variables API, so this
 * keeps copy and behavior identical across both transports and both live in
 * exactly one place. apiKey is read from RESEND_API_KEY only; never
 * hardcoded, never logged.
 */
export function httpTransport(cfg: {
  apiKey: string; fromAddress: string; fromName: string;
}): EmailTransport {
  return {
    name: 'http',
    async send(msg) {
      const { subject, text, html } = renderTemplate(msg.template, msg.vars);
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: `${cfg.fromName} <${cfg.fromAddress}>`,
          to: [msg.to],
          subject, text, html,
        }),
      });
      if (!res.ok) {
        /* Log our own reference and the status. NEVER the body — it contains the
         * verification or reset code, and Resend's own error body can also
         * echo request details we don't want in logs. */
        console.error('[email] resend -> %s for template %s', res.status, msg.template);
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
  /* Some hosts (Railway included) run containers with no real IPv6 route out
   * (ipv6EgressEnabled:false) that nonetheless report a non-loopback IPv6
   * interface locally. nodemailer does NOT use Node's dns.lookup / the
   * --dns-result-order flag for SMTP connections — it resolves the A and
   * AAAA records itself (lib/shared/index.js: resolveHostname), and picks
   * ONE AT RANDOM to connect to. Its own "is this family usable" probe only
   * checks for a local interface of that family, which the container has —
   * so Gmail's AAAA record stays in the pool and roughly half of all
   * connection attempts pick it and hang/ENETUNREACH. There is no transport
   * option that disables this.
   *
   * The fix is to resolve the A record ourselves and hand nodemailer the
   * literal IPv4 address as `host` — resolveHostname() skips its own DNS
   * logic entirely for an address that is already an IP (net.isIP check).
   * `servername` is set explicitly to the real hostname so TLS SNI and
   * certificate hostname verification still happen against
   * smtp.gmail.com, not the IP. */
  let ipv4: { addr: string; at: number } | null = null;
  const IPV4_TTL_MS = 5 * 60_000;

  async function resolvedHost(): Promise<string> {
    if (ipv4 && Date.now() - ipv4.at < IPV4_TTL_MS) return ipv4.addr;
    try {
      const [addr] = await dns.resolve4(cfg.host);
      if (addr) { ipv4 = { addr, at: Date.now() }; return addr; }
    } catch { /* fall through to the hostname below */ }
    return cfg.host;
  }

  return {
    name: 'smtp',
    async send(msg) {
      const { subject, text, html } = renderTemplate(msg.template, msg.vars);
      const transporter = nodemailer.createTransport({
        host: await resolvedHost(),
        port: cfg.port,
        secure: cfg.secure,           // false + port 587 = STARTTLS (upgraded after connecting)
        servername: cfg.host,         // SNI/cert check stays on the real hostname
        auth: { user: cfg.user, pass: cfg.pass },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
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
      'Set RESEND_API_KEY, or EMAIL_SMTP_HOST/EMAIL_SMTP_USER/EMAIL_SMTP_PASS.',
      msg.template, msg.to);
    throw new AppError('INTERNAL',
      'Email delivery is not configured on this server. Contact support.');
  },
};

let transport: EmailTransport = (() => {
  if (process.env.NODE_ENV === 'test' || process.env.EMAIL_TRANSPORT === 'memory')
    return memoryTransport;
  /* Resend takes priority when both are somehow configured. Railway
   * firewalls outbound SMTP below the Pro plan (confirmed against Railway's
   * own docs), so SMTP is kept for local dev / any non-Railway host, but
   * production must go through Resend's HTTPS API. */
  if (process.env.RESEND_API_KEY)
    return httpTransport({
      apiKey: process.env.RESEND_API_KEY,
      /* onboarding@resend.dev is Resend's own shared sending domain — works
       * immediately with no DNS/domain verification. Set EMAIL_FROM to an
       * address on a domain verified in Resend once that's done; until then
       * this default keeps delivery working. */
      fromAddress: process.env.EMAIL_FROM ?? 'onboarding@resend.dev',
      fromName: process.env.EMAIL_FROM_NAME ?? 'DLT',
    });
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
  return unconfiguredTransport;
})();

/** For tests and for a deliberate runtime swap. */
export function setTransport(t: EmailTransport): void { transport = t; }
export function currentTransport(): string { return transport.name; }

export function sendEmail(msg: EmailMessage): Promise<void> {
  return transport.send(msg);
}
