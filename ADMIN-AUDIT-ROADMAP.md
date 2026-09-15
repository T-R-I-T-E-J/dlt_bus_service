# DLT Super Admin: Product Audit and Approval Roadmap

Audit date: 5 September 2026. Status: proposal only, awaiting approval.

No application code, production records, configuration, permissions, or deployments were changed during this audit. This document is the only new artifact.

## Executive Recommendation

Keep the existing application and architecture: Vercel -> Railway dlt-api -> Neon PostgreSQL, with Razorpay LIVE. Refine around a trip workspace, rather than adding more disconnected sidebar pages.

Prioritize operational correctness before cosmetic cleanup: terminal trip states, real 40-seat configuration, publishing safeguards, and accurate payment/refund presentation. Then introduce focused trip lists and a passenger manifest that separates booking, payment, refund, and boarding status.

Do not rebuild the scanner, replace the payment engine, add arbitrary free-text routes to every trip, or hide unresolved past trips merely to make the list look clean.

## Evidence and Limits

Inspected the signed-in production Super Admin UI, admin/client and student-page source, all relevant HTTP route modules, domain services, schema migrations, permissions, reporting queries, lifecycle functions, and existing test coverage. Read production database metadata and aggregate data in a READ ONLY transaction through the DATABASE_URL configured on Railway production dlt-api. Connection credentials were not printed or saved.

Production snapshot:

| Observation | Result |
| --- | --- |
| Applied migrations | 21 |
| Vehicle DLT-01 | 11 rows, 44 seats, AVAILABLE |
| Materialized seats | All eight trips have 44 seat records |
| Current HELD/BOOKED seats above row 10 | Zero at inspection; this is not approval to delete historical seats |
| Routes | One: Woxsen University -> Miyapur Metro |
| Trip states | Six CANCELLED, one BOOKING_CLOSED, one BOARDING |
| Overdue nonterminal departures | Two, more than six hours past departure |
| Student accounts / reviews / waitlist entries | 49 / 0 / 9 |
| Pending requests | Seven GET_NOTIFIED, one STUDENT_ID_CHANGE, one ACCOUNT_DELETION |
| Railway automatic refund dispatch | AUTO_REFUNDS_ENABLED=false |

The deployed set_trip_status function was read and confirms that only CANCELLED is protected as terminal. Other handler findings below are established from the inspected repository; destructive API calls were not used to demonstrate them. No real refund, cancellation, booking creation, boarding action, account deletion, or message submission was performed. This is a product/code/schema audit, not a penetration test or a certification of financial reconciliation.

## Highest-Risk Findings

1. **Critical: completed trips are not terminal at the database status boundary.** set_trip_status allows arbitrary transitions except from/to CANCELLED. The HTTP status endpoint accepts DRAFT through COMPLETED. cancelTrip only rejects an already-cancelled trip before creating refund records and releasing bookings. UI cancellation visibility is narrower, but that is insufficient enforcement. saveTrip, manual booking, and seat blocking also need a shared lifecycle policy. Evidence: backend/migrations/008_admin_operations.sql:178; backend/src/http/admin.routes.ts:94; backend/src/domain/admin.ts:120 and :200; backend/src/domain/payments.ts:819.

2. **Critical: the 44-seat capacity is real inventory, not a label error.** capacity is generated as row_count * 4; seat materialization creates A-D for every row. The live vehicle and all trip maps have 44. A vehicle edit does not automatically rebuild existing trip maps. Evidence: backend/migrations/001_init.sql:120; backend/migrations/002_seat_allocation.sql:234; backend/migrations/008_admin_operations.sql:105.

3. **High: lifecycle completion is operationally incomplete.** The Trips row opens the scanner for BOARDING; it exposes Mark completed only for DEPARTED. No normal Mark departed action was found. Registered jobs sweep holds, process payment events, and optionally dispatch refunds; they do not advance trip statuses. Two old trips remain operational in production. Do not infer actual departure or arrival solely from the clock. Evidence: DLT Admin.dc.html:2148; backend/src/app.ts:startJobs.

