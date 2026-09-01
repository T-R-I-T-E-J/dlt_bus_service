# DLT Boarding, Manifest & QR Specification

## 1. Boarding Pass
Each passenger receives an individual boarding pass containing trip, passenger, seat, Booking ID, Boarding Code and secure QR.

## 2. QR Security
QR contains a secure token/reference, not personal information.

## 3. Scan Validation
Check:
- Booking exists
- Payment successful
- Passenger valid
- Correct trip
- Not cancelled
- Not refunded
- Not already boarded

## 4. Scan Results
VALID / INVALID / ALREADY BOARDED.

## 5. Roles
Boarding Staff scans assigned/current trips. Operations Admin and Super Admin have broader operational access.

## 6. Manual Boarding
Only Operations Admin and Super Admin. Reason required; audit logged.

## 7. Manifest
Passenger, Student ID, operational phone if needed, seat, seat type and boarding status.

## 8. No-Show
After departure, confirmed but unboarded passengers become Potential No-Show; Admin finalizes NO-SHOW.

## 9. Denied Boarding
Separate DENIED_BOARDING state with reason and audit log.

## 10. QR Invalidation
Cancelled/refunded/wrong-trip/completed journey QR attempts must fail.
