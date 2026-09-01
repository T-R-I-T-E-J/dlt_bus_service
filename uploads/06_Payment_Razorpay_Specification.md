# DLT Razorpay Payment & Reconciliation Specification

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


## 1. Currency
INR only.

## 2. Source of Truth
Razorpay server-side confirmation and webhook verification. Browser return pages are not authoritative.

## 3. Lifecycle
Initiated → Pending → Success/Failed/Expired
Reconciliation states include Duplicate, Discrepancy, Refund Pending, Refunded and Refund Failed.

## 4. Seat Hold
10-minute backend-controlled hold.

## 5. Successful Payment
Verified payment → finalize booking → generate passes and QR.

## 6. Browser Failure
If browser closes after payment, webhook/reconciliation completes the booking. Student must not pay again.

## 7. Pending
Show Payment Pending / Don't Pay Again. Reconcile automatically.

## 8. Failed
Retry while seat hold remains. If hold expires, release seats.

## 9. Duplicate
Only one successful payment can confirm a booking. Extra payments enter duplicate/refund reconciliation.

## 10. Amount Mismatch
Do not confirm. Flag for Super Admin reconciliation.

## 11. Booking Creation Failure
Show Payment Received / Booking Processing, retry finalization, do not request another payment.

## 12. Refunds
Track refund lifecycle and reconcile failures.

## 13. Receipt
V1 basic receipt with Booking ID, amount, payment time, status and provider reference where appropriate.

## 14. Idempotency
Payment creation, webhook processing and refunds must be idempotent.