4. **High: validation claims exceed enforcement.** The UI promises vehicle availability validation. validateTripDraft checks draft status, vehicle presence, seat count, and departure time, but not maintenance or schedule overlap. publishTrip checks draft, vehicle presence, and a nonempty map, but does not repeat even the departure-time check. No vehicle-overlap constraint was found. Evidence: backend/src/domain/admin.ts:162 and :759.

5. **High: refund visibility is misleading while dispatch is paused.** The flag stops provider dispatch, not creation of refund obligations. Duplicate, mismatch, partial, late settlement, and cancellation paths can still create refund rows. Some messages say money was refunded before provider completion. Turning dispatch on later could process queued obligations; it must not be an incidental side effect of this refinement. Evidence: backend/src/domain/payments.ts:336, :500, :633, :669; backend/src/app.ts:startJobs.

6. **High: financial report permissions do not match the product restriction.** Payment reconciliation uses payment.admin; the refund report button is Super Admin-only, but report(kind) and its HTTP boundary check generic report.read/report.export. OPS_ADMIN has these permissions in the migrations. Enforce the chosen financial-report policy in the backend, including exports; this was not tested by impersonating an operator. Evidence: backend/src/domain/admin.ts:524 and :621; backend/src/http/admin.routes.ts:ReportKind; backend/migrations/003_auth.sql:60; DLT Admin.dc.html:1723.

7. **High: records can disappear beyond hard limits.** Trips and booking searches cap at 500, reviews and requests at 200; the UI does not offer complete cursor navigation. Audit already has a backend cursor, but the admin loads only the first 500. Some other lists fetch every record. Raising limits is neither completeness nor a durable performance fix. Evidence: backend/src/domain/admin.ts:340, :381, :734, :950; backend/src/domain/audit.ts:readAudit; DLT Admin.dc.html:_loadSection.

8. **Medium: trip context is lost in several actions.** A terminal trip's View action opens the global booking search without a trip filter. Alert Review actions navigate to a section without the affected booking/trip. Route direction is missing from trip rows. Evidence: DLT Admin.dc.html:2110 and :2195.

## Recommended Navigation

Keep a short sidebar with these destinations:

| Destination | Contents |
| --- | --- |
| Overview | Today's operations, upcoming departures, overdue closeout, exceptions, short recent activity |
| Trips | Current & Upcoming, Drafts, History; persistent search and filters |
| Bookings & Passengers | Two row modes using the same trip/date scope; linked detail drawer |
| Boarding | Existing scanner and manifest, trip scope, progress, exceptions |
| Payments & Refunds | Payment attempts, refund obligations, provider progress, exceptions; permission-specific tabs |
| Students | Searchable directory and student detail; account requests |
| Demand & Requests | Waitlists, schedule poll, notify interest, pending service requests as distinct tabs |
| Feedback | Internal feedback inbox and resolution |
| Reports | Filtered previews and matching exports |
| Management | Vehicles, Routes & Locations, staff assignments/access appropriate to permission |
| Audit | Searchable immutable history with cursor navigation |

This is grouping, not eleven new products. Retain existing endpoints where their contracts are sufficient. Do not build a custom role editor just to support this structure.

Trip workspace: a persistent header with direction, date/time in IST, vehicle, capacity, status, last refresh, and the next valid action. Tabs: Overview, Passengers, Seats, Boarding, Payments, Activity. Context survives tab changes, browser Back, refresh, and shared admin links. Sidebar Boarding can open the same trip's scanner directly.

## Trips and Lifecycle

Use existing enum values with clearer labels: DRAFT = Draft/Scheduled; OPEN = Booking open; BOOKING_CLOSED = Booking closed; BOARDING = Boarding; DEPARTED = In transit; COMPLETED = Completed; CANCELLED = Cancelled. A new SCHEDULED enum is unnecessary unless automatic future publication becomes a real requirement.

