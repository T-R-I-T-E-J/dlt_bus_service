# DLT Production Readiness Checklist

Use this checklist before moving the current unpushed changes to production. This release touches bookings, seats, boarding, admin controls, polls, refunds, payments, and database migrations, so treat it as a payment-sensitive deployment.

## Already Successful Locally

- [x] Backend TypeScript typecheck passed.
- [x] Frontend Node tests passed: 12 tests passed, 0 failed.
- [x] Backend database test suite passed: 378 tests passed, 0 failed.
- [x] Database migrations applied cleanly from zero through migration 023 in a fresh local PostgreSQL database.
- [x] `git diff --check` passed. Only line-ending warnings were reported.
- [x] Razorpay webhook signature handling passed real Express integration tests.
- [x] Payment idempotency and webhook replay protection passed.
- [x] Seat race-condition tests passed.
- [x] Boarding pass validation and manifest privacy tests passed.
- [x] Refund, override refund, duplicate payment, late settlement, and partial settlement tests passed.
- [x] Admin authorization and role-from-database tests passed.
- [x] Audit log immutability tests passed.

## Safety Fixes Included

- [x] Startup database readiness now requires all 23 migrations before the app is considered ready.
- [x] Admin override refund client call now supports the object-shaped API used by the Admin UI.
- [x] Admin override refund now sends an idempotency key.
- [x] Regression test added for Admin override refund client behavior.
- [x] Refund tests now explicitly verify automatic refund dispatch can stay disabled.
- [x] Manual-settlement refund behavior is verified when there is no captured provider payment.
- [x] Production preflight script added: `npm run preflight:prod` from `backend/`.

## Files That Must Be Included In The Production Release

- [ ] Commit all modified frontend pages:
  - `DLT Account.dc.html`
  - `DLT Admin.dc.html`
  - `DLT Booking.dc.html`
  - `DLT Dashboard.dc.html`
  - `DLT Homepage.dc.html`
  - `DLT Policies.dc.html`
- [ ] Commit shared frontend scripts:
  - `dlt-client.js`
  - `journey.js`
  - `test/dlt-client.validatePassenger.test.mjs`
  - `test/page-loading.test.mjs`
- [ ] Commit backend source changes:
  - `backend/src/app.ts`
  - `backend/src/db/index.ts`
  - `backend/src/domain/admin.ts`
  - `backend/src/domain/auth.ts`
  - `backend/src/domain/boarding.ts`
  - `backend/src/domain/payments.ts`
  - `backend/src/domain/polls.ts`
  - `backend/src/domain/refund-presentation.ts`
  - `backend/src/domain/seats.ts`
  - `backend/src/domain/trip-policy.ts`
  - `backend/src/http/admin.routes.ts`
  - `backend/src/http/bookings.routes.ts`
  - `backend/src/http/polls.routes.ts`
- [ ] Commit backend tests:
  - `backend/test/_reset.ts`
  - `backend/test/admin.test.ts`
  - `backend/test/auth.test.ts`
  - `backend/test/boarding.test.ts`
  - `backend/test/http-integration.test.ts`
  - `backend/test/payments.test.ts`
  - `backend/test/phase1-migration.test.ts`
  - `backend/test/polls.test.ts`
  - `backend/test/seats.concurrency.test.ts`
  - `backend/test/security.test.ts`
- [ ] Commit all production migrations:
  - `backend/migrations/019_partial_settlement.sql`
  - `backend/migrations/020_provider_event_retry.sql`
  - `backend/migrations/021_bus_time_poll.sql`
  - `backend/migrations/022_trip_operational_safety.sql`
  - `backend/migrations/023_vehicle_40_seat_configuration.sql`
- [ ] Keep release notes/docs if useful:
  - `ADMIN-AUDIT-ROADMAP.md`
  - `PHASE1-IMPLEMENTATION.md`

## Production Environment Checklist

- [ ] Back up the production database before running migrations.
- [ ] Set `NODE_ENV=production`.
- [ ] Use the production runtime database URL with the restricted runtime role, ideally `dlt_app`.
- [ ] Use a separate migration database URL with owner privileges only for migration execution.
- [ ] Confirm the runtime database role cannot update or delete `audit_logs`.
- [ ] Set real Razorpay live credentials:
  - `RAZORPAY_KEY_ID`
  - `RAZORPAY_KEY_SECRET`
  - `RAZORPAY_WEBHOOK_SECRET`
- [ ] Set real email credentials:
  - `RESEND_API_KEY`
  - verified `EMAIL_FROM`
- [ ] Remove or avoid development-only settings:
  - `EMAIL_TRANSPORT=memory`
  - `ALLOW_AUDIT_PRIVILEGE=i-understand-the-risk`
- [ ] Keep `AUTO_REFUNDS_ENABLED=false` unless the operations team is ready for automatic live refund dispatch.

## Deployment Order

- [ ] Freeze/announce deployment window if students may be booking during the release.
- [ ] Back up production database.
- [ ] Run migrations 019 through 023.
- [ ] Confirm production has all 23 migrations recorded.
- [ ] From `backend/`, run `npm run preflight:prod` on the production host with production environment variables loaded.
- [ ] Deploy backend.
- [ ] Check backend health endpoint.
- [ ] Confirm `/api/health` reports:
  - app is healthy
  - migrations count is 23
  - audit log is append-only for the runtime role
- [ ] Deploy frontend only after backend health is confirmed.
- [ ] Clear CDN/browser cache if old frontend assets are cached.

## Production Smoke Tests

- [ ] Open homepage and booking page from the production URL.
- [ ] Sign up or log in as a normal student account.
- [ ] Confirm available trips load.
- [ ] Hold one seat.
- [ ] Start checkout and verify the Razorpay amount matches the server booking amount.
- [ ] Complete one controlled payment.
- [ ] Confirm the booking becomes confirmed.
- [ ] Confirm the seat becomes booked.
- [ ] Confirm boarding pass is issued.
- [ ] Confirm another student cannot see that booking/payment.
- [ ] Confirm a duplicate checkout/webhook does not create a second booking.
- [ ] Test cancellation quote.
- [ ] If refund is expected, confirm refund is either pending/manual or processed according to `AUTO_REFUNDS_ENABLED`.
- [ ] Log in as admin and confirm dashboard, bookings, payments, trips, vehicles, poll results, and audit pages load.
- [ ] Confirm Admin override refund works only for Super Admin.
- [ ] Confirm boarding staff can scan only their assigned trip.
- [ ] Confirm ordinary booking projections do not expose QR tokens.
- [ ] Confirm poll voting works for a public/anonymous browser.

## Rollback Plan

- [ ] Keep the previous backend deployment available for rollback.
- [ ] Keep the previous frontend deployment available for rollback.
- [ ] Do not roll back database migrations casually after real payments have been accepted.
- [ ] If rollback is needed after migrations, prefer rolling back app code to a database-compatible version.
- [ ] Preserve payment, refund, provider event, booking, and audit records.
- [ ] Escalate any payment mismatch, duplicate payment, missing booking, or refund uncertainty to manual operations review.

## Final Production Sign-Off

- [ ] All code and migrations committed.
- [ ] All local tests passed.
- [ ] Production database backed up.
- [ ] Production migrations completed.
- [ ] Backend health confirmed.
- [ ] Frontend deployed.
- [ ] Controlled payment smoke test completed.
- [ ] Admin and boarding smoke tests completed.
- [ ] Operations team knows whether automatic refunds are enabled or disabled.
- [ ] Release owner approves opening full student traffic.
