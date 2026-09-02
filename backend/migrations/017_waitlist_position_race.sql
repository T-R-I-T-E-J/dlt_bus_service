-- DLT · 017 · waitlist position race — backstop
--
-- THE DEFECT, found under real concurrent HTTP load-testing (not a code
-- review guess): joinWaitlist and moveWaitlistToTop (domain/seats.ts,
-- domain/admin.ts) both computed a new position with a plain SELECT
-- max()/min() and no lock, then inserted/updated it in a later statement.
-- Two transactions could both read the same value before either committed.
-- Reproduced live: 5 concurrent joins on one trip produced position 1
-- three times.
--
-- Not a seat-safety defect — offer_seat_to_waitlist() (migration 002)
-- already orders by (position, created_at) with FOR UPDATE SKIP LOCKED, so
-- a duplicate position could never hand two students the same seat. It IS
-- a real fairness/display defect: two students both told "you are #1."
--
-- The application-level fix (this migration's pair) is locking the trip row
-- before computing the next/top position, in both call sites — the same
-- technique this codebase already uses for trip mutations. This index is
-- the backstop matching this project's own stated philosophy elsewhere
-- ("the unique index is a real backstop") — belt and suspenders, not
-- either/or. A row lock closes the race; the constraint is what catches it
-- if a future code path ever reintroduces it.

BEGIN;

CREATE UNIQUE INDEX waitlist_position_unique_per_trip
  ON waitlist_entries (trip_id, position);

INSERT INTO schema_migrations (filename) VALUES ('017_waitlist_position_race.sql');

COMMIT;