Keep DEPARTED. Removing it would collapse departure and arrival into one event and weaken no-show decisions.

| State | Normal permitted actions | Explicitly unavailable |
| --- | --- | --- |
| DRAFT | Edit direction/date/vehicle/fare; inspect map; assign staff; validate/publish; cancel draft | Online sales, boarding, refund initiation against nonexistent receipts |
| OPEN | Sell within booking window; inspect holds; block eligible seats with reason; close booking; pre-departure cancellation with impact preview | Starting a different route under sold tickets; silent vehicle/seat renumbering |
| BOOKING_CLOSED | Read manifest; manage operational exceptions; assign staff; start boarding; pre-departure cancellation | Normal public sales; arbitrary reopening without reason and guard checks |
| BOARDING | Scan/manual board through existing validation; deny with reason; view outstanding passengers; mark departed after acknowledgement | Unrestricted route/seat configuration changes; casual cancellation after passengers have boarded |
| DEPARTED | Read manifest; review potential no-shows; record operational notes; mark completed on arrival | New bookings, ordinary boarding, seat blocking/reallocation, trip cancellation |
| COMPLETED | Read, report, export, feedback; audited correction process for exceptional historical records | Reopen, edit commercial trip data, new booking, ordinary cancellation, release sold seats, routine refund action |
| CANCELLED | Read history; view affected bookings and outstanding refund obligations | Reopen, sell, board, reassign seats, cancel again |

Reopening BOOKING_CLOSED -> OPEN should be an explicit, audited exception before cutoff/departure, not a generic status selector. Cancellation during BOARDING needs stronger confirmation if anyone has boarded and a service disruption procedure. After departure, handle a disruption as an incident; do not rewrite the trip as a never-operated cancellation.

I recommend hiding routine refunds on completed trips, as requested. However, a duplicate charge or unresolved refund debt must remain visible after completion. If later approved, a separately permissioned finance adjustment can correct money without reopening the trip, freeing seats, or rewriting boarding history. This iteration should not add that capability automatically.

All mutating endpoints and SQL functions must enforce the same matrix under locks, including manual bookings, publishing, trip edits, cancellation, blocking, and refund-with-cancellation. Return allowed actions plus refusal reasons for the UI; recheck them at mutation time.

Current & Upcoming defaults to the next operational departures, sorted soonest first. Overdue nonterminal trips appear in a clearly marked Needs closeout group, not silently in History. History contains COMPLETED/CANCELLED with date, direction, vehicle, and status filters. Drafts remain separately accessible. Use server pagination, displayed totals, and URL-persisted filters.

## Routes and Capacity Decisions

**Routes:** use two saved directional routes, not arbitrary origin/destination text per departure. The database already has routes and trips.route_id; the creation UI currently picks routes[0] silently. First expose a route selector and provision the reverse direction through a controlled migration/admin management flow after approval. Keep departure, vehicle, and fare.

A small Routes & Locations screen should manage canonical pickup/drop-off names, instructions, map links, estimated duration, and active status. Two locations and two directed routes are enough; no multi-stop route optimizer is needed. Published trip details must retain a snapshot or immutable route version so editing a pickup point cannot rewrite historical tickets. Route changes after sale need an impact review and passenger communication. Update student listings, checkout description, passes, receipts, poll wording, and reports together; an admin-only reverse route would leave misleading student-facing text.

**Capacity:** configure the actual coach as ten rows x four seats if that matches the physical numbering. Confirm the physical layout before remapping. Keep a per-trip seat snapshot as inventory authority; do not make historic totals depend on the vehicle's current configuration. Physical capacity, blocked seats, held seats, confirmed seats, and available-to-sell seats must be distinct figures.

