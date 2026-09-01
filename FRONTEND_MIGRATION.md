# DLT — FRONTEND MIGRATION AUDIT

**Date:** 1 September 2026
**Stage:** Phase 7, step 1 — audit before changing code. **No UI was modified.**

> **Backend verification is deferred by your instruction.** Every API named below
> is WRITTEN and UNEXECUTED. Nothing here claims the backend works.

---

## One conflict to raise before any code moves

You asked me to stop and identify conflicts rather than invent resolutions. This
is the only one, and it is about sequence, not rules:

**Rewiring 148 call sites to an API that has never run means any shape change
discovered on first execution is paid for twice.** The riskiest surfaces are the
ones where I already expect type errors (untyped `pg` rows) — booking views and
report payloads, which are exactly what the screens render.

Your instruction is explicit that verification is deferred, so I have proceeded.
The mitigation I have taken is architectural rather than a delay: **the entire
API surface is confined to one file** (`dlt-client.js`). If a response shape
changes when the backend first runs, one file changes — not five screens.

---

## What the audit found

**148 backend call sites across 5 screens.** The single most important finding:

> **No screen touches `localStorage` at all.** Every one goes through
> `window.DLT`. The prototype's discipline — one object, no screen reaching into
> storage or computing a rule — is what makes this migration a replacement of
> that object rather than a rewrite of the product.

| Screen | Lines | Call sites |
|---|---|---|
| Admin | 2,153 | 62 |
| Booking | 1,233 | 41 |
| Dashboard | 785 | 15 |
| Account | 408 | 18 |
| Homepage | 629 | 5 |

| Dependency | Count | Fate |
|---|---|---|
| `DLT.admin.*` | 40 | → `/admin/*` |
| `DLT.auth.*` (non-current) | 19 | → `/auth/*` |
| `DLT.trips.*` | 17 | → `/trips*` |
| `DLT.bookings.*` | 15 | → `/bookings*` |
| **`DLT.auth.current()`** | **14** | **stays synchronous — see §2** |
| `DLT.waitlist.*` | 8 | → `/waitlist*` |
| `DLT.boarding.*` | 8 | → `/boarding*` |
| `DLT.subscribe` | 5 | → polling |
| `setInterval` (client sweepers/timers) | 5 | 3 deleted, 2 kept |
| `sessionStorage` (`dlt.pending`) | 4 | replaced by guest cookie |
| `DLT.payments.*` | 4 | → `/payments/*` |
| `DLT.seats.*` | 3 | → `/trips/:id/seats/*` |
| **`DLT.provider`** | **2** | **DELETED — Razorpay Checkout** |
| **demo credentials** | **2** | **DELETED** |

---

## 1. Dependency → replacement → change → UX → priority

### Authentication

| Current | Backend | Frontend change | UX | Priority |
|---|---|---|---|---|
| `DLT.auth.current()` × 14, **synchronous, inside `renderVals()`** | `GET /auth/me` | Resolve once at boot into module state; the getter stays synchronous | **None** if boot completes first; each screen gains one loading state | **P0** |
| `DLT.auth.signIn` | `POST /auth/login` | already async | Session moves to an HttpOnly cookie the page cannot read | P0 |
| `DLT.auth.signUp` → `{user, verifyToken}` | `POST /auth/signup` → `{user}` | **`verifyToken` is gone** (F-06) | **Yes** — copy becomes "check your email" | P0 |
| `DLT.auth.signOut` | `POST /auth/logout` | sync → promise | None | P0 |
| `DLT.auth.verifyEmail` | `POST /auth/verify-email` | new `?code=` entry point | New small screen (F-15) | P1 |
| — | `POST /auth/resend-verification` | new button | Additive | P1 |
| `DLT.auth.requestReset` | `POST /auth/forgot-password` | unchanged shape | None | P1 |
| `DLT.auth.resetPassword` | `POST /auth/reset-password` | unchanged shape | Now ends all sessions | P1 |
| `DLT.auth.changePassword` | `POST /auth/change-password` | returns `reauthenticate: true` | **Yes** — student is signed out and told why | P1 |
| `DLT.admin.resetCodeFor` | **removed** | delete the call | Support desk loses a shortcut that let an admin read a student's reset code | P0 |
| — | `POST /auth/logout-all` | new | Additive | P2 |

### Trips and seats

| Current | Backend | Frontend change | UX | Priority |
|---|---|---|---|---|
| `DLT.trips.listPublic/get/seatMap` | `GET /trips`, `/trips/:id`, `/trips/:id/seats` | sync → async; `get` is called **inside `renderVals()`** today | Loading state on first paint | **P0** |
| `DLT.trips.myHeld` | folded into the seat-map response | one request, one consistent snapshot | None | P1 |
| `DLT.seats.hold` | `POST /trips/:id/seats/:n/hold` | **must handle 409** by refetching the map | **Yes** — a lost race is now a real, visible outcome | **P0** |
| `DLT.seats.release` | `DELETE …/hold` | returns `reason: 'RELEASED_BY_STUDENT'` | Fixes F-20: a removal no longer reads as an expiry | P1 |
| in-page hold sweeper (`setInterval`) | server `sweepExpiredHolds` + `trip_seat_view` | **delete** | None — it was authority the browser should never have had | **P0** |
| client-started hold countdown | server `holdExpiresAt` | render from the server value; refetch on expiry | None visible; correctness only | P1 |
| `DLT.subscribe` × 5 | polling `GET /trips/:id/seats` | ~5s while the seat step is open | None | P1 |
| `sessionStorage['dlt.pending']` × 4 | guest cookie + `adopt_guest_bookings` | **delete**; sign-in now carries seats *and* booking | Fixes F-08/F-09 properly | P1 |

