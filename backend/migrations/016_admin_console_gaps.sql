-- DLT · 016 · admin console migration gaps
--
-- Migrating DLT Admin.dc.html off dlt-store.js surfaced six real gaps between
-- what the prototype's in-browser store could do and what the server exposes.
-- Four needed no schema change (trip listing, student search, discrepancy
-- listing, draft validation — all reads/aggregations over existing tables).
-- Two are genuine additive gaps, both closed here:
--
--   1. Revealing a student's emergency contact is a distinct, narrower act
--      than "can read students" — it discloses a third party's name and phone
--      number, not the student's own data. The prototype gated it on
--      isSuper client-side only. Real gate: a dedicated permission, granted
--      to SUPER_ADMIN alone (student.read stays OPS_ADMIN's, as it already
--      is — the roster; not the emergency contact on it).
--
--   2. Reviews (already a real table, migration 001) have hidden_at/hidden_by
--      but nothing distinguishes "acknowledged, kept visible" from "never
--      looked at". The console needs that third state — mirrors the
--      hidden_at/hidden_by pair exactly.

BEGIN;

INSERT INTO role_permissions (role, permission) VALUES
  ('SUPER_ADMIN','student.emergency.reveal')
ON CONFLICT DO NOTHING;

-- The payment-reconciliation view is kept exactly as restrictive as the
-- console has always presented it ("Super Admin only", stated in its own
-- copy) rather than loosened to match payment.read/payment.reconcile, which
-- OPS_ADMIN already holds for its own narrower needs (reading and
-- reconciling ONE payment it already knows the id of). Seeing the full
-- reconciliation list — every payment, across every student — is the
-- broader disclosure and stays Super Admin only, as designed.
INSERT INTO role_permissions (role, permission) VALUES
  ('SUPER_ADMIN','payment.admin')
ON CONFLICT DO NOTHING;

ALTER TABLE reviews
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN resolved_by uuid REFERENCES users(id);

INSERT INTO schema_migrations (filename) VALUES ('016_admin_console_gaps.sql');

COMMIT;