Migration plan after approval: inventory every affected trip/passenger/pass -> preserve historical maps -> create/update the future 40-seat configuration -> rebuild only genuinely empty drafts or explicitly approved unsold departures -> handle any seat reassignment through a dedicated audited process. The snapshot found no currently held/booked row-11 seats, but that alone is insufficient to rebuild maps containing historical references. The existing shrink guard will reject changes while active trips have committed seats; do not defeat it or mark trips completed merely to pass it. The five-passenger-per-booking limit remains independent of vehicle capacity.

## Recommendations and Impact

Each entry includes the problem, solution, operational value, priority, and frontend/backend/database impact.

### R1. Lifecycle Enforcement and Trip Closeout

- Priority: **Critical**. Phase 1.
- Problem: terminal-state and transition gaps permit invalid operations; overdue trips remain active.
- Solution: enforce the matrix above and add explicit Mark departed / Mark completed workflows, with stale-trip warnings and audited exception handling.
- Why: prevents rewriting completed journeys, freeing historical seats, and inappropriate cancellation/refund chains.
- Frontend: state-aware actions, disabled reasons, closeout confirmation, overdue group.
- Backend: central transition/operation policy, atomic checks, publish validation shared with preview, idempotent action handling.
- Database: replace permissive status function; guard terminal operations; add actual departure/completion timestamps if absent; preserve audit history.

### R2. Correct 40-Seat Inventory

- Priority: **Critical**. Phase 1.
- Problem: the system currently sells a 44-seat layout for a 40-seat operation.
- Solution: controlled future configuration change and per-trip migration plan described above, with capacity invariants.
- Why: prevents selling physically unavailable seats and inconsistent boarding/statistics.
- Frontend: ten-row maps where applicable; clear physical/blocked/sold/available counts; configuration-lock explanation.
- Backend: validate layout against generated inventory; refuse unsafe map changes; consistent capacity contract across booking, boarding, reports.
- Database: migrate vehicle/layout data and eligible trip inventories transactionally; preserve old seats and passenger references. No blanket DELETE/rebuild.

### R3. Publishing and Vehicle Availability

- Priority: **High**. Phase 1.
- Problem: a vehicle in maintenance, a past departure, or an overlapping assignment can pass incomplete publication checks.
- Solution: one publish validator checks active route, departure, vehicle status, seat-map agreement, and overlapping travel plus turnaround time; repeat checks at commit.
- Why: stops selling a departure that cannot operate.
- Frontend: actionable validation errors; unavailable vehicles shown with reason; conflict links.
- Backend: shared preview/commit validator and concurrent publish protection. Do not claim a UI preview guarantees a later commit.
- Database: indexes and serialized vehicle scheduling checks; consider an exclusion constraint if the finalized time model supports it. Store expected arrival/turnaround consistently.

### R4. Routes and Locations

- Priority: **High**. Phase 2, before reverse-direction sales.
- Problem: creation silently selects the first route; route names also remain hardcoded in other screens.
- Solution: saved directional route selector plus compact route/location management; immutable published-route details.
- Why: supports both directions without typos or reversed pickups.
- Frontend: selector and direction in every relevant trip/booking/pass view; retain date, vehicle, fare.
- Backend: route management validation, active-route checks, authorized edits, route-aware public listing filters and descriptions.
- Database: reuse routes/trips.route_id initially; add canonical locations and snapshot/version fields only as management is introduced.

### R5. Focused Trips and a Trip Workspace

- Priority: **High**. Phase 2.
- Problem: cancelled, stale and active trips mix together; View loses trip context.
- Solution: Current & Upcoming / Drafts / History, Needs closeout group, trip workspace and deep links.
- Why: reduces wrong-departure actions and makes the next operational action obvious.
- Frontend: compact table, route column, status/date/direction/vehicle filters, search, persistent URL state, contextual details.
- Backend: paginated filtered trip listing and counts; return allowed actions.
- Database: targeted date/status/route/vehicle indexes after query-plan measurement; no new trip status required.

### R6. Passenger and Booking Visibility

