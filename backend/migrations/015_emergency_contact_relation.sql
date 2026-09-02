-- DLT · 015_emergency_contact_relation.sql
--
-- Mismatch found migrating Account: the emergency contact section has always
-- had a Relationship field (dlt-store.js's prototype stored
-- emergencyContact.{name,phone,relation}; DLT Account.dc.html still renders an
-- ecRelation input), but migration 003 only added emergency_contact_name and
-- emergency_contact_phone. Migrating Account onto the real API without this
-- column would silently drop a field the screen has always collected —
-- "preserve emergency contact behavior" requires it exist, not be invented
-- client-side. Purely additive: one nullable column, no existing row affected.

BEGIN;

ALTER TABLE student_profiles ADD COLUMN emergency_contact_relation text;

INSERT INTO schema_migrations (filename) VALUES ('015_emergency_contact_relation.sql');

COMMIT;
