# Website Audit Production Checklist

Updated: 15 September 2026

## Decisions Applied

| Area | Before | After |
| --- | --- | --- |
| No active trips | Primary CTA still said "Book a seat" even when public trips were empty. | Homepage CTA switches to "Get notified" until an active trip exists; booking page keeps the notify form. |
| Fare | Public copy and admin defaults still used Rs 259. | Launch fare is Rs 299 across public pages, policy copy, admin trip defaults, seed data and prototype constants. |
| Reporting time | Copy and prototype timing showed 20 minutes; backend default was 15 minutes. | Server default is 30 minutes before departure, and public/admin/policy copy matches. |
| Route direction | Admin trip creation silently used the first route. | Admin has a route selector and the production DB has Woxsen -> Miyapur plus Miyapur -> Woxsen. |
| Journey duration | Production route was 75 minutes while the site said about 2 hours. | Both production route records use 120 minutes so arrival estimates are server-derived consistently. |
| Policies | Payment, student ID and retention sections still had undecided notes. | Launch policy is decided: no added fees/coupons/GST invoice, student ID accepted as printed, concrete retention periods. |
| Homepage density | FAQ and About sections were long and repeated internal detail. | About is shorter and FAQ is focused on the most important student questions. |
| Support | Homepage said support channel pending while booking linked WhatsApp. | Homepage now uses the same WhatsApp support link as booking. |
| Booking loading | The booking flow waited on auth before showing public trips and empty money labels showed broken rupee placeholders. | Public departures start loading immediately; empty summary shows clean "Fare after departure" and dash totals. |

## Successful Checks

- [x] Static scan: production-facing files contain no old Rs 259 launch fare, 20-minute reporting copy, undecided policy labels or empty fare/time placeholders.
- [x] Frontend/module tests: `node --test test/*.test.mjs` passed 12/12.
- [x] JavaScript syntax checks: `node --check dlt-client.js` and `node --check dlt-store.js` passed.
- [x] Backend typecheck: `npm run typecheck` passed in `backend`.
- [x] Production DB migration tested on Neon snapshot branch `br-bitter-union-azc4c3fu`.
- [x] Production DB migrated to 24 migrations with both active route directions at 120 minutes.
- [x] Railway production API deployed successfully from commit `4b3abc7` with 24 migrations.
- [x] Vercel production site deployed successfully from commit `4b3abc7`.
- [x] Live API health check passed on `https://dltservices.tech/api/health`.
- [x] Live public trips check returned zero active trips, so no-trip CTAs are expected.
- [x] Live homepage browser check: top CTA, no-trip CTA and footer CTA show "Get notified".
- [x] Live booking browser check: no-trip screen shows the notify form and clean dash totals.

## Remaining Risk

- [ ] Full backend DB test suite could not run locally because `DATABASE_URL` was unset and Docker Desktop was not running. The test harness correctly refused destructive fixtures without a disposable `dlt_phase1_test` database.