- Priority: **High**. Phase 2.
- Problem: booking chips and deep tabs obscure per-passenger outcomes, especially partial settlement and group bookings.
- Solution: Bookings and Passengers table modes. Passenger row: name, seat, trip/direction, booking code, contact, booking state, payment state, refund state, boarding state. Detail drawer exposes owner versus passenger identity and the timeline.
- Why: directly answers who paid, who has a valid pass, who boarded, who cancelled, and who is owed money.
- Frontend: filters for confirmed/unpaid/payment exception/refund pending/not boarded/boarded/denied/no-show/cancelled; search name/phone/roll/booking; same-scope exports.
- Backend: paginated passenger projection joins receipts, obligations, pass validity, and boarding data without conflating the states; preserve group totals.
- Database: reuse booking_passengers, bookings, payments, refunds, boarding_passes; measured indexes. Never replicate a group booking's total as each passenger's paid amount.

### R7. Payment and Refund Truth

- Priority: **High**. Phase 1 visibility, Phase 2 workflow.
- Problem: a successful provider payment may coexist with a failed seat allocation or pending refund; dispatch-paused obligations can look completed.
- Solution: separate Payment attempts / Refunds / Exceptions tabs; show received, owed, queued, sent to provider, processed, failed, and externally paid. Display dispatch paused and last successful reconciliation.
- Why: avoids telling students money was returned when it was only queued, and avoids duplicate charges or refund actions.
- Frontend: link every exception to booking and trip; show timestamps, amount, provider references appropriate to permission, and meaningful retry/refusal states.
- Backend: expose dispatch capability/status and precise refund stages. Keep Razorpay verification and deduplication. No new automatic refunds or approval changes in this audit.
- Database: reuse refund/provider-event records; add explicit approval/dispatch ownership only if an approved manual-dispatch workflow requires it. Review queued obligations before any future dispatch enablement.

### R8. Report Permissions and CSV Safety

- Priority: **High**. Phase 1.
- Problem: financial report access relies on generic permissions despite narrower UI promises. CSV escaping quotes delimiters but does not neutralize spreadsheet formulas from user-provided names/comments.
- Solution: enforce report-kind permissions in domain and HTTP/export paths; neutralize formula-leading untrusted cells and use consistent export scoping.
- Why: aligns actual access with roles and prevents spreadsheet execution when an operator opens exported data.
- Frontend: capabilities determine visible report types; clear data-scope/export preview.
- Backend: shared report authorization matrix, safe CSV encoder, export audit including filters/counts; denied-role tests.
- Database: permission rows only if new granular permission names are needed; existing data tables suffice.

### R9. Completeness and Responsive Loading

- Priority: **High**. Phase 2.
- Problem: some views fetch everything and others silently truncate; five-second refresh performs many reads, and silent failures leave stale data appearing live.
- Solution: server cursor pagination with total/filter counts, preserve all history, fetch only the active section and relevant trip data, expose last-updated/stale/offline states, cancel superseded searches and prevent stale responses replacing newer selections.
- Why: delivers completeness without slowing every click or hiding outages.
- Frontend: explicit loading/empty/error distinctions, retry, pending mutation feedback, duplicate-click prevention, stable selection and scroll on refresh.
- Backend: bounded queries and filters; request timing/error identifiers; query-plan-guided indexes. Keep correct existing polling before considering SSE.
- Database: indexes based on measured filters; no general cache of mutable booking/payment truth.

### R10. Overview and Actionable Exceptions

- Priority: **High**. Phase 2.
- Problem: Today uses a rolling -6/+18-hour window, the activity feed can render 500 historical events, and Review links lose the affected record.
- Solution: explicit IST calendar-day operational metrics, separate upcoming and overdue blocks, short recent activity with View all, exception links to exact booking/trip and outstanding action.
- Why: prevents confusing yesterday's trip with today's operation and reduces time to resolve payment/boarding issues.
- Frontend: compact work-focused summary, date scope, counts with drill-down, distinguish refund owed from refunded cash.
- Backend: one documented metric definition and time scope; alerts carry entity IDs and durable resolution state where appropriate.
- Database: reuse views; adjust reporting definitions and introduce a small exception record only for issues requiring assignment/resolution beyond existing statuses.

