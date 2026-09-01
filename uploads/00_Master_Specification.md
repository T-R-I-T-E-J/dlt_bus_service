# DLT — Master Product, Design & Technical Specification

> **AMENDMENT — 1 September 2026 · Payment provider changed to Razorpay**
>
> This document originally specified **Cashfree** as the payment provider. The
> provider is now **Razorpay**. This was a deliberate product decision, approved
> before implementation, and is recorded here rather than applied silently so the
> change is auditable.
>
> **What changed:** the payment provider only.
> **What did NOT change:** every payment business rule. Server-side confirmation
> remains the sole source of payment truth; browser-reported success is still
> never sufficient; amounts are still computed server-side from the frozen fare;
> refunds are still capped by money actually received; complimentary and
> externally-paid bookings must still never be represented as provider payments.
>
> Provider-specific details that differ from the original Cashfree text:
> amounts are transmitted in **paise** (Razorpay's smallest currency unit);
> webhook signatures are **hex HMAC-SHA256 over the raw request body** with no
> timestamp component, so replay protection rests on the unique
> `x-razorpay-event-id`; refunds are created against the **payment** id and
> settle asynchronously via `refund.processed`.
>
> Implementation and its verification status: `backend/ARCHITECTURE.md`,
> `backend/PAYMENTS_MIGRATION.md`, `PRODUCTION_BACKEND.md`.


**Version:** 1.0  
**Status:** Initial master specification  
**Launch route:** Woxsen University → Miyapur  
**Launch fare:** ₹259 per seat  
**Primary language:** English  
**Primary users:** Students  
**Payment provider:** Razorpay

---

## 1. Document Purpose

This document is the single source of truth for the DLT student shuttle platform and website.

It combines:
- Product requirements
- Student UX/UI requirements
- 3D homepage experience
- Booking and seat selection
- Razorpay payment lifecycle
- Boarding pass and QR verification
- Admin/operations
- Trips, vehicles and seats
- Notifications and support
- Security and privacy
- Data and backend requirements
- Edge cases
- Reporting and audit
- Testing/acceptance requirements
- Future-ready architecture

### Requirement classification

- **FINALIZED:** Explicitly decided during requirements discovery.
- **TBD:** Intentionally left open.
- **RECOMMENDED:** Proposed design/technical direction that should be reviewed before implementation.
- **FUTURE:** Not part of launch, but architecture should not prevent it.

---

# 2. Product Overview

DLT is a student shuttle/transportation service.

The initial product is intentionally focused on one route:

> **Woxsen University → Miyapur**

The platform must support multiple vehicles and dynamically created trips even though only one route is exposed at launch.

The core student journey is:

> **Discover → Choose Trip → Choose Seat → Enter Passenger Details → Review → Pay → Receive Boarding Pass → Board → Rate Trip**

The brand experience should feel:
- Student-first
- Modern
- Premium
- Reliable
- Visually distinctive
- Operationally practical

---

# 3. Launch Scope

## 3.1 Included at launch

- Student website
- Student accounts
- Trip browsing
- Dynamic trip cards
- Dynamic vehicle/seat configuration
- 2+2 seat layout
- Window/Aisle seat types
- Up to 5 passengers per booking
- Passenger details
- Razorpay payment
- Payment reconciliation
- Booking confirmation
- Individual boarding passes
- Secure QR codes
- QR scanner
- Boarding management
- Admin dashboard
- Trip management
- Vehicle management
- Booking management
- Refund/cancellation workflows
- Waitlist
- Reports
- Audit logs
- Help/FAQ
- WhatsApp/manual support
- Student ratings and feedback

## 3.2 Not required for initial launch

- Automatic Woxsen student database verification
- Automated WhatsApp delivery
- Automated email delivery
- SMS
- Full driver document/profile management
- Multi-language UI
- Mandatory 2FA
- GST invoice system
- Referral UI
- Coupon UI
- Global website search
- Additional routes exposed publicly

---

# 4. Brand & Website Experience

## 4.1 Homepage concept

The homepage is not a conventional static transport landing page.

The central visual concept is a continuous 3D journey.

### Core narrative

> **Woxsen → Journey → Miyapur → Book**

The bus is already travelling on the road when the experience begins.

The road is the continuous visual backbone.

### Journey sequence

1. White/light daytime atmosphere.
2. Large 3D bus is already on a road.
3. User scrolls.
4. Camera gradually pulls back.
5. Bus continues moving on the road.
6. Woxsen becomes the first major stop.
7. Bus slows/stops at the Woxsen moment.
8. A branded information card appears.
9. User continues scrolling.
10. Bus resumes movement.
11. Road continues and curves.
12. Environment can evolve between Woxsen and Miyapur.
13. Miyapur becomes the destination hero.
14. Bus slows/stops at Miyapur.
15. Destination card appears.
16. Road continues into the upcoming-trip section.
17. Trip cards emerge from the 3D environment.
18. Cards transform into normal interactive UI.
19. Booking becomes the primary focus.

## 4.2 Scroll behavior

Scroll controls the journey.

- Forward scroll advances the bus.
- Reverse scroll reverses the journey.
- No autonomous bus movement independent of scroll.
- At meaningful stops the bus can remain stationary while the relevant content is visible.
- The user effectively controls the journey through scrolling.

## 4.3 Camera

Primary behavior:
- Follow/chase perspective.
- Occasional side/front/aerial cinematic movements.
- More cinematic treatment around Woxsen and Miyapur.
- Camera movement remains tied to scroll.
- Camera must preserve route comprehension.

## 4.4 Road/environment

Confirmed direction:
- Realistic environmental details
- Stylized/premium road
- Clean visual language
- Woxsen and Miyapur should feel like meaningful endpoints

Environment detail/progression is **TBD**.

## 4.5 3D performance

Visual ambition and performance are both priorities.

Requirements:
- Optimize 3D model
- Optimize textures and lighting
- Lazy-load heavy assets where possible
- Provide lightweight fallback
- 3D failure must not prevent booking
- Reduced-motion experience
- Mobile strategy remains TBD
- Desktop should prioritize the intended cinematic experience

## 4.6 Accessibility

Required:
- Keyboard navigation
- Proper labels
- Contrast
- Focus states
- Screen-reader-friendly booking flow
- Reduced-motion mode
- Ability to pause/skip major 3D journey
- Core booking cannot depend on animation

---

# 5. Public Website

## 5.1 Pages

Public pages:
- Home
- Book
- How It Works
- Route
- Why DLT
- About
- Help / FAQ
- Contact
- Terms & Conditions
- Privacy Policy
- Cancellation & Refund Policy
- Boarding / Travel Rules
- Payment information
- Student eligibility

Student pages:
- Sign In
- Sign Up
- Dashboard
- My Trips
- Boarding Passes
- Profile

Admin is a separate application/interface.

## 5.2 Navigation

Recommended public navigation:
- DLT logo
- Routes
- How It Works
- Why DLT
- Help
- Book a Seat
- Sign In
- Sign Up

Authenticated experience:
- Dashboard
- My Trips
- Account/Profile

## 5.3 Why DLT

Three core pillars:
1. Convenience
2. Safety & reliability
3. Student experience

## 5.4 About DLT

Focus on:
- Student transportation problem
- Why existing options are not ideal
- DLT solution
- Student-first vision

## 5.5 How It Works

Five steps:
1. Find Your Trip
2. Select Your Seat
3. Enter Passenger Details
4. Pay Securely
5. Board

---

# 6. Route Experience

Initial route:

> **Woxsen University → Miyapur**

Route information:
- Pickup location
- Destination
- Custom DLT route visual
- Approximate distance
- Approximate journey duration
- Reporting time
- Departure time
- External map link

Do not promise an exact arrival time.

Show approximate duration instead.

---

# 7. Authentication

## 7.1 Student authentication

Required:
- Email
- Password
- Email verification
- Password reset
- CAPTCHA/rate limiting
- Secure password storage
- Session management

No mandatory 2FA for launch.

## 7.2 Booking access

Students may browse without signing in.

They may begin the booking flow without signing in.

Authentication is required before payment.

---

# 8. Student Profile

Profile can contain:
- Name
- Email
- Phone
- Student ID
- University
- Profile photo
- Emergency contact
- Account status
- Account creation information
- Booking history

## 8.1 Editing

Normal information:
- Student can edit.

Identity information:
- Protected.
- Student ID changes require Admin review/approval.

## 8.2 Emergency contact

- Stored in profile.
- Controlled access.
- Not exposed to Boarding Staff by default.
- Sensitive access is auditable.

## 8.3 Account deletion

Deletion request:
1. Admin reviews.
2. Account is deactivated.
3. Personal information is anonymized/deleted where legally possible.
4. Required financial/booking/audit records remain.
5. Action is audit logged.

---

# 9. Student Dashboard

Dashboard should feel like a travel dashboard.

Primary content:
- Upcoming trip
- Boarding pass/QR access
- Quick actions
- Recent trips
- Relevant payment/booking status

Quick actions:
- Book a Seat
- My Trips
- Boarding Pass
- Help

---

# 10. Trip Discovery

Homepage displays the next **3 upcoming eligible trips**.

If fewer than 3 exist, show available trips.

Trip cards include:
- Route
- Departure
- Reporting time
- Price
- Availability
- CTA

Availability presentation can be decided by final visual design.

## 10.1 Full trip

A full trip remains visible:

> SOLD OUT

with:

> Join Waitlist

## 10.2 No trips

Show:
> No trips available right now.

Provide:
- Get Notified
- WhatsApp/help contact

## 10.3 Admin control

Trip listings are live from Admin data, with Admin visibility control.

---

# 11. Trip Model

A trip contains:
- Route
- Date
- Departure time
- Reporting time
- Vehicle
- Price
- Booking open time
- Booking close time
- Pickup point
- Cancellation policy
- Optional trip notes
- Optional driver assignment
- Seat capacity derived from vehicle

## 11.1 Trip lifecycle

Primary lifecycle:

> Draft → Open → Booking Closed → Boarding → Departed → Completed

Exception:
> Cancelled

Additional operational statuses may include:
- Full
- Almost Full
- Payment/booking processing states are separate from trip status

## 11.2 Trip creation

Admin creates a Draft.

Admin reviews:
- Date/time
- Reporting time
- Vehicle
- Seat capacity
- Price
- Pickup
- Booking window
- Cancellation policy
- Driver if assigned
- Notes

Then explicitly:

> Publish/Open

## 11.3 Draft validation

Before publishing:
- Required fields validated
- Vehicle availability checked
- Driver conflicts checked
- Seat configuration checked
- Booking times validated
- Price validated
- Cancellation settings validated

---

# 12. Booking Flow

Primary flow:

> Choose Trip → Choose Seat → Passenger Details → Review → Payment → Confirmation → Boarding Pass

Booking layout:
- Hybrid experience
- Main interactive content
- Persistent booking summary

## 12.1 Booking summary

Persistent summary should show:
- Route
- Date/time
- Selected seats
- Passenger count
- Fare
- Total
- Important policy information

## 12.2 Booking review

Before payment, student can edit:
- Seats
- Passenger details
- Booking contact
- Other editable booking information

Trip itself is not changed on the review screen.

Before payment the system revalidates:
- Seat availability
- Passenger information
- Price
- Booking deadline
- Payment amount

---

# 13. Seat Selection

Vehicle layout:
- Standard 2+2
- Dynamic number of rows
- Multiple vehicles
- Window/Aisle classification

Example:

```text
Window Aisle | Aisle Window
   ○     ○   |   ○     ○
   ○     ○   |   ○     ○
```

## 13.1 Seat states

Recommended state model:
- AVAILABLE
- HELD
- PAYMENT_PENDING
- BOOKED
- RESERVED/BLOCKED
- CANCELLED/RELEASED

UI states:
- Available
- Selected
- Booked
- Held
- Reserved

## 13.2 Seat hold

Default:
> **10 minutes**

Requirements:
- Backend authoritative
- Atomic acquisition
- Concurrency protection
- One active allocation per trip/seat
- Expired holds release seats
- Payment-aware state

## 13.3 Seat selection UI

Hybrid:
- Clean 2D interactive layout
- Subtle 3D visual styling

Selected seat:
- Highlight on map
- Separate selected-seat summary
- Seat number
- Window/Aisle
- Price

Maximum:
> **5 seats per booking**

## 13.4 Seat blocking

Admin can reserve/block individual seats.

Requires:
- Reason
- Audit log

---

# 14. Passenger Details

Maximum:
> **5 passengers**

Required for every passenger:
- Full Name
- Student ID
- Phone Number
- Assigned seat

No passenger email or emergency contact required in booking form.

## 14.1 Passenger form

Use accordion/hybrid:
- Passenger 1 expanded by default
- Additional passengers collapsed
- Each card shows passenger + seat + completion state

## 14.2 Validation

- Inline validation while entering
- Full validation before Review
- Backend validation is authoritative

Student ID:
- Format validation only at launch

Phone:
- Indian mobile-number format validation
- No passenger OTP

## 14.3 Booking owner contact

- Pre-filled from account
- Editable during checkout
- If changed, change applies only to that booking
- Account profile is unchanged

---

# 15. Multi-Passenger Bookings

One booking may contain up to 5 passengers.

Each passenger has:
- Name
- Student ID
- Phone
- Seat
- Individual boarding pass
- Individual secure QR

One payment covers the booking.

## 15.1 Access

Booking owner:
- Full booking
- All passengers
- All passes
- Payment information

Other passengers:
- Only their own passenger information/pass

Account matching/linking is not required in V1.

Booking-pass sharing behavior is TBD.

---

# 16. Booking Ownership

Booking owner may be changed only through Admin approval.

New owner:
- Must be an existing passenger
- Must have valid DLT account
- Must have valid/eligible Student ID

If booking owner cancels only their own seat:
- Another passenger must become owner.
- Remaining booking continues.
- Access transfers.
- Payment history remains attached to original booking.

---

# 17. Cancellation & Refund

Initial student policy:

> **12+ hours before departure → Full refund**

> **Less than 12 hours → No refund**

No booking transfers.

## 17.1 Student cancellation

Student can:
- Cancel entire booking
- Cancel selected passengers/seats

Partial cancellation:
- Calculates exact applicable refund
- Recalculates applicable fees/taxes if introduced
- Shows exact refund before confirmation
- Releases cancelled seats

## 17.2 Admin cancellation

Admin cancellation:
- Calculates applicable refund
- Shows amount before confirmation
- Requires cancellation reason

Super Admin can override policy:
- Reason mandatory
- Audit log mandatory

## 17.3 Trip cancellation

If DLT cancels a trip:
1. Trip becomes CANCELLED.
2. All affected bookings identified.
3. Students identified/notified.
4. Full refunds automatically initiated.
5. Failed/pending refunds go to Super Admin reconciliation.
6. Boarding QR becomes invalid.
7. Audit trail retained.

Launch notification:
- Affected passenger list
- Ready-to-send WhatsApp template
- Admin manually sends
- Admin marks notified

---

# 18. Waitlist

When a trip is full:
- Student can join waitlist.

## 18.1 Claim window

Default:
> **30 minutes**

When a seat becomes available:
1. Eligible waitlisted student receives opportunity.
2. 30-minute claim window starts.
3. Student must complete normal booking/payment.
4. If expired, move to next eligible student.

## 18.2 Priority

Waitlist priority is **Admin-configurable**.

Admin may manually reorder.

Manual reorder:
- Reason required
- Audit logged
- Original join time preserved

---

# 19. Payment — Razorpay

Currency:
> **INR only**

Razorpay is the payment provider.

## 19.1 Critical rule

Browser-side success is **not** payment truth.

Payment truth comes from:
- Razorpay server-side confirmation
- Razorpay webhook
- Backend verification/reconciliation

## 19.2 Payment flow

```text
Student
  ↓
Review booking
  ↓
Create/validate payment
  ↓
Razorpay
  ↓
Razorpay confirmation/webhook
  ↓
DLT backend verification
  ↓
BOOKED
  ↓
Boarding pass + secure QR
```

## 19.3 Payment states

At minimum:
- INITIATED
- PENDING
- SUCCESS
- FAILED
- EXPIRED
- DUPLICATE
- DISCREPANCY
- REFUND_PENDING
- REFUNDED
- REFUND_FAILED

## 19.4 Payment pending

Show:

> **Payment Pending**
>
> Your payment is being verified. Please don't make another payment.

Automatically reconcile.

If successful:
- Booking confirmed
- Pass generated
- QR generated
- Appears in My Trips

## 19.5 Browser failure

If payment succeeds but browser closes:
- Webhook/reconciliation completes booking.
- Student does not pay again.
- Booking appears in My Trips.
- Boarding pass/QR generated after final booking.

## 19.6 Payment retry

If payment fails:
- Retry if 10-minute seat hold remains.
- If hold expires, release seats.
- Student returns to seat selection.

## 19.7 Duplicate payments

System should prevent duplicates where possible.

If multiple successful payments occur:
- Only one can confirm booking.
- Extra payments flagged as duplicate.
- No extra seat allocation.
- Refund/reconciliation workflow triggered.
- Admin alerted.

## 19.8 Payment amount mismatch

If expected amount differs from received:
- Do not confirm booking.
- Flag discrepancy.
- Preserve payment.
- Super Admin resolves.
- Student should not pay again until resolved.

## 19.9 Payment success but booking creation fails

State:
> **Payment Received / Booking Processing**

- Payment remains SUCCESS.
- System retries booking finalization.
- Student is told not to pay again.
- QR/pass generated only after booking finalization.
- Unresolved cases go to Admin reconciliation.

## 19.10 Payment records

Payment records are never deleted.

They remain for:
- Reconciliation
- Refunds
- Support
- Reporting
- Audit

---

# 20. Checkout Pricing

Initial:
> ₹259 per seat

Checkout is itemized:

> 2 seats × ₹259 = ₹518  
> Total payable = ₹518

Architecture should support future:
- Taxes
- Convenience fees
- Discounts
- Coupons

If price changes before payment:
- Student sees price changed message.
- New total must be explicitly confirmed.
- Latest validated amount is charged.

After successful payment:
- Paid price is protected.
- Price cannot silently increase.

---

# 21. Payment Receipt

V1 provides a basic receipt:
- Booking ID
- Amount
- Payment date/time
- Payment status
- Razorpay reference where appropriate

No full GST invoice system in V1.

---

# 22. Boarding Pass

After successful payment:

> Payment successful → Success animation → Booking summary → View Boarding Pass

Booking confirmation shows:
- Compact passenger list
- Seats
- Booking ID
- Boarding code
- Pass access

## 22.1 Boarding pass access

Available from:
- Confirmation
- My Trips
- Profile/account
- Downloadable PDF
- Downloadable image

## 22.2 Pass data

- Passenger
- Student ID
- Booking ID
- Boarding code
- Route
- Date/time
- Reporting time
- Pickup
- Vehicle/trip
- Seat
- Payment status
- Secure QR

---

# 23. QR System

Use secure token-based QR.

QR contains a non-readable unique token/reference.

It must not expose personal information directly.

## 23.1 Scanner validation

Backend validates:
- Booking exists
- Payment successful
- Passenger valid
- Trip correct
- Seat correct
- Booking not cancelled/refunded
- Passenger not already boarded

## 23.2 QR reuse

Historical QR remains viewable.

Boarding reuse is prohibited.

Second scan:
> ALREADY BOARDED

QR is invalid for:
- Different trip
- Cancelled booking
- Refunded booking
- Completed journey

---

# 24. QR Scanner

Roles:
- Super Admin
- Operations Admin
- Boarding Staff

## 24.1 Trip restriction

- Boarding Staff: assigned/current trip
- Operations Admin: operational access
- Super Admin: any trip

## 24.2 Scanner result

Large result:
- VALID
- INVALID
- ALREADY BOARDED

Details:
- Passenger
- Seat
- Trip
- Booking status
- Boarding status
- Timestamp when applicable

## 24.3 Manual boarding

Only:
- Operations Admin
- Super Admin

Manual boarding:
- Reason required
- Audit logged

---

# 25. Boarding Manifest

Boarding Staff see:
- Passenger name
- Student ID
- Phone where operationally necessary
- Seat
- Seat type
- Boarding status
- Search/filter
- Live boarding updates
- Seat map

## 25.1 No-show

After departure:
- System identifies confirmed but unboarded passengers.
- Status becomes Potential No-Show.
- Admin confirms final NO-SHOW.
- No automatic refund.

## 25.2 Denied boarding

Dedicated status:
> DENIED_BOARDING

Requires:
- Reason
- Admin action
- Audit log

Distinct from:
- CANCELLED
- NO_SHOW
- REFUNDED
- BOARDED

Refund is not automatically assumed.

---

# 26. Vehicles

Multiple vehicles supported.

Each vehicle:
- Vehicle name/number
- Registration number
- Seat configuration
- Capacity
- Status

Status:
- Available
- Maintenance
- Inactive

Maintenance/Inactive vehicles cannot be assigned.

Driver profile/document system is not required for initial launch.

## 26.1 Seat configuration

Standard:
> 2 + 2

Dynamic number of rows.

Seat type:
- Automatically generated
- Admin can override

## 26.2 Vehicle assignment

Same vehicle may serve multiple trips on same day.

System prevents:
- Overlapping assignments
- Invalid vehicle status
- Impossible conflicts

Driver conflict prevention is also required if driver assignment is used.

Super Admin can override a driver conflict with reason/audit log.

---

# 27. Vehicle Changes After Booking

If vehicle changes:
- Preserve seat when compatible.
- If incompatible, trigger remapping.

## 27.1 Remapping

System:
1. Identifies affected passenger.
2. Proposes closest compatible seat.
3. Prefer same Window/Aisle type.
4. Student may choose another available seat when timing permits.
5. Admin can intervene.
6. Change is audit logged.

If very close to departure:
- Automatic remapping
- Notify student
- Admin can override

---

# 28. Trip Changes After Booking

Classify changes as minor/major.

Minor:
- Can update normally.

Major:
- Departure time
- Reporting time
- Pickup point
- Vehicle
- Other materially important changes

For major changes:
1. Identify affected bookings.
2. Notify affected students.
3. Update booking/pass.
4. Surface applicable refund options.
5. Audit log.

Predefined major changes can trigger full refund even inside 12 hours.

---

# 29. Trip Status Automation

Departure:
- System automatically transitions toward DEPARTED based on scheduled time.
- Admin can correct.
- Correction is audit logged.

Completion:
- System uses expected journey timeline to propose/transition.
- Admin confirms/corrects.
- Exact arrival is not guaranteed.

---

# 30. Student My Trips

Filters:
- Upcoming
- Completed
- Cancelled
- Refunded

Completed trip includes:
- Completed status
- Trip summary
- Historical boarding pass
- Boarding details
- Rate Your Trip

---

# 31. Ratings & Feedback

After trip completion + expected journey window:
- Rating becomes available.

Student can submit:
- 1–5 stars
- Written feedback

One rating per completed trip.

## 31.1 Admin visibility

Visible to:
- Super Admin
- Operations Admin

Admin can:
- View
- Hide inappropriate feedback
- Respond
- Mark resolved

## 31.2 Public reviews

Future/public display:
- Aggregate rating
- Admin-approved reviews

---

# 32. Notifications

Launch:
- WhatsApp manual
- Email automation future
- SMS future
- In-app automation future

## 32.1 Get Notified

When no trips:
> No trips available right now.
> Get notified when bookings open.

If signed in:
- Use account contact details.

If not:
- Ask for contact details.

Preference:
- Student can choose
- WhatsApp initial/default
- Email available where implemented

## 32.2 Admin notification requests

Admin sees:
- Student
- Contact preference
- Route/trip context
- Request time
- Notified status

Filters and mark-as-notified.

---

# 33. Help & Support

Help page:
- FAQs
- Booking help
- Payment/refund help
- Boarding instructions
- Pickup information
- WhatsApp
- Phone
- Contact details

No ticketing system in V1.

## FAQ categories

- Booking
- Payment & Refunds
- Boarding & QR
- Trips & Pickup
- Student Account
- General DLT

FAQ search only; no global website search.

---

# 34. Contact

Contact page:
- WhatsApp
- Phone
- Email/contact option when available
- Map/location where relevant
- FAQ/help links
- Contact DLT CTA

---

# 35. Legal & Policies

Required launch policy areas:
- Terms & Conditions
- Privacy Policy
- Cancellation & Refund Policy
- Boarding & Travel Rules
- Payment/Refund information
- Student Eligibility Rules
- Other legally required policies

Final legal wording must be separately reviewed.

---

# 36. Admin Roles

## Super Admin

Full access including:
- Payment reconciliation
- Refund exceptions
- Manual bookings
- Protected student information
- Manual boarding
- Audit logs
- Overrides

## Operations Admin

Operational access:
- Trips
- Bookings
- Passengers
- Boarding
- Vehicle/trip operations
- Feedback
- Relevant student information

## Boarding Staff

- Assigned trip access
- Manifest
- Seat map
- QR scanner
- Boarding verification

No financial/admin overrides.

---

# 37. Admin Dashboard

Core sections:
- Dashboard
- Trips
- Bookings
- Vehicles
- Drivers
- Students
- Payments
- Boarding/Scanner
- Reports
- Settings

Dashboard metrics:
- Today's trips
- Passengers
- Seats
- Revenue
- Boarding progress
- Alerts
- Quick actions

Notifications cover:
- Payments
- Bookings
- Trips
- Vehicles/driver issues
- Boarding
- System issues

Separate:
- Critical alerts
- Normal activity

---

# 38. Booking Detail Admin Page

Use overview + detailed tabs.

Tabs:
1. Overview
2. Passengers
3. Payment
4. Boarding
5. Activity/Audit

Overview:
- Booking ID
- Status
- Trip
- Vehicle
- Seats

Passengers:
- Name
- Student ID
- Phone
- Seat
- Boarding status

Payment:
- Amount
- Razorpay transaction
- Payment status
- Refund status

Boarding:
- QR
- Boarding time
- Scanner/staff
- No-show/denied status

Activity:
- Changes
- Cancellation
- Refund
- Audit

---

# 39. Admin Search

Search by permitted identifiers:
- Booking ID
- Name
- Phone
- Student ID
- Boarding code
- Payment reference where permitted

Role-based visibility applies.

---

# 40. Manual Bookings

Super Admin can create exceptional manual bookings.

Types:
- Complimentary
- Paid externally

Required:
- Passenger information
- Trip
- Seat
- Reason
- Manual booking type
- Admin
- Timestamp
- Audit

Manual booking uses the same:
- Booking system
- Boarding pass
- Secure QR
- Scanner

Admin sees:
- Manual booking type
- Complimentary/external payment type

External payment must never be falsely represented as Razorpay payment.

---

# 41. Seat Blocking

Admin can:
- Block/reserve individual seats
- Provide reason
- Release later

Blocked seats are not available to students.

---

# 42. Reports

Reports:
- Bookings
- Revenue
- Passengers
- Seat occupancy
- Trip manifests
- Boarding
- No-shows
- Successful payments
- Failed payments
- Refunds
- Pending refunds

Filters:
- Date
- Trip
- Vehicle where relevant
- Payment status
- Booking status

Exports:
- CSV
- Excel

## 42.1 Post-trip summary

Example:
- Route
- Date/time
- Capacity
- Booked
- Boarded
- No-show
- Revenue
- Refunded
- Vehicle
- Driver if applicable
- Boarding status
- Manifest
- Export

---

# 43. Payment Reconciliation

Super Admin only.

Shows:
- Booking ID
- Student/passenger
- Amount
- Razorpay transaction/reference
- Payment status
- Refund status
- Duplicate status
- Manual/external status
- Timestamps

Filters:
- Successful
- Failed
- Pending
- Duplicate
- Refund pending
- Refunded
- Manual/external

---

# 44. Audit Logs

Dedicated Audit Log for Super Admin.

Record:
- Actor
- Action
- Previous value
- New value
- Timestamp
- Affected entity
- Reason where required

Examples:
- Trip time changed
- Seat released
- Manual booking created
- Passenger manually boarded
- Refund override
- Booking ownership changed

Audit logs cannot be normally edited/deleted.

---

# 45. Record Deletion

Important operational records are not permanently deleted.

Use:
- Cancelled
- Archived
- Inactive
- Retired
- Deactivated
- Anonymized where appropriate

Payments, refunds, boarding history and audit history remain.

---

# 46. Data Retention

Different data types follow different retention rules.

Operational:
- Long-term history

Financial:
- Applicable accounting/financial requirements

Personal:
- Defined retention/deletion policy

Boarding/audit:
- Retained for operational/security purposes

Exact retention periods are TBD pending legal/accounting review.

---

# 47. Security & Privacy

Required principles:
- Least privilege
- Role-based access
- Server-side authorization
- Secure password storage
- Session security
- Rate limiting
- CAPTCHA/rate limiting where appropriate
- Secure QR tokens
- No personal information encoded directly in QR
- Payment verification server-side
- Audit sensitive actions
- Protect emergency contact data
- Do not expose unnecessary student data to Boarding Staff

---

# 48. Data Model — Recommended

The following is a recommended conceptual model and must be validated during engineering design.

Core entities:

### User
- id
- email
- password_hash
- role
- status
- created_at
- updated_at

### StudentProfile
- user_id
- full_name
- phone
- student_id
- university
- profile_photo
- emergency_contact
- status

### Route
- id
- origin
- destination
- active

### Vehicle
- id
- name/number
- registration_number
- status
- row_count
- capacity

### VehicleSeat
- id
- vehicle_id
- row
- side
- position
- seat_number
- seat_type

### Trip
- id
- route_id
- vehicle_id
- date
- departure_time
- reporting_time
- pickup_point
- price
- booking_open_at
- booking_close_at
- cancellation_policy
- status

### TripSeat
- id
- trip_id
- vehicle_seat_id
- status
- current_booking_id

### Booking
- id
- booking_code
- owner_user_id
- trip_id
- status
- total_amount
- booking_type
- contact_phone
- created_at
- updated_at

### BookingPassenger
- id
- booking_id
- name
- student_id
- phone
- trip_seat_id
- boarding_status

### Payment
- id
- booking_id
- provider
- provider_reference
- amount
- currency
- status
- timestamps

### Refund
- id
- booking_id/payment_id
- amount
- status
- reason
- provider_reference
- timestamps

### BoardingPass
- id
- passenger_id
- boarding_code
- qr_token
- status

### BoardingEvent
- id
- passenger_id
- trip_id
- staff_user_id
- result
- timestamp
- reason

### WaitlistEntry
- id
- trip_id
- student/user
- priority
- joined_at
- claim_expires_at
- status

### Review
- id
- trip_id
- student/user
- rating
- feedback
- status
- admin_response
- created_at

### AuditLog
- id
- actor_user_id
- action
- entity_type
- entity_id
- old_value
- new_value
- reason
- timestamp

### NotificationRequest
- id
- user/contact
- route/trip context
- channel
- status
- requested_at
- notified_at

---

# 49. Backend Principles

The backend must be authoritative for:
- Seat availability
- Booking status
- Payment status
- Refund status
- QR validity
- Boarding status
- Role permissions

Never trust:
- Browser payment success
- Browser seat availability
- Client-side price
- Client-provided booking status
- Client-provided QR validity

---

# 50. Concurrency & Idempotency

Required:
- Atomic seat allocation
- Unique constraints for active seat allocation
- Payment webhook idempotency
- Booking creation idempotency
- Refund idempotency
- Boarding scan idempotency
- Duplicate event handling

A repeated webhook must not:
- Create a second booking
- Create a second boarding pass
- Allocate another seat
- Process duplicate refund incorrectly

---

# 51. API Requirements — Recommended

Representative backend API groups:

## Authentication
- POST /auth/signup
- POST /auth/login
- POST /auth/verify-email
- POST /auth/forgot-password
- POST /auth/reset-password

## Trips
- GET /trips
- GET /trips/:id
- GET /trips/:id/seats

## Booking
- POST /bookings
- GET /bookings/:id
- PATCH /bookings/:id
- POST /bookings/:id/cancel
- POST /bookings/:id/passengers/:passengerId/cancel
- POST /bookings/:id/seat-change

## Payments
- POST /payments/create
- POST /payments/webhook
- GET /payments/:id
- POST /payments/:id/reconcile

## Boarding
- POST /boarding/scan
- POST /boarding/manual
- GET /trips/:id/manifest

## Admin
- CRUD trips
- CRUD vehicles
- booking operations
- reports
- reconciliation
- audit logs

Exact API contracts are an engineering-phase deliverable.

---

# 52. Edge Cases

The system must explicitly handle:

### Booking
- Two students choose same seat
- Seat hold expires
- Student closes browser
- Trip closes during booking
- Price changes during booking
- Vehicle changes
- Trip cancellation
- Student partial cancellation
- Booking owner leaves
- Booking owner transfer

### Payment
- Payment success
- Payment pending
- Payment failure
- Browser closes
- Webhook delayed
- Duplicate payment
- Amount mismatch
- Payment success but booking creation fails
- Refund pending
- Refund failure

### Boarding
- Invalid QR
- Wrong trip
- Cancelled booking
- Refunded booking
- Already boarded
- Manual boarding
- Denied boarding
- Scanner unavailable

### Operations
- Vehicle unavailable
- Driver conflict
- Trip schedule conflict
- Seat layout mismatch
- Last-minute vehicle replacement

---

# 53. Acceptance Criteria

A feature is not complete merely because the UI works.

It must satisfy:
1. UI behavior
2. Backend validation
3. Database integrity
4. Permission checks
5. Audit behavior where applicable
6. Failure handling
7. Mobile/accessibility behavior where applicable
8. Security requirements
9. Correct status transitions
10. Reporting consistency

---

# 54. Critical Acceptance Tests

## Seat booking
- Two users cannot book same seat.
- Expired hold releases seat.
- Payment failure releases seat when hold expires.
- Successful payment produces one booking.
- Duplicate webhook produces no duplicate booking.

## Payment
- Browser closure does not lose successful payment.
- Pending payment does not request duplicate payment.
- Mismatched amount does not confirm booking.
- Duplicate payment is detected.
- Refund status is reconciled.

## QR
- Valid QR boards passenger.
- Same QR twice returns ALREADY BOARDED.
- Cancelled booking QR fails.
- Refunded booking QR fails.
- Wrong-trip QR fails.
- Boarding action is recorded.

## Admin
- Role permissions enforced server-side.
- Manual boarding requires correct role.
- Payment reconciliation restricted to Super Admin.
- Audit logs record sensitive actions.
- Important records cannot be deleted.

## Trip changes
- Major change identifies affected bookings.
- Vehicle replacement preserves compatible seats.
- Incompatible seats enter remapping.
- Trip cancellation initiates refunds.

---

# 55. Design System Direction

The final design should feel:
- Premium
- Clean
- Modern
- Student-focused
- Cinematic
- Light/daytime initially

The visual system should connect:
- 3D bus
- Road
- Trip cards
- Seat selector
- Boarding pass
- Admin interface

The homepage can be visually expressive, while transactional screens should prioritize clarity and speed.

---

# 56. Recommended Design Principles

1. **Journey first, booking second.**
2. **Visual storytelling without blocking usability.**
3. **3D enhances; it never becomes a dependency.**
4. **Every important action has a clear state.**
5. **Payment truth lives on the backend.**
6. **Seat truth lives on the backend.**
7. **Boarding truth lives on the scanner/backend.**
8. **Admin overrides are powerful but auditable.**
9. **Student data follows least-privilege access.**
10. **Never silently change a student's confirmed paid booking.**

---

# 57. TBD / Decisions Still Open

These should not be invented by developers:

- Exact homepage opening composition
- Final environment progression between Woxsen and Miyapur
- Mobile 3D strategy
- Exact visual treatment of availability
- Final vehicle metadata beyond V1 baseline
- Exact booking-pass sharing behavior
- Exact legal wording
- Exact retention periods
- Exact Student ID format
- Tax/fee structure
- Exact technical stack
- Exact API contracts
- Exact database technology
- Final branding/colors/typography
- Final 3D bus model/environment assets
- Final copywriting

---

# 58. Future Architecture

The platform should be capable of expanding to:
- More routes
- More universities
- More vehicles
- More pricing
- Coupons
- Referrals
- Automated WhatsApp
- Email notifications
- SMS
- Student verification integrations
- More complex vehicle layouts if required
- More advanced analytics

However, V1 should remain focused on:

> **Woxsen → Miyapur**

---

# 59. Final Product Definition

DLT V1 is a student-focused shuttle booking platform centered on a single route:

> **Woxsen University → Miyapur**

Its defining experience is a scroll-driven 3D journey where:

> **A bus continuously travels along a road → reaches Woxsen → continues its journey → reaches Miyapur → transitions naturally into trip booking.**

Students can:
- Browse trips
- Select seats
- Book up to five passengers
- Enter passenger details
- Pay securely through Razorpay
- Receive individual boarding passes
- Use secure QR codes to board
- Manage trips
- Cancel according to policy
- Join waitlists
- Rate completed trips

DLT Admin can:
- Create and publish trips
- Manage vehicles
- Manage seats
- Manage bookings
- Reconcile payments
- Manage refunds
- Manage boarding
- Scan QR codes
- Handle exceptions
- Manage waitlists
- Generate reports
- Review feedback
- Audit sensitive actions

The architecture must remain dynamic and future-ready while the launch experience remains deliberately focused.

---

# 60. Implementation Order

Recommended implementation sequence:

## Phase 1 — Foundation
- Architecture
- Database
- Authentication
- Roles/permissions
- Audit framework

## Phase 2 — Trip & Vehicle
- Vehicles
- Seat configuration
- Trips
- Publishing
- Availability

## Phase 3 — Student Booking
- Trip discovery
- Seat selection
- Passenger details
- Review
- Cancellation

## Phase 4 — Razorpay
- Payment creation
- Webhooks
- Verification
- Reconciliation
- Refunds
- Failure recovery

## Phase 5 — Boarding
- Boarding pass
- Secure QR
- Scanner
- Manifest
- No-show
- Denied boarding

## Phase 6 — Admin
- Dashboard
- Bookings
- Payments
- Reports
- Vehicles
- Students
- Audit

## Phase 7 — 3D Website
- 3D bus
- Road
- Woxsen
- Journey
- Miyapur
- Scroll choreography
- Trip-card transition

## Phase 8 — Polish
- Accessibility
- Responsive behavior
- Performance
- Error states
- Loading states
- Security hardening
- Testing
- Production readiness

---

# 61. Definition of Done for Launch

DLT V1 is launch-ready when:

- A student can discover a published Woxsen → Miyapur trip.
- Student can select available seats.
- Up to five passenger records can be entered.
- Razorpay payment can be completed.
- Successful payment is verified server-side.
- Browser failure does not lose successful payment.
- Booking is created exactly once.
- Boarding passes are generated.
- Secure QR codes work.
- Staff can scan and board passengers.
- Duplicate QR scans are rejected.
- Cancellations/refunds work according to policy.
- Trip cancellation/refunds work.
- Admin can manage trips and vehicles.
- Admin can reconcile payments.
- Reports are accurate.
- Audit logs work.
- Role permissions work.
- Important records cannot be deleted.
- Core booking works without the 3D experience.
- 3D homepage is performant enough for the target devices.
- Reduced-motion behavior exists.
- Security testing and production checks pass.

---

## Final status

**This document is the consolidated V1 master specification.**

It should be treated as the baseline for:
- UI/UX design
- Figma
- Frontend implementation
- Backend implementation
- Database design
- Razorpay integration
- QR/scanner development
- Admin panel development
- QA/testing
- AI coding/development workflows

Any new feature or change should be explicitly classified as:
**Finalized / TBD / Recommended / Future** before implementation.
