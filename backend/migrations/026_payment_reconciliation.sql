-- Server-side recovery when a browser handback or payment webhook is missing.
-- No booking, seat or existing refund is rewritten by this migration.
BEGIN;
ALTER TABLE payments ADD COLUMN last_reconciled_at timestamptz;
ALTER TABLE payments ADD COLUMN reconciliation_error text;
CREATE INDEX payments_reconciliation_queue ON payments (last_reconciled_at NULLS FIRST, created_at)
  WHERE provider_order_id IS NOT NULL AND status IN ('CREATED','PENDING','FAILED','CANCELLED');
INSERT INTO schema_migrations(filename) VALUES ('026_payment_reconciliation.sql');
COMMIT;