### R11. Boarding Refinements Only

- Priority: **Medium**, with lifecycle dependency in Phase 1; UI in Phase 2.
- Problem: header can briefly show no trip while a selector shows one; stale departures remain selectable; financial/pass exceptions are not a clean queue.
- Solution: retain scanner/validation chain and search. Show trip direction/status, selected-trip loading state, boarded/expected/not-boarded progress, exception filter, and departure closeout.
- Why: helps staff make the correct gate decision without redesigning a working workflow.
- Frontend: keep scan action stable, explicit loading versus zero passengers, last refresh, large result, contextual manual-board/deny reason prompt.
- Backend: retain assignment scope and the same server verification for scanned/manual boarding; allow only lifecycle-valid actions.
- Database: preserve boarding events and passes; actual trip timestamps from R1. No offline auto-approval and no mass Board all shortcut.

### R12. Keep the Waitlist, Clarify Its Limits

- Priority: **Medium**. Phase 3.
- Problem: "Wishlist" is actually a FIFO seat waitlist. Offers reserve one seat for 30 minutes; claim creates a normal hold. seats_wanted exists but allocation takes one seat. No email delivery path for offers was found, and joins check OPEN but do not establish sold-out eligibility.
- Solution: call it Waitlist; keep it in the trip workspace and Demand. Show waiting/offered/claimed/expired/cancelled, offer expiry and contact status; define single-seat semantics first; send reliable offer notifications and prevent offers for ineligible trip states.
- Why: useful for genuine sold-out demand, but it must not promise an unimplemented multi-seat allocation or an unseen notification.
- Frontend: trip context, queue/offer status, reasoned reorder, student claim link; explain offer time separately from checkout hold time.
- Backend: consistent eligibility checks, expire/advance correctly, idempotent delivery retries; no allocation-policy rewrite until group semantics are approved.
- Database: reuse waitlist_entries and seat reservation constraints; add delivery/outbox records if needed.

### R13. Requests and Notification Delivery

- Priority: **High** for hidden payment exceptions; **Medium** for delivery. Phase 2/3.
- Problem: Requests combines notify interest, ID changes, account deletion, and payment exceptions encoded as GET_NOTIFIED. UI hides the exception reason behind an email-style detail. GET_NOTIFIED has no working mark-notified UI; generic approve does not deliver a message or set NOTIFIED.
- Solution: distinguish Interest, Account requests, and Payment exceptions. Account approval/rejection remains reasoned/audited. Notify workflows track intended message, delivery result and retry, not an ambiguous Approve.
- Why: prevents financial follow-up being mistaken for marketing interest and makes request completion truthful.
- Frontend: kind/status filters, request reason, linked record, pending/resolved history, consequence preview for deletion.
- Backend: correctly typed exception creation, explicit notify/delivery actions; use existing HTTPS email abstraction after authorization. Review deletion behavior before claiming complete anonymization: passenger and request records intentionally retain data.
- Database: typed request linkage/category and delivery history or outbox; migrate mixed existing records without dropping reasons; preserve retention/audit records.

### R14. Student Data Quality

- Priority: **Medium**, later as requested. Phase 3.
- Problem: roll numbers are self-entered and may be wrong; registered owner and group passengers are different people; directory currently lists active student accounts only.
- Solution: normalize formats with university-approved rules, show unverified/verified status, support audited correction and optionally a verified university roster import later. Do not guess one regex that rejects valid cohorts.
- Why: improves boarding identity confidence without adding immediate signup friction.
- Frontend: search, student detail with account state/verification and linked bookings; distinguish passenger-entered from verified profile details.
- Backend: consistent normalization, uniqueness rules, controlled verification/correction and import validation if approved.
- Database: verification metadata and optional roster identifier; retain immutable passenger snapshots instead of overwriting old manifests from a profile change.

