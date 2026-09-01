/* DLT · integrations/razorpay/index.ts — the Razorpay adapter.
 *
 * The only file in the system that knows Razorpay exists. It implements
 * PaymentProvider and converts in both directions: rupees ⇄ paise, and
 * Razorpay's payload/status vocabulary ⇄ ours.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVENANCE OF EVERY SECURITY DETAIL BELOW
 *
 * These were read from Razorpay's current official documentation during this
 * migration, NOT carried over from the Cashfree implementation and NOT recalled
 * from memory:
 *
 *  · Webhook signature: HMAC-SHA256, key = webhook secret, message = the RAW
 *    request body, HEX digest, sent in the `X-Razorpay-Signature` header.
 *    Razorpay is explicit: "ensure that the webhook body passed as an argument
 *    is the raw webhook request body. Do not parse or cast the webhook request
 *    body."
 *      → docs/webhooks/validate-test  ("Validate Webhooks", HMAC Hex Digest)
 *
 *  · There is NO timestamp in the signed message. Consequence: the five-minute
 *    replay window the Cashfree adapter used is IMPOSSIBLE here, and replay
 *    protection rests entirely on event-id uniqueness (below). This is the
 *    single most important difference between the two providers for us.
 *
 *  · Webhook idempotency: the `x-razorpay-event-id` header is documented as
 *    "unique per event", and deduping on it is Razorpay's own stated method.
 *      → docs/webhooks/validate-test ("Idempotency")
 *
 *  · Delivery: any non-2xx is treated as a failure and retried with
 *    exponential backoff for 24 hours; an event can be replayed from their
 *    dashboard for up to 15 days, validated with the secret in force AT THE
 *    TIME OF THE EVENT — so a rotated secret must be kept for verification.
 *      → docs/webhooks/faqs
 *
 *  · Ordering is NOT guaranteed: `payment.authorized` may arrive after
 *    `payment.captured`. Handled by making authorized IGNORED and never
 *    downgrading a settled payment.
 *      → docs/webhooks/validate-test ("Order of Webhooks")
 *
 *  · Checkout handback: `generated_signature = hmac_sha256(order_id + "|" +
 *    razorpay_payment_id, key_secret)` as a HEX digest, compared to
 *    `razorpay_signature`. Razorpay warns: "Retrieve the order_id from your
 *    server. Do NOT use the razorpay_order_id returned by Checkout" — honoured
 *    below, the caller passes our stored order id.
 *      → docs/payments/payment-gateway/.../integration-steps
 *
 *  · Amounts are in the smallest currency unit: "a value of 100 means 100 paise
 *    (equivalent to ₹1)", minimum ₹1.
 *      → docs/api/refunds, docs/api/qr-codes/gst/refunds
 *
 *  · An order must be created server-side and its id passed to checkout;
 *    "Payments made without an order_id cannot be captured and will be
 *    automatically refunded."
 *      → docs/.../integration-steps
 *
 *  · Refunds may only be created on a CAPTURED payment; an authorized payment
 *    auto-refunds if not captured within 3 days. Refund status is
 *    pending | processed | failed, and `refund.processed` is documented as the
 *    definitive final status.
 *      → docs/api/refunds, docs/payments/refunds/faqs
 *
 * STATUS: WRITTEN — NOT EXECUTED — NOT VERIFIED AGAINST RAZORPAY.
 *
 * No credentials, no sandbox account and no network egress exist here. Not one
 * request has been sent and no real webhook has been verified. The scheme above
 * is documented rather than guessed, which is a genuine improvement on the
 * Cashfree position — but documented is still not observed. Two things must be
 * done in a Razorpay TEST account before this is trusted:
 *   1. one real webhook arrives and verifies;
 *   2. one webhook with a tampered body is REJECTED.
 * Until both are recorded, treat the signature path as unproven.
 *
 * REMAINING ASSUMPTION, FLAGGED: auto-capture. The order is created without an
 * explicit capture setting, relying on the account being configured for
 * automatic capture. If the account is set to manual capture, payments will sit
 * in `authorized` and auto-refund after 3 days. CONFIRM THE ACCOUNT SETTING, or
 * add an explicit capture call.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../domain/errors.ts';
import type {
  PaymentProvider, NormalizedEvent, CreateOrderInput, CreatedOrder,
  FetchedOrder, CreatedRefund, PaymentEventKind,
} from '../../domain/payment-provider.ts';

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  /** Current secret first. Older secrets are kept so that a webhook replayed
   *  after a rotation still verifies — Razorpay validates replays against the
   *  secret that was in force when the event occurred. */
  webhookSecrets: string[];
  baseUrl: string;
}

