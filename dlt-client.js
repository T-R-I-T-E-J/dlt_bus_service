/* dlt-client.js — the window.DLT compatibility layer.
 *
 * WHAT THIS IS
 * A drop-in replacement for dlt-store.js. Same object, same method names, same
 * return shapes. The screens do not know the difference, except that most calls
 * are now promises and one — auth.current() — is deliberately still synchronous.
 *
 * WHAT THIS IS NOT
 * It is not a store. It holds no authority. There is no business rule in this
 * file: no fare arithmetic, no seat allocation, no refund policy, no permission
 * check. Every decision is requested from the server. If you find yourself
 * wanting to compute something here, that is the signal it belongs in the API.
 *
 * THE WHOLE API SURFACE IS IN THIS ONE FILE ON PURPOSE. The backend has never
 * been executed; when a response shape turns out different, one file changes
 * rather than five screens.
 *
 * WRITTEN, NOT EXECUTED. No request in this file has ever been sent.
 */

const BASE = (window.DLT_API_BASE || '/api').replace(/\/$/, '');

/* ---------------------------------------------------------------- errors */

/** Mirrors the server's AppError codes so screens can branch on `code` exactly
 *  as they branched on the prototype's thrown messages. */
export class ApiError extends Error {
  constructor(status, code, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'UNKNOWN';
    this.body = body || null;
  }
  /** A lost seat race, a stale price, a duplicate action. */
  get isConflict() { return this.status === 409; }
  get isAuth() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
  get isRateLimited() { return this.status === 429; }
  /** The network failed, or the server never answered. Distinct from a refusal:
   *  a refusal is information, an outage is not. */
  get isOffline() { return this.code === 'NETWORK'; }
  /** Seconds, when the server said. */
  get retryAfter() { return this._retryAfter || null; }
}

/* ---------------------------------------------------------------- transport */

let onUnauthenticated = null;
/** Screens register a handler so a 401 anywhere lands the student on sign-in
 *  once, rather than each call site inventing its own redirect. */
export function setUnauthenticatedHandler(fn) { onUnauthenticated = fn; }

async function request(method, path, { body, idempotencyKey, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      /* The session and guest tokens are HttpOnly cookies. Nothing in this file
       * can read them, which is the point — an XSS cannot exfiltrate a session.
       * `include` is required because the API may be a different origin. */
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK',
      'We could not reach DLT. Check your connection and try again.', null);
  }

  if (res.status === 204) return null;

  let payload = null;
  const text = await res.text();
  if (text) { try { payload = JSON.parse(text); } catch { payload = { raw: text }; } }

  if (!res.ok) {
    const err = payload && payload.error;
    const e = new ApiError(res.status, err && err.code,
      (err && err.message) || 'Something went wrong. Try again.', payload);
    const ra = res.headers.get('Retry-After');
    if (ra) e._retryAfter = Number(ra);
    if (res.status === 401 && onUnauthenticated) onUnauthenticated(e);
    throw e;
  }
  return payload;
}

const GET = (p, o) => request('GET', p, o);
const POST = (p, body, o) => request('POST', p, { ...o, body });
const PATCH = (p, body, o) => request('PATCH', p, { ...o, body });
const DEL = (p, o) => request('DELETE', p, o);

const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {}))
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? '?' + s : '';
};

/* ---------------------------------------------------------------- session
 *
 * THE ONE PIECE OF STATE THIS FILE HOLDS, and it holds it only so that
 * auth.current() can stay synchronous for the 14 call sites inside renderVals().
 * It is a CACHE of a server answer, never a source of truth: every protected
 * endpoint re-checks the session server-side, so a stale value here cannot
 * authorise anything.
 */

let me = null;
let booted = false;
let bootPromise = null;

/** Resolve the session once. Screens await this before first render. */
export function boot() {
  if (bootPromise) return bootPromise;
  bootPromise = GET('/auth/me')
    .then((r) => { me = (r && r.user) || null; booted = true; return me; })
    .catch((e) => {
      booted = true;
      /* An outage must not look like being signed out — a screen that shows the
       * sign-in panel on a flaky network is worse than one that says so. */
      if (!e.isOffline) me = null;
      throw e;
    });
  return bootPromise;
}

export const isReady = () => booted;