### R15. Complete Feedback Flow

- Priority: **Medium**. Phase 3, after lifecycle closeout.
- Problem: reviews table and admin moderation exist, but no student submission endpoint exists; dashboard deliberately omits ratings. Zero reviews in production is consistent with that missing path.
- Solution: completed eligible booking -> rate/comment -> validated submission -> admin inbox -> resolved/hidden as separate concepts. Start as internal operational feedback, not a public-review platform.
- Why: creates a real feedback loop with minimal product expansion.
- Frontend: completed-trip form, submitted state, admin rating/trip filters and resolution note.
- Backend: authenticated booking ownership and actual travel eligibility; rating/comment limits; duplicate-safe submission; auditable moderation.
- Database: reuse reviews and UNIQUE(booking_id). Current copy says one per trip, but schema says one per booking: recommend one per eligible booking initially, and align copy. Add resolution note only if required.

### R16. Reports and Auditable Search

- Priority: **Medium**. Phase 2 foundations, Phase 3 additions.
- Problem: date/status semantics differ between reports; Audit cursor/filter capabilities are not surfaced; activity shows time without sufficient date context.
- Solution: consistent IST date boundaries, direction/trip/status scope, filtered preview matching export, documented gross/refund-owed/refund-processed/net figures, cursor audit browsing and entity links.
- Why: makes operations totals explainable and prevents exporting the wrong trip or silently incomplete history.
- Frontend: stable filters, timezone/date labels, totals, paginated audit, before/after details and links; no delete-audit action.
- Backend: consistent filter contracts, granular permissions from R8, cursor handling, audit export scope if added.
- Database: reuse audit and report views; change definitions only with reconciliation checks against existing receipts and passenger statuses.

### R17. Fleet and Staff Operations

- Priority: **Medium**, except publish safety in Phase 1. Phase 2/3.
- Problem: vehicle edits/maintenance and staff assignments are separate from trip impact. Assignment changes revoke staff sessions, which can surprise an active scanner.
- Solution: show affected upcoming departures before vehicle unavailability/configuration changes; assignment overview within trips; clear reauthentication message after scope changes. Add registration/maintenance notes only if operations uses them.
- Why: prevents a bus or scanner becoming unavailable without an operator seeing the impact.
- Frontend: compact management tables, impact preview, configuration lock reasons, assignment status and current trip scope.
- Backend: lifecycle-aware assignment, active-account checks, overlap policy, maintain current server authorization and revocation behavior.
- Database: reuse vehicles/trip_staff; optional maintenance note/due date later. No driver telematics or complex fleet ERP.

### R18. High-Risk Action Usability and Access

- Priority: **High** for action correctness; **Medium** for stronger sign-in. Phase 1/3.
- Problem: generic action buttons and long forms obscure consequences; broad/shared admin identities weaken accountability; no MFA implementation was found in inspected auth code.
- Solution: explicit trip/booking/amount/seat impact confirmations, reason fields, retry-safe actions, individual staff accounts and later step-up verification for financial/access changes. Keep boarding staff restricted to assigned trips.
- Why: reduces accidental operations while preserving usable routine workflows.
- Frontend: consistent dialog, keyboard focus/escape, inline error, loading and duplicate-click prevention; responsive tables with a usable mobile alternative.
- Backend: backend-enforced capabilities, idempotency where missing, strong session checks, step-up only in a separately approved auth change.
- Database: audit action/correlation IDs as needed; second-factor enrollment data only if that phase is approved. Do not build a free-form permission editor now.

### R19. Demand Poll Refinement

