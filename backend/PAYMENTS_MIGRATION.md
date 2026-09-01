# Bookings & payments — browser behaviour → server endpoints

Third of the migration maps. **Nothing here has been executed.**

## 1. Method-by-method

| `window.DLT` today | Server | Client contract |
|---|---|---|
| `bookings.create({...})` | `POST /bookings` + `Idempotency-Key` header | **Changes:** the header is now required. Generate one per checkout attempt and reuse it across retries. |
| `bookings.get(id)` | `GET /bookings/:id` | **Changes:** async. |
| `bookings.mine()` | `GET /bookings/mine` | **Changes:** async. |
| `payments.createIntent(bookingId)` | `POST /payments/create` | **Changes shape.** Returns `{paymentId, providerOrderId, checkoutHandle, amount, keyId}`. For Razorpay, `checkoutHandle` **is** the order id — pass it as `order_id` to Razorpay Checkout along with `keyId`. On a fare change it returns **409 `{repriced, oldTotal, newTotal}`** instead of throwing. |
| — | `POST /bookings/:id/accept-price` | **New, and F-03 depends on it.** The prototype told students to "confirm the new total" with no control to do it. Build that control. |
| `provider.settle(...)` sandbox buttons | **deleted** | Replaced by Razorpay Checkout. Delete the sandbox panel and `demoHint`. |
| `payments.reconcile(id)` | `POST /payments/:id/reconcile` | *Unchanged in shape.* |
| — | `POST /payments/handback` | **New.** Where Razorpay Checkout's handler posts `razorpay_payment_id` + `razorpay_signature`. Verified server-side against **our** stored order id. It is not proof of payment. |
| `bookings.cancellationQuote(id)` | `GET /bookings/:id/cancellation-quote` | **Changes:** async. |
| `bookings.cancel(id, ...)` | `POST /bookings/:id/cancel` | *Unchanged in shape.* |
| `admin.overrideRefund({...})` | `POST /admin/bookings/:id/override-refund` | *Unchanged in shape.* Still reports the real amount. |
| `admin.createManualBooking({...})` | `POST /admin/bookings/manual` | *Unchanged in shape.* |

## 2. The checkout flow changes shape

Today: press Pay → a sandbox object in the page decides → the screen updates.

With a real acquirer:

1. `POST /payments/create` → `paymentSessionId`
2. Open Razorpay Checkout with `{ key: keyId, order_id: checkoutHandle }`
3. Checkout's handler fires with `razorpay_payment_id` and `razorpay_signature`; POST both, plus our `paymentId`, to `/payments/handback`
4. **The return proves nothing.** Poll `GET /bookings/:id` until it is `CONFIRMED`, or show "we're confirming your payment" until the webhook lands — typically seconds.
5. The webhook, not the browser, confirms the booking.

This needs a new waiting state on the confirmation screen. The prototype's
existing "processing" copy is close and can be reused — it already tells the
student not to pay again, which is the important part.

## 3. What the browser is no longer allowed to decide

Payment success, booking confirmation, refund status, the fare, seat ownership.
All five now come from the database, and the fare is never accepted from a
request body at all — `POST /payments/create` takes a `bookingId` and nothing
else on purpose.

## 4. Client work this creates

1. **Idempotency keys** on booking creation — one per attempt, reused on retry.
2. **Handle 409 `repriced`** on `/payments/create` — show old vs new total and an
   accept control.
3. **Hosted checkout redirect + return handling**, replacing the sandbox panel.
4. **Poll for confirmation** after return instead of trusting it.
5. **Delete** `DLT.provider`, the sandbox buttons, and `demoHint`.

## 5. Provider-specific notes for the client

- **Amounts stay in rupees across our API.** The paise conversion happens in the
  server-side adapter only. The client never multiplies by 100.
- **Never trust Checkout's success handler.** A verified handback still does not
  confirm a booking; poll `GET /bookings/:id` until `CONFIRMED`.
- **Do not send `razorpay_order_id` as authoritative.** The server verifies the
  signature against the order id it stored, per Razorpay's own warning. Posting
  it is harmless but it is ignored.
- Only `RAZORPAY_KEY_ID` reaches the browser. The key secret and webhook secret
  never do.

## 6. Not done, and blocking

- **No Razorpay credentials, so the integration has never run.** The signature
  and payload schemes are taken from Razorpay's current official documentation
  rather than assumed — a real improvement on the previous position — but
  documented is not observed. See PRODUCTION_BACKEND.md §2.2.
- **Auto-capture is an assumption.** Orders are created without an explicit
  capture setting. If the Razorpay account is configured for manual capture,
  payments will sit in `authorized` and auto-refund after 3 days. Confirm the
  account setting or add an explicit capture call.
- **Refund settlement is now dispatched** (`dispatchPendingRefunds`) and
  `refund.processed` moves a refund to `REFUNDED` — the gap from the previous
  phase is closed in code, but has never run against Razorpay.
- No settlement reconciliation job yet (a nightly compare of our SUCCESS
  payments against the provider's settled payments).
