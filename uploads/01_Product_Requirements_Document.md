# DLT Product Requirements Document (PRD)

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


## 1. Purpose
DLT is a student-focused shuttle booking platform. The launch route is **Woxsen University → Miyapur** with a launch fare of **₹259 per seat**.

## 2. Product Goal
Provide a simple, reliable student transportation journey:
**Discover → Choose Trip → Choose Seat → Passenger Details → Review → Pay → Boarding Pass → Board → Rate Trip**

## 3. Users
- Students
- Super Admin
- Operations Admin
- Boarding Staff

## 4. Launch Scope
- Student website and accounts
- Trip discovery
- Dynamic 2+2 seat selection
- Up to 5 passengers per booking
- Passenger details
- Razorpay payments
- Payment reconciliation
- Booking confirmation
- Boarding pass and secure QR
- QR boarding
- Trip/vehicle/booking administration
- Refunds and cancellations
- Waitlist
- Reports
- Audit logs
- Help/FAQ
- Ratings and feedback

## 5. Core Policies
- Seat hold: 10 minutes
- Waitlist claim window: 30 minutes
- Cancellation: full refund at least 12 hours before departure; no refund inside 12 hours, subject to defined major-change exceptions
- No booking transfers
- Currency: INR
- Maximum 5 passengers per booking

## 6. Student Experience
The homepage is a continuous scroll-driven 3D journey. A bus is already moving on a road. Woxsen is the starting hero, Miyapur is the destination hero, and the journey transitions naturally into trip cards and booking.

## 7. Booking
Students may browse without signing in, but authentication is required before payment. Checkout uses a hybrid layout with interactive content and a persistent summary.

## 8. Payment
Razorpay server-side confirmation/webhook verification is the source of truth. Browser-only payment success is never sufficient.

## 9. Boarding
Successful bookings receive individual boarding passes and secure QR tokens. QR scans are validated server-side and cannot be reused.

## 10. Admin
Admin functionality includes trips, vehicles, bookings, passengers, boarding, payments, refunds, waitlist, reports, feedback and audit.

## 11. Future
Architecture should allow more routes, universities, vehicles, coupons, referrals, automated notifications and verification integrations without complicating V1.

## 12. Open/TBD
Exact branding, 3D environment progression, mobile 3D strategy, legal wording, retention periods, tax/fee structure and exact technical stack remain TBD.