### Booking and payment

| Current | Backend | Frontend change | UX | Priority |
|---|---|---|---|---|
| `DLT.bookings.create` | `POST /bookings` + **`Idempotency-Key` header** | generate one per checkout attempt, reuse on retry | None | **P0** |
| `DLT.payments.createIntent` | `POST /payments/create` | returns `{checkoutHandle, keyId}`; **409 `repriced`** instead of a throw | **Yes** — new accept-the-new-total step (F-03, which had no control at all) | **P0** |
| **`DLT.provider.settle` sandbox buttons** | Razorpay Checkout | **delete the panel** | **Yes** — real checkout replaces fake controls | **P0** |
| **`demoHint` on the pay screen** | — | **delete** | Yes — credentials off a production screen | **P0** |
| — | `POST /payments/handback` | post Checkout's response; **status only, never a booking** | Additive | P0 |
| — | poll `GET /bookings/:id` until `CONFIRMED` | new waiting state | **Yes** — the return from Checkout proves nothing | **P0** |
| `DLT.bookings.cancellationQuote/cancel` | `/bookings/:id/cancellation-quote`, `/cancel` | async | None | P1 |

### Waitlist, account, boarding, admin

| Current | Backend | Change | UX | Priority |
|---|---|---|---|---|
| `DLT.waitlist.*` × 8 | `/trips/:id/waitlist`, `/waitlist/mine`, `/:id/claim`, `/:id/decline` | async | None | P1 |
| `DLT.bookings.mine`, passes, refunds | `/bookings/mine`, `/bookings/:id` | async | Loading state on My Trips | P1 |
| account requests, deletion | `/admin/requests` (ops side) + account endpoints | async | Fixes F-15 duplicate-request state | P2 |
| `DLT.boarding.*` × 8 | `/boarding/context`, `/scan`, `/passengers/:id/*`, `/trips/:id/manifest`, `/boarding-events` | scanner submits an identifier only | None — the chain is unchanged | P1 |
| `DLT.admin.*` × 40 | `/admin/*` (24 routes) | async; **reports move server-side entirely** | Fixes F-21 (reports recomputed every render, on a 6s timer) | P1 |
| `DLT.subscribe` in admin | polling | manifest + today view only | None | P2 |

---

## 2. The one hard problem, and its answer

`DLT.auth.current()` is called **synchronously inside `renderVals()`** on all
five screens. Against a server it is a fetch. Awaiting it in render is not an
option.

**Answer: resolve the session once at boot, hold it in module state, keep the
getter synchronous.**

```js
let me = null, booted = false;
export async function boot() {
  me = (await api.get('/auth/me')).user;   // one request, page load
  booted = true;
}
DLT.auth.current = () => me;               // unchanged for all 14 call sites
```

Each screen gains **one** loading gate before `boot()` resolves. No
`renderVals()` body changes. This is the entire reason the prototype was built
against a single `window.DLT` object, and it is the difference between a
migration and a rewrite.

---

## 3. Deliberately NOT changed

Per your constraint, and confirmed by reading each: homepage layout, the 3D
journey (`journey.js` untouched — it makes no backend calls), bus/camera/
environment, typography, visual identity, booking UX and flow order, admin
console layout, responsive breakpoints, the boarding validation chain, and the
reduced-motion route.

---

## 4. Prototype authority to remove from production paths

| Item | Where | Action |
|---|---|---|
| `DLT.provider` sandbox + settle buttons | Booking | **delete** |
| `demoHint` credentials | Booking | **delete** |
| `DLT.reset()` | store | **not ported** to the client layer |
| `DLT._debug` | store | **not ported** |
| Seeded demo users/trips | store | server-side `seed:dev`, gated to `_dev`/`_test` databases |
| Client-side hold sweeper | Booking | **delete** |
| Client-side report computation | Admin | **delete** — server computes every total |
| `dlt-store.js` itself | all 5 screens | replaced by `dlt-client.js`; **kept in the repo** as the API contract reference and for the 268-assertion prototype suite |

Nothing retained for development can be reached as production authority: the
client layer has no write path to state, and every rule it invokes lives behind
an endpoint that re-checks it.

---

## 5. Migration priority

| P0 — nothing works without these | P1 — flows correct | P2 — polish |
|---|---|---|
| `boot()` + `auth.current()` shim | waitlist, My Trips, passes | logout-all |
| trips/seats reads + 409 handling | boarding console | admin polling |
| delete client sweeper | admin (40 sites) | account requests |
| booking + idempotency key | verification screen | |
| Razorpay Checkout + polling | release-vs-expiry copy | |
| delete sandbox + demo creds | | |

---

## 6. Files this will touch

`dlt-client.js` (new, the whole API surface) · the 5 `.dc.html` screens ·
`dlt-store.js` (retained, no longer loaded by screens) ·
`journey.js`, `dlt-qr.js` (**unchanged**).
