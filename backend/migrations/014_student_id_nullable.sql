-- DLT · 014_student_id_nullable.sql
--
-- Approved decision (Account migration, 2 Sep 2026): signup allows studentId
-- to be absent, but student_profiles.student_id was NOT NULL — every signup
-- without a studentId crashed with a 500 (uncaught not-null violation).
--
-- The intended lifecycle, already implemented on the approval side
-- (domain/admin.ts decideRequest, kind='STUDENT_ID_CHANGE') and already
-- described in DLT Account.dc.html's own copy ("your student ID change has
-- gone to operations for review"), is: sign up, profile exists, student_id
-- may start NULL, the student supplies it later, operations reviews the
-- change. The NOT NULL was therefore the defect, not the optionality.
--
-- The unique index is untouched and still correct: it is declared over
-- upper(student_id), and Postgres treats every NULL as distinct from every
-- other NULL in a unique index, so any number of profiles may be NULL at
-- once without a collision — only two equal non-null ids still conflict.

BEGIN;

ALTER TABLE student_profiles ALTER COLUMN student_id DROP NOT NULL;

INSERT INTO schema_migrations (filename) VALUES ('014_student_id_nullable.sql');

COMMIT;
