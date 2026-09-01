# DLT Software Requirements Specification (SRS)

## 1. Functional Requirements

### FR-001 Authentication
Students can sign up, sign in, verify email and reset passwords.

### FR-002 Trip Discovery
Students can browse published trips and see the next three eligible trips.

### FR-003 Seat Availability
The backend is authoritative for seat availability and allocation.

### FR-004 Seat Hold
Selected seats are held for 10 minutes with concurrency protection.

### FR-005 Passenger Details
Each passenger requires full name, Student ID and Indian mobile number.

### FR-006 Multi-Passenger Booking
A booking supports up to five passengers.

### FR-007 Review
Students can edit seats, passenger details and booking contact before payment.

### FR-008 Payment
Cashfree is used for INR payments. Server-side confirmation/webhooks determine payment truth.

### FR-009 Booking Finalization
A confirmed booking is created exactly once after verified payment.

### FR-010 Boarding Pass
Each passenger receives an individual pass and secure QR token.

### FR-011 QR Validation
QR validation checks booking, payment, passenger, trip, cancellation/refund and prior boarding status.

### FR-012 Cancellation
Students can cancel full bookings or selected passengers according to policy.

### FR-013 Waitlist
Full trips support a waitlist with a 30-minute claim window and Admin-configurable priority.

### FR-014 Trip Operations
Admin can create, publish, close, cancel and complete trips.

### FR-015 Vehicle Operations
Admin can manage vehicles and compatible seat configurations.

### FR-016 Reports
Admin can generate operational, payment, refund and boarding reports.

### FR-017 Audit
Sensitive administrative actions are recorded in an immutable audit trail.

## 2. Non-Functional Requirements
- Server-side authorization
- Idempotency for webhooks and critical operations
- Atomic seat allocation
- Secure payment handling
- Secure QR tokens
- Least-privilege access
- Accessibility
- Reduced-motion experience
- 3D performance fallback
- Core booking remains functional if 3D fails

## 3. State Models

### Trip
Draft → Open → Booking Closed → Boarding → Departed → Completed
Exception: Cancelled

### Payment
Initiated → Pending/Success/Failed/Expired
Additional reconciliation states: Duplicate, Discrepancy, Refund Pending, Refunded, Refund Failed

### Boarding
Not Boarded → Boarded
Exception: No Show, Denied Boarding

## 4. Edge Cases
The system must handle duplicate payments, delayed webhooks, browser closure, expired seat holds, amount mismatches, vehicle replacement, trip cancellation, partial cancellation, duplicate QR scans and scanner failures.

## 5. Acceptance
Every feature must pass UI, backend, database, permission, audit, failure-handling, security and status-transition validation.
