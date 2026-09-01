-- DLT · 006 · provider-neutral payment events, Razorpay as the provider
--
-- WHY THIS MIGRATION EXISTS
--
-- 005 was written against Cashfree and leaked two provider assumptions:
--   1. `applyEvent` in the domain read `raw_body.data.payment.payment_status`,
--      i.e. Cashfree's payload shape, inside business logic.
--   2. Amounts were assumed to be whole rupees end to end.
--
-- Razorpay differs on both counts (amounts are in PAISE, and the payload shape
-- is `payload.payment.entity`). Rather than teach the domain a second shape,
-- this migration adds NORMALISED columns to provider_events. The adapter
-- normalises once at receipt; the domain reads columns and never sees a raw
-- provider body again. Adding a third provider later touches only an adapter.
--
-- What is deliberately NOT changed: every business rule, constraint and trigger
-- from 001–005. `provider_events` was already UNIQUE (provider,
-- provider_event_id), so event ids were already scoped per provider rather than
-- globally — no change needed there.

BEGIN;

-- ---------------------------------------------------------------- neutral events

-- The vocabulary the domain reasons about. Provider event names
-- (`payment.captured`, `refund.processed`, `PAYMENT_SUCCESS_WEBHOOK`, …) are
-- mapped onto these by the adapter and never appear above it.
CREATE TYPE payment_event_kind AS ENUM (
  'PAYMENT_SUCCEEDED',   -- money captured and ours
  'PAYMENT_FAILED',      -- attempt failed, dropped or cancelled
  'REFUND_PROCESSED',    -- a refund reached the customer
  'REFUND_FAILED',
  'IGNORED'              -- verified, recorded, no action (e.g. payment.authorized)
);

ALTER TABLE provider_events
  ADD COLUMN kind_normalized     payment_event_kind,
  -- amounts here are RUPEES, converted from the provider's own unit by the
  -- adapter. The domain has one money unit and it is the one the schema uses.
  ADD COLUMN amount_rupees       integer,
  ADD COLUMN subject_order_id    text,   -- provider's order id  (order_...)
  ADD COLUMN subject_payment_id  text,   -- provider's payment id (pay_...)
  ADD COLUMN subject_refund_id   text,   -- provider's refund id  (rfnd_...)
  ADD COLUMN failure_reason      text,
  ADD COLUMN provider_status     text;   -- verbatim, for operator diagnosis only

COMMENT ON COLUMN provider_events.raw_body IS
  'The exact bytes the provider sent. Kept for audit and for re-normalising if '
  'an adapter bug is found. Business logic must never read it — read the '
  'kind_normalized / amount_rupees / subject_* columns instead.';

CREATE INDEX provider_events_subject_refund_idx ON provider_events (subject_refund_id)
  WHERE subject_refund_id IS NOT NULL;

-- 001 pointed refund_id at nothing; make it a real reference now that refunds
-- carry provider identity.
ALTER TABLE provider_events
  ADD CONSTRAINT provider_events_refund_fk
  FOREIGN KEY (refund_id) REFERENCES refunds(id);

-- ---------------------------------------------------------------- payments

-- provider_order_id and provider_reference were already provider-neutral names.
-- What was missing is the provider's PAYMENT id as a first-class column:
-- Razorpay refunds are created against pay_..., not against the order, so this
-- is required rather than cosmetic.
ALTER TABLE payments
  ADD COLUMN provider_payment_id text;
CREATE UNIQUE INDEX payments_provider_payment_key ON payments (provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

ALTER TABLE payments ALTER COLUMN provider SET DEFAULT 'RAZORPAY';
ALTER TABLE provider_events ALTER COLUMN provider SET DEFAULT 'RAZORPAY';

-- Existing rows: this project has never run against a live acquirer, so there
-- is no real Cashfree history to preserve. Any row that exists is local test
-- data and is relabelled rather than deleted, so provider-scoped uniqueness
-- stays meaningful and nothing is silently destroyed.
UPDATE payments        SET provider = 'RAZORPAY' WHERE provider = 'CASHFREE';
UPDATE provider_events SET provider = 'RAZORPAY' WHERE provider = 'CASHFREE';

-- ---------------------------------------------------------------- refunds

-- Razorpay refunds have their own lifecycle: pending → processed | failed,
-- reported by the refund.processed webhook, which their documentation calls the
-- definitive source. Our REFUND_PENDING / REFUNDED / REFUND_FAILED enum already
-- matches that shape; what it lacked was the provider's own identifiers.
ALTER TABLE refunds
  ADD COLUMN provider            text NOT NULL DEFAULT 'RAZORPAY',
  ADD COLUMN provider_refund_id  text,
  ADD COLUMN provider_status     text,
  ADD COLUMN speed_requested     text,
  ADD COLUMN acquirer_reference  text;   -- ARN/RRN/UTR, what a student quotes to their bank
CREATE UNIQUE INDEX refunds_provider_refund_key ON refunds (provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;

-- Razorpay wants a merchant-side idempotency handle on refund creation
-- (`receipt`). Our refunds.id is a uuid and serves exactly that purpose; this
-- comment records the contract so nobody invents a second one.
COMMENT ON COLUMN refunds.id IS
  'Also sent to the provider as the merchant reference (Razorpay `receipt`), '
  'which makes refund creation idempotent from our side.';

INSERT INTO schema_migrations (filename) VALUES ('006_provider_neutral_razorpay.sql');

COMMIT;