export function razorpayConfigFromEnv(): RazorpayConfig {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is not set — refusing to start with a half-configured acquirer`);
    return v;
  };
  return {
    keyId: need('RAZORPAY_KEY_ID'),
    keySecret: need('RAZORPAY_KEY_SECRET'),
    webhookSecrets: [
      need('RAZORPAY_WEBHOOK_SECRET'),
      ...(process.env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS
        ? [process.env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS] : []),
    ],
    baseUrl: process.env.RAZORPAY_BASE_URL ?? 'https://api.razorpay.com/v1',
  };
}

/* ---------------------------------------------------------------- money
 *
 * The whole rupee/paise boundary, in two functions, in one place. Rounding is
 * explicit because a silent float error in a money path is a real defect.
 */
const toPaise = (rupees: number) => {
  if (!Number.isFinite(rupees)) throw new AppError('INTERNAL', 'non-numeric amount');
  const p = Math.round(rupees * 100);
  if (p < 100) throw new AppError('VALIDATION', 'The minimum chargeable amount is ₹1');
  return p;
};
const toRupees = (paise: number | null | undefined) =>
  paise == null ? null : Math.round(Number(paise)) / 100;

/* ---------------------------------------------------------------- mapping */

/** Razorpay payment states → our vocabulary.
 *  `authorized` is deliberately IGNORED: with auto-capture it is followed by
 *  `captured`, ordering is not guaranteed, and treating authorisation as money
 *  received would confirm a booking before the funds are ours. */
function mapPaymentStatus(s: string | null | undefined): PaymentEventKind {
  switch ((s ?? '').toLowerCase()) {
    case 'captured': return 'PAYMENT_SUCCEEDED';
    case 'failed': return 'PAYMENT_FAILED';
    case 'authorized': return 'IGNORED';
    case 'created': case 'pending': return 'IGNORED';
    case 'refunded': return 'IGNORED';   // our own refund, already recorded
    default: return 'IGNORED';
  }
}

function mapOrderStatus(s: string | null | undefined): PaymentEventKind {
  switch ((s ?? '').toLowerCase()) {
    case 'paid': return 'PAYMENT_SUCCEEDED';
    case 'attempted': return 'IGNORED';   // tried and not completed — still payable
    case 'created': return 'IGNORED';
    default: return 'IGNORED';
  }
}

function mapRefundStatus(s: string | null | undefined): 'REFUND_PROCESSED' | 'REFUND_FAILED' | 'IGNORED' {
  switch ((s ?? '').toLowerCase()) {
    case 'processed': return 'REFUND_PROCESSED';
    case 'failed': return 'REFUND_FAILED';
    case 'pending': return 'IGNORED';
    default: return 'IGNORED';
  }
}

/* ---------------------------------------------------------------- client */

export function createRazorpayProvider(cfg: RazorpayConfig): PaymentProvider {
  /* Razorpay authenticates the API with HTTP Basic: key_id as the username,
   * key_secret as the password. The secret never leaves this module. */
  const auth = 'Basic ' + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64');

  async function call(path: string, init?: RequestInit) {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      ...init,
      headers: { authorization: auth, 'content-type': 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      /* Log our own reference and the provider's error code. Never the
       * credentials, never the full response, never the request body. */
      console.error('[razorpay] %s %s -> %s %s', init?.method ?? 'GET', path, res.status,
        (body as any)?.error?.code ?? '');
      throw new AppError('INTERNAL',
        'The payment provider could not be reached. Nothing has been charged.');
    }
    return body as any;
  }

  return {
    name: 'RAZORPAY',

    async createOrder(i: CreateOrderInput): Promise<CreatedOrder> {
      const b = await call('/orders', {
        method: 'POST',
        body: JSON.stringify({
          amount: toPaise(i.amountRupees),
          currency: 'INR',
          /* Our payment id as the merchant receipt. Razorpay treats a repeated
           * receipt as the same order, so a double tap cannot create two. */
          receipt: i.reference,
          notes: { dlt_reference: i.reference, note: i.note?.slice(0, 200) ?? '' },
        }),
      });
      return {
        providerOrderId: b.id,
        /* For Razorpay the browser checkout takes the ORDER ID. There is no
         * separate session token to hand out. */
        checkoutHandle: b.id,
        providerStatus: String(b.status ?? 'created'),
      };
    },

    async fetchOrder(providerOrderId): Promise<FetchedOrder> {
      const o = await call(`/orders/${encodeURIComponent(providerOrderId)}`);
      /* An order alone does not name the payment that settled it, and refunds
       * need pay_.... Ask for the order's payments too. */
      let paymentId: string | null = null;
      let paymentStatus: string | null = null;
      try {
        const ps = await call(`/orders/${encodeURIComponent(providerOrderId)}/payments`);
        const captured = (ps.items ?? []).find((p: any) => p.status === 'captured')
          ?? (ps.items ?? [])[0];
        if (captured) { paymentId = captured.id; paymentStatus = captured.status; }
      } catch { /* the order status alone is still usable */ }

      return {
        providerOrderId: o.id,
        kind: paymentStatus ? mapPaymentStatus(paymentStatus) : mapOrderStatus(o.status),
        providerStatus: String(paymentStatus ?? o.status ?? 'unknown'),
        amountRupees: toRupees(o.amount) ?? 0,
        paymentId,
      };
    },

    async createRefund(i): Promise<CreatedRefund> {
      /* Against the PAYMENT, not the order — and only a captured payment can be
       * refunded. `receipt` is our refund row id, which makes this idempotent
       * from our side. */
      const r = await call(`/payments/${encodeURIComponent(i.providerPaymentId)}/refund`, {
        method: 'POST',
        body: JSON.stringify({
          amount: toPaise(i.amountRupees),
          speed: 'normal',
          receipt: i.reference,
          notes: { reason: i.note.slice(0, 200) },
        }),
      });
      return {
        providerRefundId: r.id,
        providerStatus: String(r.status ?? 'pending'),
        kind: mapRefundStatus(r.status),
        acquirerReference: r?.acquirer_data?.arn ?? null,
      };
    },

    /* ---------------------------------------------------------------- webhook */

    verifyAndParseWebhook(rawBody, headers): NormalizedEvent {
      const received = headers['x-razorpay-signature'];
      const eventId = headers['x-razorpay-event-id'];
      if (!received) throw new AppError('FORBIDDEN', 'unsigned webhook');

      /* Hex HMAC-SHA256 over the RAW bytes. No timestamp is part of the signed
       * message, so there is nothing to bound staleness with — replay
       * protection is the event id, enforced by the UNIQUE index on
       * (provider, provider_event_id). Do not add a fake timestamp check here;
       * it would reject legitimate 24-hour retries and legitimate replays. */
      const ok = cfg.webhookSecrets.some((secret) => {
        const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
        const a = Buffer.from(expected, 'utf8');
        const b = Buffer.from(received, 'utf8');
        return a.length === b.length && timingSafeEqual(a, b);
      });
      if (!ok) throw new AppError('FORBIDDEN', 'bad webhook signature');

      if (!eventId)
        throw new AppError('FORBIDDEN',
          'webhook carries no x-razorpay-event-id — refusing to process without replay protection');

      /* Only now is the body trusted enough to parse. */
      const body = JSON.parse(rawBody);
      const event = String(body?.event ?? 'unknown');
      const payment = body?.payload?.payment?.entity ?? null;
      const refund = body?.payload?.refund?.entity ?? null;
      const order = body?.payload?.order?.entity ?? null;

      let kind: PaymentEventKind = 'IGNORED';
      if (event.startsWith('refund.')) kind = mapRefundStatus(refund?.status);
      else if (event.startsWith('payment.')) kind = mapPaymentStatus(payment?.status);
      else if (event.startsWith('order.')) kind = mapOrderStatus(order?.status);

      return {
        providerEventId: eventId,
        provider: 'RAZORPAY',
        kind,
        providerStatus: String(refund?.status ?? payment?.status ?? order?.status ?? event),
        amountRupees: toRupees(refund?.amount ?? payment?.amount ?? order?.amount),
        orderId: payment?.order_id ?? order?.id ?? null,
        paymentId: payment?.id ?? refund?.payment_id ?? null,
        refundId: refund?.id ?? null,
        failureReason: payment?.error_description ?? payment?.error_reason ?? null,
        raw: body,
      };
    },

    /* ---------------------------------------------------------------- handback */

    verifyCheckoutHandback({ ourOrderId, providerPaymentId, signature }) {
      /* hmac_sha256(order_id + "|" + payment_id, key_secret), hex.
       * `ourOrderId` is deliberately the id WE stored, not the
       * razorpay_order_id the browser posted — Razorpay's own warning, and the
       * whole point: a client-supplied order id would let a student verify a
       * signature over a pair of their own choosing. */
      const expected = createHmac('sha256', cfg.keySecret)
        .update(`${ourOrderId}|${providerPaymentId}`, 'utf8').digest('hex');
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(signature ?? '', 'utf8');
      return a.length === b.length && timingSafeEqual(a, b);
    },
  };
}

/* ---------------------------------------------------------------- test double
 *
 * LOCAL TESTS ONLY. Signs with the scheme documented above so the webhook path
 * can be exercised without network access.
 *
 * WHAT IT PROVES: that OUR handling is correct given the documented scheme.
 * WHAT IT DOES NOT PROVE: that Razorpay's live payloads match. The scheme here
 * is read from their docs rather than invented, which narrows the risk — but a
 * test passing against this double is not Razorpay verification and must never
 * be reported as such.
 */
export function createFakeRazorpay(secret = 'test-webhook-secret'): PaymentProvider & {
  orders: Map<string, { id: string; amount: number; status: string; receipt: string; paymentId?: string }>;
  refunds: Map<string, { id: string; status: string }>;
  signedWebhook(payload: unknown, eventId: string): { raw: string; headers: Record<string, string> };
  keySecret: string;
} {
  const orders = new Map<string, any>();
  const refunds = new Map<string, any>();
  const keySecret = 'test-key-secret';
  let n = 0;

  const real = createRazorpayProvider({
    keyId: 'rzp_test_x', keySecret, webhookSecrets: [secret], baseUrl: 'http://unused.invalid',
  });

  return {
    name: 'RAZORPAY',
    orders, refunds, keySecret,

    async createOrder(i) {
      /* mirrors the real receipt-idempotency behaviour */
      for (const o of orders.values())
        if (o.receipt === i.reference) return { providerOrderId: o.id, checkoutHandle: o.id, providerStatus: o.status };
      const id = `order_TEST${++n}`;
      orders.set(id, { id, amount: toPaise(i.amountRupees), status: 'created', receipt: i.reference });
      return { providerOrderId: id, checkoutHandle: id, providerStatus: 'created' };
    },

    async fetchOrder(id) {
      const o = orders.get(id);
      if (!o) throw new AppError('NOT_FOUND', 'no such order');
      return {
        providerOrderId: id,
        kind: o.status === 'paid' ? 'PAYMENT_SUCCEEDED' : 'IGNORED',
        providerStatus: o.status,
        amountRupees: toRupees(o.amount)!,
        paymentId: o.paymentId ?? null,
      };
    },

    async createRefund(i) {
      const id = `rfnd_TEST${++n}`;
      refunds.set(id, { id, status: 'pending' });
      return { providerRefundId: id, providerStatus: 'pending', kind: 'IGNORED', acquirerReference: null };
    },

    verifyAndParseWebhook: real.verifyAndParseWebhook,
    verifyCheckoutHandback: real.verifyCheckoutHandback,

    signedWebhook(payload, eventId) {
      const raw = JSON.stringify(payload);
      const sig = createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
      return { raw, headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId } };
    },
  };
}
