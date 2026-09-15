-- DLT · 020 · a transient failure must not permanently swallow a payment
--
-- THE DEFECT. processPendingEvents applies one event inside a transaction and,
-- on ANY error, records it as done:
--
--     }).catch(async (e) => {
--       await query('UPDATE provider_events SET processed_at = now(),
--                    process_error = $2 WHERE id = $1', ...);
--
-- processed_at is the only thing that decides whether an event is ever looked
-- at again, so a DEADLOCK — which is transient by definition, and which
-- production logged four times in two hours on trip_seats — permanently
-- discards a real captured payment. The payment row stays PENDING, the
-- booking never confirms, its hold lapses, the sweeper abandons it, and the
-- money is later refunded automatically. A retry that Postgres expects the
-- caller to perform was being treated as a terminal outcome.
--
-- THE FIX. Distinguish transient from terminal. A transient failure leaves
-- processed_at NULL and is retried with backoff; a genuine logic failure is
-- recorded as before. attempts bounds it, so a fault that merely LOOKS
-- transient cannot loop forever — after the cap it is marked processed with
-- its error, exactly as today, and surfaces in operational_alerts.
--
-- next_attempt_at also removes head-of-line blocking: the failing event stops
-- being re-selected ahead of everything behind it on every 20-second cycle.

BEGIN;

ALTER TABLE provider_events
  ADD COLUMN attempts        int NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz;

INSERT INTO schema_migrations (filename) VALUES ('020_provider_event_retry.sql');

COMMIT;
