-- DLT · 021 · public departure-time preference poll
--
-- Students can answer without creating an account. The browser receives a
-- random HttpOnly token and only its SHA-256 digest is stored here; signed-in
-- students are keyed from their account id. One identity therefore owns one
-- editable response for this poll, while the HTTP boundary rate-limits abuse.

BEGIN;

CREATE TABLE bus_time_poll_responses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_key         varchar(80) NOT NULL,
  participant_hash char(64) NOT NULL,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  choices          text[] NOT NULL,
  other_time       varchar(60),
  name             varchar(120),
  phone            varchar(20),
  student_id       varchar(32),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bus_time_poll_one_response UNIQUE (poll_key, participant_hash),
  CONSTRAINT bus_time_poll_choice_count CHECK (cardinality(choices) BETWEEN 1 AND 3),
  CONSTRAINT bus_time_poll_known_choices CHECK (
    choices <@ ARRAY[
      '09:00','10:00','11:00','12:00','13:00','14:00',
      '15:00','16:00','17:00','18:00','19:00','OTHER'
    ]::text[]
  ),
  CONSTRAINT bus_time_poll_other_consistent CHECK (
    ('OTHER' = ANY(choices)) = (other_time IS NOT NULL)
  )
);

CREATE INDEX bus_time_poll_recent_idx
  ON bus_time_poll_responses (poll_key, updated_at DESC);

INSERT INTO role_permissions (role, permission) VALUES
  ('OPS_ADMIN', 'poll.read'),
  ('SUPER_ADMIN', 'poll.read')
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON bus_time_poll_responses TO dlt_app;

COMMENT ON TABLE bus_time_poll_responses IS
  'Anonymous or account-linked preferences for the public bus departure-time poll. '
  'participant_hash is a one-way digest; raw browser tokens are never persisted.';

INSERT INTO schema_migrations (filename) VALUES ('021_bus_time_poll.sql');

COMMIT;