function setMe(user) { me = user || null; booted = true; }

/* ---------------------------------------------------------------- live updates
 *
 * Replaces the prototype's synchronous DLT.subscribe broadcast. Two surfaces
 * genuinely need liveness — the seat map and the boarding manifest — and both
 * poll. Everything else refetches after an action, which is cheaper and simpler.
 */

const listeners = new Set();
let pollTimer = null;
let pollFn = null;

/** Same signature as the prototype's subscribe(fn) -> unsubscribe. */
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } };

/** Starts polling a fetcher and notifying subscribers. `stop()` when the screen
 *  or step closes — an abandoned poller is a slow leak against the API. */
function startPolling(fetcher, ms = 5000) {
  stopPolling();
  pollFn = fetcher;
  const tick = async () => {
    try { await pollFn(); notify(); }
    catch (e) { if (!e.isOffline) console.warn('[dlt] poll', e.message); }
  };
  pollTimer = setInterval(tick, ms);
  /* Pause while the tab is hidden: a backgrounded seat map does not need
   * updates, and a phone in a pocket should not be polling. */
  document.addEventListener('visibilitychange', onVisibility);
  return stopPolling;
}
function onVisibility() {
  if (document.hidden) { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  else if (pollFn && !pollTimer) startPolling(pollFn);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  document.removeEventListener('visibilitychange', onVisibility);
}

/* ---------------------------------------------------------------- idempotency */

/** One key per checkout attempt, reused across retries — which is exactly what
 *  §5 idempotency is for. Held in memory, so a reload starts a new attempt. */
const idemKeys = new Map();
function idempotencyKeyFor(scope) {
  if (!idemKeys.has(scope)) {
    const rand = crypto.getRandomValues(new Uint8Array(16));
    idemKeys.set(scope, [...rand].map((b) => b.toString(16).padStart(2, '0')).join(''));
  }
  return idemKeys.get(scope);
}
function clearIdempotency(scope) { idemKeys.delete(scope); }

/* ================================================================= the API */

const auth = {
  /** SYNCHRONOUS, deliberately. Returns the cached server answer so the 14 call
   *  sites inside renderVals() do not change. Null before boot() resolves. */
  current() { return me; },

  async signUp({ name, email, password, phone, studentId }) {
    const r = await POST('/auth/signup', { name, email, password, phone, studentId });
    /* Note what is NOT returned any more: a verification token (F-06). The
     * account screen must say "check your email" instead of showing a code. */
    return r.user;
  },

  async signIn(email, password) {
    const r = await POST('/auth/login', { email, password });
    setMe(r.user);
    notify();
    return r.user;
  },

  async signOut() {
    try { await POST('/auth/logout'); } finally { setMe(null); notify(); }
  },

  async signOutEverywhere() {
    const r = await POST('/auth/logout-all');
    setMe(null); notify();
    return r;
  },

  /** Refresh the cache from the server — after a change that alters the user. */
  async refresh() {
    const r = await GET('/auth/me');
    setMe(r && r.user);
    return me;
  },

  verifyEmail: (code) => POST('/auth/verify-email', { code }).then((r) => { setMe(r.user); return r.user; }),
  resendVerification: () => POST('/auth/resend-verification'),
  requestReset: (email) => POST('/auth/forgot-password', { email }),
  resetPassword: (code, password) => POST('/auth/reset-password', { code, password }),

  async changePassword(currentPassword, password) {
    const r = await POST('/auth/change-password', { currentPassword, password });
    /* Every session died, including this one. The screen must say so. */
    setMe(null); notify();
    return r;
  },
};

/* ---------------------------------------------------------------- presentation
 *
 * Formatting and label helpers ported verbatim from dlt-store.js. They carry NO
 * authority: no fare, no policy, no permission, no seat rule. Everything here
 * turns a value the server already sent into something readable.
 *
 * Note what is NOT here: no FARE constant, and no reporting-time derivation.
 * Both are server policy (B-1, B-3) and arrive on the trip.
 */
const pad = (n) => String(n).padStart(2, '0');
const asDate = (v) => (v instanceof Date ? v : new Date(v));

const fmt = {
  time(v) {
    if (!v) return '—';
    const d = asDate(v);
    let h = d.getHours(); const m = pad(d.getMinutes());
    const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
    return h + ':' + m + ' ' + ap;
  },
  date(v) {
    if (!v) return '—';
    const d = asDate(v);
    return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  },
  when(v) { return v ? fmt.date(v) + ' · ' + fmt.time(v) : '—'; },
  /** ms → m:ss, for the hold clock. The VALUE comes from the server's
   *  holdExpiresAt; this only renders it. */
  countdown(ms) {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    return Math.floor(total / 60) + ':' + pad(total % 60);
  },
  money(rupees) {
    return rupees === null || rupees === undefined ? '—' : '₹' + Number(rupees).toLocaleString('en-IN');
  },
};

/** Derived from the seat label alone — 'A'/'D' are windows on a 4-across coach.
 *  The server also returns seatType per seat; prefer that where present. */
const seatType = (seat) => (/[AD]$/i.test(String(seat || '')) ? 'WINDOW' : 'AISLE');

const ROLE_LABELS = {
  STUDENT: 'Student', BOARDING_STAFF: 'Boarding staff',
  OPS_ADMIN: 'Operations admin', SUPER_ADMIN: 'Super admin',
};
const roleLabel = (role) => ROLE_LABELS[role] || String(role || '');

/* Field-level form validation, so Continue can disable before a round trip.
 * The SERVER validates authoritatively in validatePassengers() and still
 * refuses — this is a courtesy, never the rule. Kept identical to the server's
 * checks so the two cannot disagree about what is acceptable. */
function validatePassenger(p) {
  if (!p) return false;
  if (!p.name || String(p.name).trim().length < 3) return false;
  if (!p.studentId || !/^[A-Za-z0-9]{4,20}$/.test(String(p.studentId).trim())) return false;
  if (p.phone && !/^[6-9]\d{9}$/.test(String(p.phone).replace(/\s/g, ''))) return false;
  return true;
}

const notifications = {
  /** B-2. tripId optional: the empty state asks about new departures generally. */
  requestNotify: ({ tripId, email }) =>
    POST(tripId ? `/trips/${tripId}/notify` : '/notify', { email }),
};

const trips = {
  listPublic: (days) => GET('/trips' + qs({ days })).then((r) => r.trips),
  get: (id) => GET('/trips/' + id).then((r) => r.trip),

  /** Returns { rows, held } — one request, one consistent snapshot. The
   *  prototype needed two calls and could show a map and a basket that
   *  disagreed. */
  seatMap: (id) => GET('/trips/' + id + '/seats'),

  /** Kept for call-site compatibility; served from the same response. */
  myHeld: (id) => GET('/trips/' + id + '/seats').then((r) => r.held),
};

const seats = {
  /** Throws ApiError with isConflict on a lost race. The caller MUST refetch the
   *  seat map on 409 — a conflict means the map on screen is stale. */
  hold: (tripId, seatNumber) =>
    POST(`/trips/${tripId}/seats/${seatNumber}/hold`).then((r) => r.seat),

  /** F-20: returns { released, reason: 'RELEASED_BY_STUDENT' } so the screen can
   *  distinguish a deliberate removal from an expiry and stop showing "your
   *  seats went back on sale" for a removal. */
  release: (tripId, seatNumber) => DEL(`/trips/${tripId}/seats/${seatNumber}/hold`),
  releaseMine: (tripId) => DEL(`/trips/${tripId}/holds`),
};

const bookings = {
  /** `scope` groups retries under one Idempotency-Key. Pass the trip id. */
  async create({ tripId, passengers, contactPhone, scope }) {
    const key = idempotencyKeyFor(scope || tripId);
    const r = await POST('/bookings', { tripId, passengers, contactPhone }, { idempotencyKey: key });
    return r.booking;
  },
  /** Call after a booking is finished with, so a later attempt is a new one. */
  clearAttempt: (scope) => clearIdempotency(scope),

  get: (id) => GET('/bookings/' + id).then((r) => r.booking),
  mine: () => GET('/bookings/mine').then((r) => r.bookings),
  acceptPrice: (id) => POST(`/bookings/${id}/accept-price`).then((r) => r.booking),
  cancellationQuote: (id) => GET(`/bookings/${id}/cancellation-quote`),
  cancel: (id, reason) => POST(`/bookings/${id}/cancel`, { reason }),

  /** UX-only. The server is authoritative. */
  validatePassenger,
};

const payments = {
  /** Returns { paymentId, providerOrderId, checkoutHandle, amount, keyId } —
   *  or, on 409, an ApiError whose body carries { repriced, oldTotal, newTotal }.
   *  The amount is the SERVER's; nothing here computes a fare. */
  createIntent: (bookingId) => POST('/payments/create', { bookingId }),

  /** After Razorpay Checkout's handler fires. Returns a STATUS, never a booking
   *  — read the booking from bookings.get() if entitled. */
  handback: ({ paymentId, razorpay_payment_id, razorpay_signature }) =>
    POST('/payments/handback', { paymentId, razorpay_payment_id, razorpay_signature }),

  reconcile: (paymentId) => POST(`/payments/${paymentId}/reconcile`),
};

/* Razorpay Checkout. The browser opens it with a SERVER-CREATED order and
 * decides nothing: not success, not the amount, not confirmation. Checkout's
 * success handler is a hint that the flow finished, never proof it succeeded —
 * only a verified webhook confirms, which is why this resolves to "ask the
 * server" rather than "we are paid".
 *
 * There is deliberately no fake-success control anywhere in this file. */
const checkout = {
  async open({ bookingId, onStatus }) {
    const intent = await payments.createIntent(bookingId);

    if (!window.Razorpay)
      throw new ApiError(0, 'CHECKOUT_UNAVAILABLE',
        'The payment window could not load. Check your connection and try again.', null);

    return new Promise((resolve, reject) => {
      const rz = new window.Razorpay({
        key: intent.keyId,
        order_id: intent.checkoutHandle,     // the server's order, not ours
        name: 'DLT',
        description: 'Woxsen → Miyapur Metro',
        theme: { color: '#0E4B34' },
        handler: async (resp) => {
          try {
            if (onStatus) onStatus('VERIFYING');
            const status = await payments.handback({
              paymentId: intent.paymentId,
              razorpay_payment_id: resp.razorpay_payment_id,
              razorpay_signature: resp.razorpay_signature,
            });
            resolve({ ...status, paymentId: intent.paymentId });
          } catch (e) { reject(e); }
        },
        modal: {
          ondismiss: () => reject(new ApiError(0, 'CHECKOUT_DISMISSED',
            'Payment was not completed. Your seats are still held.', null)),
        },
      });
      rz.on('payment.failed', (e) => reject(new ApiError(0, 'PAYMENT_FAILED',
        (e && e.error && e.error.description) || 'That payment did not go through. Nothing was charged.', null)));
      rz.open();
    });
  },

  /** The return from Checkout proves nothing, so ask the server until it is
   *  sure. Bounded, and it reports pending rather than hanging silently. */
  async awaitConfirmation(bookingId, { attempts = 12, intervalMs = 2000, onStatus } = {}) {
    for (let i = 0; i < attempts; i++) {
      const b = await bookings.get(bookingId);
      if (b.status === 'CONFIRMED') return b;
      if (['CANCELLED_BY_STUDENT', 'CANCELLED_BY_DLT', 'ABANDONED'].includes(b.status)) return b;
      if (onStatus) onStatus(b.status);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { status: 'PAYMENT_PENDING', pendingTimeout: true, id: bookingId };
  },
};

const waitlist = {
  join: (tripId, seatsWanted) => POST(`/trips/${tripId}/waitlist`, { seatsWanted }).then((r) => r.entry),
  mine: () => GET('/waitlist/mine').then((r) => r.entries),
  claim: (entryId) => POST(`/waitlist/${entryId}/claim`).then((r) => r.seat),
  decline: (entryId) => POST(`/waitlist/${entryId}/decline`),
};

const boarding = {
  context: () => GET('/boarding/context'),

  /** The scanner submits an identifier and NOTHING else. It never sends a
   *  result, a status, or (for staff) a trip: the server derives the trip from
   *  the staff assignment and decides validity. `passengerId` is set only on the
   *  second call, after a CHOOSE. */
  scan: ({ code, tripId, passengerId }) => POST('/boarding/scan', { code, tripId, passengerId }),

  manual: (passengerId, reason, tripId) =>
    POST(`/boarding/passengers/${passengerId}/manual`, { reason, tripId }),
  deny: (passengerId, reason, tripId) =>
    POST(`/boarding/passengers/${passengerId}/deny`, { reason, tripId }),
  noShow: (passengerId, reason, tripId) =>
    POST(`/boarding/passengers/${passengerId}/no-show`, { reason, tripId }),

  /** 'assigned' asks the server for the caller's assigned trip. */
  manifest: (tripId) => GET(`/trips/${tripId || 'assigned'}/manifest`),
  events: (tripId) => GET(`/trips/${tripId}/boarding-events`).then((r) => r.events),
};

const admin = {
  today: () => GET('/admin/today'),
  alerts: () => GET('/admin/alerts').then((r) => r.alerts),

  saveTrip: (input) => POST('/admin/trips', input).then((r) => r.trip),
  publishTrip: (id) => POST(`/admin/trips/${id}/publish`),
  setTripStatus: (id, status, reason) => POST(`/admin/trips/${id}/status`, { status, reason }),
  cancelTrip: (id, reason) => POST(`/admin/trips/${id}/cancel`, { reason }),
  affectedPassengers: (id) => GET(`/admin/trips/${id}/affected`).then((r) => r.passengers),

  blockSeat: (tripId, seat, reason) => POST(`/admin/trips/${tripId}/seats/${seat}/block`, { reason }),
  unblockSeat: (tripId, seat) => DEL(`/admin/trips/${tripId}/seats/${seat}/block`),

  vehicles: () => GET('/admin/vehicles').then((r) => r.vehicles),
  saveVehicle: (input) => POST('/admin/vehicles', input).then((r) => r.vehicle),

  staff: () => GET('/admin/staff').then((r) => r.staff),
  assignStaff: (tripId, staffUserId, reason) => POST(`/admin/trips/${tripId}/staff`, { staffUserId, reason }),
  unassignStaff: (tripId, userId) => DEL(`/admin/trips/${tripId}/staff/${userId}`),

  bookings: (filter) => GET('/admin/bookings' + qs(filter)).then((r) => r.bookings),
  updateContact: (id, contactPhone, reason) =>
    PATCH(`/admin/bookings/${id}/contact`, { contactPhone, reason }),

  requests: (filter) => GET('/admin/requests' + qs(filter)).then((r) => r.requests),
  decideRequest: (id, decision, reason) => POST(`/admin/requests/${id}/decide`, { decision, reason }),

  waitlist: (tripId) => GET(`/admin/trips/${tripId}/waitlist`).then((r) => r.entries),
  moveWaitlistToTop: (id, reason) => POST(`/admin/waitlist/${id}/move-to-top`, { reason }),

  /* Reports are computed SERVER-SIDE, every total. The prototype recomputed
   * every report on every render on a six-second timer (F-21); nothing here
   * aggregates anything. */
  report: (kind, filter) => GET(`/admin/reports/${kind}` + qs(filter)).then((r) => r.report),

  /** Returns a URL, so the browser downloads rather than building a CSV string
   *  in the page. */
  exportUrl: (kind, filter) => `${BASE}/admin/reports/${kind}/export${qs(filter)}`,

  audit: (filter) => GET('/admin/audit' + qs(filter)),

  overrideRefund: (bookingId, { amount, reason, cancelBooking }) =>
    POST(`/admin/bookings/${bookingId}/override-refund`, { amount, reason, cancelBooking }),
  createManualBooking: (input) => POST('/admin/bookings/manual', input).then((r) => r.booking),
};

/* ================================================================= export
 *
 * Note what is absent, permanently: DLT.provider (the sandbox acquirer),
 * DLT.reset(), DLT._debug, and admin.resetCodeFor(). They are not hidden behind
 * a flag — they do not exist in this file, so there is nothing to expose.
 */

export const DLT = {
  auth, trips, seats, bookings, payments, checkout, waitlist, boarding, admin,
  notifications, fmt, seatType, roleLabel,
  subscribe, startPolling, stopPolling,
  boot, isReady, setUnauthenticatedHandler,
  ApiError,
};

if (typeof window !== 'undefined') window.DLT = DLT;
export default DLT;