- Priority: **Low** until reverse routes launch, then **Medium**. Phase 3.
- Problem: one undated Woxsen-to-Miyapur poll blends demand across travel dates and directions; anonymous votes are interest rather than guaranteed passengers.
- Solution: lightweight poll campaign with direction and intended travel date/window; retain low-friction voting and optional contact fields.
- Why: provides usable scheduling evidence without treating unverified votes as reservations.
- Frontend: direction/date context, separate respondent count from selections, campaign filters in admin.
- Backend: campaign-scoped vote updates/deduplication and abuse controls; preserve existing vote history and exports.
- Database: campaign ID and route/date context; no automatic trip publication based on votes.

### R20. Compact Navigation and Consistent Page Layout

- Priority: **Medium**. Phase 2.
- Problem: in the inspected narrow browser view, wrapped navigation and account/sign-out content occupy roughly the first 360 pixels before Trips begins. Long explanatory paragraphs compete with operational controls, and expanded forms push the list farther down.
- Solution: retain the existing identity, but use a compact top bar and accessible navigation drawer on narrow screens, a stable sidebar on wide screens, a consistent page toolbar, and clearly framed creation/detail dialogs or panels. Put account actions in an account menu. Replace prominent implementation explanations with concise status and contextual help.
- Why: lets an operator reach trip selection, filters, and actions immediately and reduces scrolling at the bus door.
- Frontend: responsive navigation, active-page indication, accessible dialog focus/escape, clearly labeled route/date/status columns, stable table headers and action widths, horizontally scrollable tables or compact row layouts where appropriate. Only show bulk actions with a clear operational benefit, such as exporting the selected scope; no bulk refund/cancel/board controls in this iteration.
- Backend: no new business API required; consume existing or approved capability/filter contracts.
- Database: none.

## Phased Approval Plan

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| 1: Correctness before new sales | R1-R3, R7 truthfulness, R8, action safeguards in R18 | Every state/action pair tested; completed/cancelled trips immutable to routine actions; controlled 40-seat migration validated; past trips reviewed without invented departure facts; vehicle conflicts refused; paused refund obligations labeled accurately; role/export tests pass |
| 2: Daily operations | R4-R6, R9-R11, R20, exception separation in R13, report/audit foundations | Both directions display consistently end to end; current/history separation retains all records; trip context survives navigation; passenger/payment/boarding status agrees with backend; filters and exports match; live failures visible; authenticated browser checks on desktop/mobile |
| 3: Complete support workflows | R12-R19 remaining items | Waitlist offers have real delivery/expiry semantics; feedback submission persists and reaches admin; requests resolve truthfully; student corrections audited; fleet/staff impact clear; optional MFA and poll campaign decisions approved separately |

Implement each phase in reviewable changes. Use an isolated database branch or disposable test database for migrations, invalid transitions, concurrency, and destructive workflows; never seed fake passengers into production. Preserve production architecture, existing Razorpay LIVE verification, secret handling, receipt caps, pass checks, and append-only auditing. Use mocked provider responses for automated tests; do not switch production to Razorpay TEST.

Minimum regression matrix: all trip transitions and forbidden operations; 40-seat generation and unavailable row-11 seats on new maps; existing ticket/map preservation; vehicle overlap concurrency; publication vs stale validation; group/partial settlement passenger counts; manual/online booking rules; refund obligation versus dispatch state; read/export permissions; complete pagination; stale response handling; per-trip report totals; waitlist expiry; feedback ownership/deduplication; request decision audit.

## Approval Decisions

Approve the phased roadmap before any implementation. Recommended defaults: saved directional routes; retain DEPARTED; physical 40-seat layout confirmed before migration; no routine completed-trip refunds or reopening; preserve and surface existing refund obligations while dispatch remains disabled; keep waitlist as single-seat offers initially; feedback per completed eligible booking; student identity enhancements later.

One product clarification is required before the capacity migration: confirm that the physical coach is exactly ten A-D rows with the existing numbering. No additional feature should be added solely because it appears in this audit; each phase remains independently reviewable.
