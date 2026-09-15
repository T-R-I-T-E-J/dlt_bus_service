# DLT Production Readiness Checklist

Production move record for the current release. This release touches bookings, seats, boarding, admin controls, polls, refunds, payments, and database migrations, so treat it as a payment-sensitive deployment.

## Production Move Completed On 2026-09-15

- [x] Release committed and pushed to `master`: `af61c2e6978761ca478dfdcc025ae2d89de609e2`.
- [x] Production database backup created before migrations: `C:\Users\trite\Downloads\dlt-production-backups\dlt-prod-20260915T163710Z.dump`.
- [x] Production migrations completed through migration 023.
- [x] Production schema now reports 23 migrations.
- [x] Production preflight passed on Railway with production environment variables loaded.
- [x] Railway backend production deployment succeeded: `41a1c6f6-7d27-452f-8551-23ef92bf9b9e`.
- [x] Vercel frontend production deployment succeeded: `dpl_GxJJ2i6cRYbNTf526RALeDnZi7xw`.
- [x] Production API health is green at `https://dltservices.tech/api/health`.
- [x] Production Railway API health is green at `https://dlt-api-production.up.railway.app/api/health`.
- [x] Production health reports `migrations: 23`, `auditAppendOnly: true`, `email: resend`, and `provider: RAZORPAY`.
- [x] Railway deploy error-log check returned no error entries for the new backend deployment.
- [x] Vercel production error/fatal runtime-log check returned no entries for the new frontend deployment window.

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

## Files Included In The Production Release

- [x] Committed all modified frontend pages:
  - `DLT Account.dc.html`
  - `DLT Admin.dc.html`
  - `DLT Booking.dc.html`
  - `DLT Dashboard.dc.html`
  - `DLT Homepage.dc.html`
  - `DLT Policies.dc.html`
- [x] Committed shared frontend scripts:
  - `dlt-client.js`
  - `journey.js`
  - `test/dlt-client.validatePassenger.test.mjs`
  - `test/page-loading.test.mjs`
- [x] Committed backend source changes:
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
- [x] Committed backend tests:
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
- [x] Committed all production migrations:
  - `backend/migrations/019_partial_settlement.sql`
  - `backend/migrations/020_provider_event_retry.sql`
  - `backend/migrations/021_bus_time_poll.sql`
  - `backend/migrations/022_trip_operational_safety.sql`
  - `backend/migrations/023_vehicle_40_seat_configuration.sql`
- [x] Kept release notes/docs:
  - `ADMIN-AUDIT-ROADMAP.md`
  - `PHASE1-IMPLEMENTATION.md`

## Production Environment Checklist

- [x] Backed up the production database before running migrations.
- [x] Confirmed `NODE_ENV=production` through production preflight.
- [x] Confirmed production runtime database URL uses a restricted runtime role.
- [x] Used a separate migration database URL with owner privileges only for migration execution.
- [x] Confirmed the runtime database role cannot update or delete `audit_logs`.
- [x] Confirmed Razorpay credentials are present in production:
  - `RAZORPAY_KEY_ID`
  - `RAZORPAY_KEY_SECRET`
  - `RAZORPAY_WEBHOOK_SECRET`
- [x] Confirmed email credentials are present in production:
  - `RESEND_API_KEY`
  - verified `EMAIL_FROM`
- [x] Confirmed development-only settings are avoided in production:
  - `EMAIL_TRANSPORT=memory`
  - `ALLOW_AUDIT_PRIVILEGE=i-understand-the-risk`
- [x] Confirmed production preflight completed with refund safety checks.

## Deployment Order

- [ ] Freeze/announce deployment window if students may be booking during the release.
- [x] Backed up production database.
- [x] Ran migrations 019 through 023.
- [x] Confirmed production has all 23 migrations recorded.
- [x] From `backend/`, ran `npm run preflight:prod` on the production host with production environment variables loaded.
- [x] Deployed backend.
- [x] Checked backend health endpoint.
- [x] Confirmed `/api/health` reports:
  - app is healthy
  - migrations count is 23
  - audit log is append-only for the runtime role
- [x] Deployed frontend.
- [ ] Clear CDN/browser cache if old frontend assets are cached.

## Production Smoke Tests

- [x] Opened homepage and booking page from the production URL.
- [ ] Sign up or log in as a normal student account.
- [x] Confirmed public trips endpoint loads successfully.
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
- [x] Confirmed public poll endpoint loads successfully for an anonymous browser.

## Rollback Plan

- [ ] Keep the previous backend deployment available for rollback.
- [ ] Keep the previous frontend deployment available for rollback.
- [ ] Do not roll back database migrations casually after real payments have been accepted.
- [ ] If rollback is needed after migrations, prefer rolling back app code to a database-compatible version.
- [ ] Preserve payment, refund, provider event, booking, and audit records.
- [ ] Escalate any payment mismatch, duplicate payment, missing booking, or refund uncertainty to manual operations review.

## Final Production Sign-Off

- [x] All code and migrations committed.
- [x] All local tests passed.
- [x] Production database backed up.
- [x] Production migrations completed.
- [x] Backend health confirmed.
- [x] Frontend deployed.
- [ ] Controlled payment smoke test completed.
- [ ] Admin and boarding smoke tests completed.
- [ ] Operations team knows whether automatic refunds are enabled or disabled.
- [ ] Release owner approves opening full student traffic.
