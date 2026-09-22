-- DLT · 024 · bidirectional launch route policy
--
-- The public site and admin console now support scheduling departures in both
-- directions. The first live service can still publish only Woxsen -> Miyapur,
-- but the reverse route exists as a normal route so operations can add trips
-- without a schema or code change later.

BEGIN;

INSERT INTO routes (code, origin, destination, duration_min, active)
VALUES ('WX-MYP', 'Woxsen University', 'Miyapur Metro', 120, true)
ON CONFLICT (code) DO UPDATE
  SET origin = EXCLUDED.origin,
      destination = EXCLUDED.destination,
      duration_min = EXCLUDED.duration_min,
      active = true;

INSERT INTO routes (code, origin, destination, duration_min, active)
VALUES ('MYP-WX', 'Miyapur Metro', 'Woxsen University', 120, true)
ON CONFLICT (code) DO UPDATE
  SET origin = EXCLUDED.origin,
      destination = EXCLUDED.destination,
      duration_min = EXCLUDED.duration_min,
      active = true;

INSERT INTO schema_migrations (filename) VALUES ('024_bidirectional_route_policy.sql');

COMMIT;
