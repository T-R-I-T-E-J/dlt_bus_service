-- DLT · 010 · pgcrypto extension
--
-- THE DEFECT: 005 and the domain both generate the guest/booking token with
--   'dlt.' || encode(gen_random_bytes(14), 'hex')
-- gen_random_bytes() lives in the pgcrypto extension, which no migration ever
-- created. On a clean database every guest-token path raises
--   function gen_random_bytes(integer) does not exist
-- The token scheme is correct (14 random bytes, 112 bits); it just needs the
-- extension present. Nothing here changes a token format or weakens entropy.
--
-- Forward-only, like every migration: IF NOT EXISTS so it is a no-op on a
-- database where the DBA has already installed pgcrypto.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO schema_migrations (filename) VALUES ('010_pgcrypto.sql');

COMMIT;
