/* DLT · domain/payment-provider.ts — the provider-neutral interface.
 *
 * The domain depends on THIS and never on an acquirer. Two rules keep it that
 * way, and both were broken by the Cashfree code this replaces:
 *
 *   1. No provider payload shape crosses this boundary. An adapter returns
 *      `NormalizedEvent`, whose vocabulary is ours.
 *   2. No provider money unit crosses it. Everything here is WHOLE RUPEES,
 *      matching the schema. Razorpay speaks paise; that conversion is the
 *      adapter's job and appears nowhere above it.
 *
 * WRITTEN, NOT EXECUTED.
 */

/** What the domain does about an event. Provider event names are mapped onto
 *  these by the adapter — `payment.captured`, `payment.authorized`,
 *  `refund.processed` and their equivalents never appear in domain code. */
export type PaymentEventKind =
  | 'PAYMENT_SUCCEEDED'
  | 'PAYMENT_FAILED'
  | 'REFUND_PROCESSED'
  | 'REFUND_FAILED'
  | 'IGNORED';

export interface NormalizedEvent {
  /** The provider's own unique event identifier. This is the ONLY thing
   *  standing between us and a double-applied webhook, so an adapter must
   *  source it from a genuinely per-event value and never synthesise something
   *  that could repeat. */
  providerEventId: string;
  provider: string;
  kind: PaymentEventKind;
  /** Verbatim provider status, for operator diagnosis. Never branched on. */
  providerStatus: string | null;
  /** WHOLE RUPEES, converted by the adapter. */
  amountRupees: number | null;
  orderId: string | null;
  paymentId: string | null;
  refundId: string | null;
  failureReason: string | null;
  raw: unknown;
}

export interface CreateOrderInput {
  /** Our payment row id. Doubles as the provider's merchant reference, which is
   *  what makes order creation idempotent from our side. */
  reference: string;
  amountRupees: number;
  customer: { id: string; name: string; phone: string; email?: string };
  note?: string;
}

export interface CreatedOrder {
  providerOrderId: string;
  /** Whatever the browser checkout needs to open. For Razorpay this is the
   *  order id itself; other providers return a session token. The client is
   *  handed this and nothing else. */
  checkoutHandle: string;
  providerStatus: string;
}

export interface FetchedOrder {
  providerOrderId: string;
  /** Our verdict on the provider's status, not the provider's word for it. */
  kind: PaymentEventKind;
  providerStatus: string;
  amountRupees: number;
  paymentId: string | null;
}

export interface CreatedRefund {
  providerRefundId: string;
  providerStatus: string;
  /** Settled immediately, or still moving. */
  kind: 'REFUND_PROCESSED' | 'REFUND_FAILED' | 'IGNORED';
  acquirerReference: string | null;
}

export interface PaymentProvider {
  readonly name: string;

  createOrder(i: CreateOrderInput): Promise<CreatedOrder>;
  fetchOrder(providerOrderId: string): Promise<FetchedOrder>;

  /** Refunds are created against the provider's PAYMENT id, not the order. */
  createRefund(i: {
    providerPaymentId: string; amountRupees: number; reference: string; note: string;
  }): Promise<CreatedRefund>;

  /** Verifies the signature over the RAW bytes and normalises. Throws if the
   *  signature does not verify — the caller records the attempt and drops it.
   *  Must never be given a parsed-and-restringified body. */
  verifyAndParseWebhook(rawBody: string, headers: Record<string, string | undefined>): NormalizedEvent;

  /** Verifies the checkout handback the browser posts back. Returns false for
   *  anything that does not verify; a `true` here still does not confirm a
   *  booking — only a verified provider event does that. */
  verifyCheckoutHandback(i: {
    ourOrderId: string; providerPaymentId: string; signature: string;
  }): boolean;
}
