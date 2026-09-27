# Seat and refund audit — 27 September 2026

Local code investigation and implementation. No production access, deployment,
live payment/refund call, environment change or production data repair was made.

## What explains the reported refund

There are two separate events: Razorpay capturing money and DLT confirming a
booking. Before this change, recovery of a missing capture webhook depended on
the student's browser calling reconciliation. A closed tab or failed callback
could leave a paid order recorded locally as pending until the hold expired.

The hold sweeper releases expired HELD seats and marks pending bookings
ABANDONED. A capture processed afterwards raises a refund obligation. The SQL
explicitly refuses to revive an ABANDONED booking, **even if its seat is still
empty**. Existing integration tests reproduce this behavior. Therefore a refund
does not establish that another student bought the seat.

Example consistent with the code: checkout extends the hold to minute 15;
Razorpay captures at minute 6; neither handback nor webhook is processed;
cleanup expires the booking at minute 15; confirmation arrives at minute 16
and records a refund. The current code has a 10-minute hold, a checkout renewal
bounded by 30 minutes from booking creation, and cleanup every 30 seconds.
There is no dedicated timer that refunds CONFIRMED bookings after 15 minutes.

A fully confirmed booking uses BOOKED seats with cleared hold clocks. Ordinary
expiry does not cancel it. If a valid pass really was issued before cancellation,
the affected live booking, payment, provider events and audit timeline must be
inspected to establish that incident's cause. This local investigation cannot
prove which deployed version or event sequence handled historical transactions.

## Why no refund does not by itself establish payment health

`AUTO_REFUNDS_ENABLED=false` stops provider dispatch, not the creation of refund
obligations or hold expiry. The repository's 5 September production audit records
that flag as false; its current live value was not checked in this investigation.
An expired booking can therefore still have captured money and an undispatched
REFUND_PENDING row. This work does not enable the switch or rewrite old refunds.

## Implemented locally

- Background reconciliation runs every 20 seconds, checking each unresolved
  provider order at most once per minute. It covers recent pending, failed and
  cancelled intents for 24 hours, uses database claims across workers, preserves
  hold deadlines, and records recovery errors. Provider calls have a timeout;
  in-process jobs do not overlap themselves. Network failure is not treated as
  evidence that a payment failed.
- A successful retry replaces the earlier failed attempt's payment ID. Later
  failure events cannot downgrade a SUCCESS or DUPLICATE receipt.
- Reconciliation requires the captured payment identity and uses its actual
  amount; a paid order whose payment lookup fails is retried, not silently
  confirmed with an unknown payment ID.
- Refund dispatch uses the refund's specific payment ID. A refund without an
  explicit payment targets only the booking's unique successful payment, never
  an arbitrary duplicate. Manual refunds no longer block the following rows.
- Refund requests send `X-Refund-Idempotency` with the stable refund UUID.
  Receipt alone was not the documented idempotency mechanism. New failed calls
  back off; ambiguous old `dispatch error:` records and interrupted `dispatching`
  records remain for manual reconciliation rather than being blindly replayed.
- New refund reasons distinguish abandoned, cancelled, unavailable trip and
  unavailable seats. They say refund pending, not money already returned, and
  do not assert another student purchased a seat without evidence.
- The booking page handles captured-but-unconfirmed payments as a review state
  instead of an endless confirmation spinner. Duplicate-payment messaging
  preserves the original booking's confirmed status.

Migration 026 adds reconciliation timestamps/errors and a queue index. Startup
requires it. Migration 025 and the prior database-readiness edit already existed
in the workspace; they were preserved. No existing seat/refund data is rewritten
by migration 026.

## Verification and limits

- All 26 migrations applied to a newly created isolated PostgreSQL 16 database
  bound to 127.0.0.1:5467, named `dlt_phase1_test_payment_audit`.
- Combined payment, seat-concurrency and adapter run: 126 tests passed.
- Final targeted payment/refund regression run after the last changes: 18 tests passed.
- Frontend loading/payment-state and passenger validation run: 13 tests passed.
- TypeScript and whitespace checks passed.
- Payment-provider tests use a fake provider or mocked HTTP responses; they do
  not verify live Razorpay behavior or physical bank refunds.

Polling reduces reliance on webhooks but cannot guarantee capture is discovered
before expiry during a prolonged provider/server outage or a saturated recovery
queue. Existing late-payment refund policy remains in force; abandoned bookings
are not resurrected and seats are never stolen from a later holder. Orders older
than the automatic recovery window, terminal event-processing errors, and old
ambiguous refund attempts require operator reconciliation. Refunds whose provider
ID exists still rely on the refund webhook for the final status.

Before any separately authorized production rollout, inspect affected booking
timelines and review outstanding refund obligations against provider records.
Do not enable refund dispatch as a side effect of deploying these changes.

Provider reference: [Razorpay normal refund idempotency](https://razorpay.com/docs/api/refunds/normal-refunds-idempotent).
