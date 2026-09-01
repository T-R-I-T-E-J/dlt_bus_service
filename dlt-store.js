/* dlt-store.js — the authoritative DLT data layer.

   WHAT THIS IS
   Every business rule the specification assigns to the backend lives in here and
   nowhere else: seat allocation and holds, booking creation, price, booking
   deadlines, payment state transitions, refund policy, QR validity, boarding
   status, role permissions and the audit trail. The four screens are clients of
   this module; they hold no authority and cannot bypass it. Its API is shaped
   like the documented HTTP surface (Master §51) so it can be swapped for a real
   server without touching the interface.

   WHAT THIS IS NOT
   It is not a server. Records persist in localStorage, so "authoritative" means
   authoritative for this browser, not across devices. Concurrency is handled by
   optimistic compare-and-set on a version counter, which is genuine across tabs
   and windows but cannot arbitrate between two students on two phones.
   DLT.provider stands in for the Cashfree hosted checkout: it is a sandbox
   acquirer, clearly labelled as one in the interface, and the UI can only ask
   for reconciliation, never declare a payment successful.

   Master Specification references are cited at each rule. */
(function () {
  'use strict';

  const KEY = 'dlt.db.v6';
  const SESSION_KEY = 'dlt.session.v6';
  const GUEST_KEY = 'dlt.guest.v6';
  const FARE = 259;                          // §20
  const HOLD_MS = 10 * 60 * 1000;            // §13.2  seat hold: 10 minutes
  const CLAIM_MS = 30 * 60 * 1000;           // §18.1  waitlist claim: 30 minutes
  const REFUND_CUTOFF_MS = 12 * 60 * 60 * 1000; // §17   full refund 12h+ out
  const MAX_PAX = 5;                         // §13.3, §14
  const SEAT_COLS = ['A', 'B', 'C', 'D'];    // §13    2 + 2
  const LOGIN_WINDOW_MS = 15 * 60 * 1000, LOGIN_MAX = 5;  // §7.1 rate limiting

  const now = () => Date.now();
  const uid = (p) => p + '_' + Math.random().toString(36).slice(2, 9) + now().toString(36).slice(-4);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const seatType = (id) => (/[AD]$/.test(id) ? 'Window' : 'Aisle');   // §13
  const two = (n) => String(n).padStart(2, '0');

  /* §7 · Security §1 — passwords are stored as a PBKDF2 derived key with a
     per-account random salt. A single shared constant salt and one round of
     SHA-256 (what this used to do) makes every account with the same password
     share a hash and makes the whole table one rainbow table away. This is the
     strongest scheme available in a browser; the production requirement is the
     same derivation server-side, recorded in PRODUCTION_BACKEND.md. */
  const KDF = 'PBKDF2-SHA256', KDF_ITER = 120000;
  const NO_SUCH_USER_SALT = '00'.repeat(16);
  async function derive(password, saltHex) {
    const key = await crypto.subtle.importKey('raw',
      new TextEncoder().encode(String(password == null ? '' : password)), 'PBKDF2', false, ['deriveBits']);
    const salt = new Uint8Array(String(saltHex).match(/../g).map(h => parseInt(h, 16)));
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: KDF_ITER, hash: 'SHA-256' }, key, 256);
    return Array.from(new Uint8Array(bits)).map(b => two(b.toString(16))).join('');
  }
  function token(bytes) {
    const a = new Uint8Array(bytes || 16);
    crypto.getRandomValues(a);
    return Array.from(a).map(b => two(b.toString(16))).join('');
  }

  /* ------------------------------------------------------------------ storage */

  function raw() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); }
    catch (e) { return null; }
  }
  function write(db) {
    localStorage.setItem(KEY, JSON.stringify(db));
    return db;
  }

  /* Optimistic concurrency: re-read, mutate, verify nobody else wrote, commit.
     Two tabs cannot both allocate the same seat — the loser retries and finds
     the seat gone, which is the documented behaviour (§52 "two students choose
     the same seat"). */
  function commit(fn) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const db = raw();
      if (!db) throw new Error('DLT store not initialised');
      const before = db.version;
      sweep(db);
      const result = fn(db);
      const current = raw();
      if (!current || current.version !== before) continue;   // someone else wrote
      db.version = before + 1;
      write(db);
      broadcast();
      return result;
    }
    throw new Error('DLT store: too much contention, please retry');
  }
  function read(fn) {
    const db = raw();
    if (!db) throw new Error('DLT store not initialised');
    if (sweep(db)) { db.version++; write(db); }
    return fn(db);
  }

  const listeners = new Set();
  function broadcast() { listeners.forEach(f => { try { f(); } catch (e) {} }); }
  addEventListener('storage', (e) => { if (e.key === KEY) broadcast(); });

  /* ------------------------------------------------- time-driven housekeeping */

  /* §13.2 expired holds release seats · §29 trip status automation.
     Returns true if anything changed. */
  function sweep(db) {
    let touched = false;
    const t = now();
    const reoffer = new Set();

    db.tripSeats.forEach(s => {
      if (s.status === 'HELD' && s.holdExpiresAt && s.holdExpiresAt <= t) {
        s.status = 'AVAILABLE'; s.holdBy = null; s.holdExpiresAt = null; s.bookingId = null;
        touched = true;
      }
    });

    /* a booking whose payment never completed releases its seats with the hold */
    db.bookings.forEach(b => {
      if (b.status === 'PAYMENT_PENDING' && b.holdExpiresAt && b.holdExpiresAt <= t) {
        const p = db.payments.find(p => p.bookingId === b.id && p.status !== 'SUCCESS');
        if (p && ['INITIATED', 'PENDING'].indexOf(p.status) >= 0) { p.status = 'EXPIRED'; p.updatedAt = t; }
        b.status = 'ABANDONED'; b.updatedAt = t;
        touched = true;
      }
    });

    db.trips.forEach(tr => {
      if (tr.status === 'DRAFT' || tr.status === 'CANCELLED' || tr.status === 'COMPLETED') return;
      const dep = tr.departureAt, arr = dep + (tr.journeyMinutes || 120) * 60000;
      let next = tr.status;
      if (t >= arr) next = 'COMPLETED';
      else if (t >= dep) next = 'DEPARTED';
      else if (t >= dep - 45 * 60000) next = 'BOARDING';
      else if (t >= tr.bookingCloseAt) next = 'BOOKING_CLOSED';
      else next = 'OPEN';
      /* automation only moves forward, and never past an admin correction (§29) */
      const order = ['OPEN', 'BOOKING_CLOSED', 'BOARDING', 'DEPARTED', 'COMPLETED'];
      if (order.indexOf(next) > order.indexOf(tr.status) && !tr.statusPinned) {
        tr.status = next; tr.updatedAt = t; touched = true;
        if (next === 'DEPARTED') {
          /* §25.1 confirmed but unboarded becomes potential no-show */
          db.bookingPassengers.forEach(p => {
            const b = db.bookings.find(b => b.id === p.bookingId);
            if (b && b.tripId === tr.id && b.status === 'CONFIRMED' && p.boardingStatus === 'NOT_BOARDED') {
              p.boardingStatus = 'POTENTIAL_NO_SHOW';
            }
          });
        }
      }
    });

    db.waitlist.forEach(w => {
      if (['CLAIM_OFFERED', 'CLAIMED'].indexOf(w.status) >= 0 && w.claimExpiresAt && w.claimExpiresAt <= t) {
        w.status = 'CLAIM_EXPIRED'; w.claimExpiresAt = null;
        /* the reserved seat was released by the hold sweep above; pass it on */
        reoffer.add(w.tripId);
        touched = true;
      }
    });
    reoffer.forEach(tripId => waitlistOffer(db, tripId));

    return touched;
  }

  /* ------------------------------------------------------------ audit (§44) */

  function audit(db, actor, action, entityType, entityId, oldValue, newValue, reason) {
    db.auditLogs.unshift({
      id: uid('aud'), at: now(),
      actorId: actor ? actor.id : null,
      actorName: actor ? (actor.name || actor.email) : 'system',
      actorRole: actor ? actor.role : 'SYSTEM',
      action, entityType, entityId,
      oldValue: oldValue == null ? null : String(oldValue),
      newValue: newValue == null ? null : String(newValue),
      reason: reason || null,
    });
    if (db.auditLogs.length > 600) db.auditLogs.length = 600;   // §45: never deleted in a real store
  }

  /* --------------------------------------------------- permissions (§36, §47) */

  const PERMS = {
    SUPER_ADMIN: ['*'],
    OPS_ADMIN: [
      'trip.read', 'trip.create', 'trip.publish', 'trip.status', 'trip.cancel', 'seat.block',
      'booking.read', 'booking.cancel', 'booking.move', 'passenger.read',
      'boarding.read', 'boarding.scan', 'boarding.manual', 'boarding.noshow', 'boarding.deny',
      'vehicle.read', 'vehicle.write', 'report.read', 'report.export',
      'waitlist.read', 'waitlist.reorder', 'feedback.read', 'feedback.moderate',
      'notification.read', 'notification.resolve', 'staff.assign', 'student.read',
    ],
    BOARDING_STAFF: ['boarding.read', 'boarding.scan', 'trip.read'],
    STUDENT: [],
  };
  function can(role, action) {
    const list = PERMS[role] || [];
    return list.indexOf('*') >= 0 || list.indexOf(action) >= 0;
  }
  function assert(actor, action) {
    if (!actor) throw denied('Sign in required');
    if (!can(actor.role, action)) throw denied('Your role (' + label(actor.role) + ') cannot ' + action);
    return actor;
  }
  function denied(msg) { const e = new Error(msg); e.code = 'FORBIDDEN'; return e; }
  function label(role) {
    return { SUPER_ADMIN: 'Super Admin', OPS_ADMIN: 'Operations Admin',
      BOARDING_STAFF: 'Boarding Staff', STUDENT: 'Student' }[role] || role;
  }

  /* -------------------------------------------------------------------- seed */

  function seatsForVehicle(vehicle) {
    const out = [];
    for (let r = 1; r <= vehicle.rowCount; r++) {
      SEAT_COLS.forEach((c, i) => out.push({
        seatNumber: r + c, row: r, side: i < 2 ? 'left' : 'right',
        position: i, seatType: seatType(r + c),
      }));
    }
    return out;
  }

  async function seed() {
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const day = (n, h, m) => t0.getTime() + n * 86400000 + h * 3600000 + (m || 0) * 60000;

    const db = {
      version: 1, seededAt: now(),
      users: [], routes: [], vehicles: [], trips: [], tripSeats: [],
      bookings: [], bookingPassengers: [], payments: [], providerEvents: [], refunds: [],
      passes: [], boardingEvents: [], waitlist: [], reviews: [], notifications: [],
      auditLogs: [], sessions: [], idem: {}, rate: {},
    };

    const creds = [];
    for (let i = 0; i < 12; i++) { const s = token(16); creds.push({ salt: s, hash: await derive('dlt1234', s) }); }
    let credAt = 0;
    const mkUser = (email, name, role, extra) => {
      const c = creds[credAt++ % creds.length];
      const u = Object.assign({
        id: uid('u'), email, name, role,
        passwordHash: c.hash, passwordSalt: c.salt, kdf: KDF, kdfIterations: KDF_ITER,
        emailVerified: role !== 'STUDENT', verifyToken: role === 'STUDENT' ? token(8) : null,
        status: 'ACTIVE', createdAt: now(),
        phone: null, studentId: null, university: null, emergencyContact: null,
      }, extra || {});
      db.users.push(u);
      return u;
    };

    const student = mkUser('aarav@woxsen.edu.in', 'Aarav Menon', 'STUDENT', {
      phone: '9876543210', studentId: 'WU204118', university: 'Woxsen University',
      emailVerified: true, verifyToken: null,
      emergencyContact: { name: 'Lakshmi Menon', phone: '9840012233', relation: 'Mother' },
    });
    const student2 = mkUser('diya@woxsen.edu.in', 'Diya Rao', 'STUDENT', {
      phone: '9876511902', studentId: 'WU204119', university: 'Woxsen University', emailVerified: true, verifyToken: null,
    });
    const superAdmin = mkUser('super@dlt.co.in', 'R. Iyer', 'SUPER_ADMIN');
    const ops = mkUser('ops@dlt.co.in', 'N. Sharma', 'OPS_ADMIN');
    const staff = mkUser('staff@dlt.co.in', 'S. Reddy', 'BOARDING_STAFF');

    const route = { id: 'r_wox_miy', origin: 'Woxsen University', destination: 'Miyapur',
      pickupPoint: 'Woxsen main gate loop', dropPoint: 'Miyapur metro, Red Line',
      distanceKm: 69, journeyMinutes: 120, active: true };
    db.routes.push(route);

    const v1 = { id: 'v_dlt01', name: 'DLT-01', registration: 'TS07 JK 4412', rowCount: 11,
      capacity: 44, status: 'AVAILABLE', createdAt: now() };
    const v2 = { id: 'v_dlt02', name: 'DLT-02', registration: 'TS07 KM 8890', rowCount: 11,
      capacity: 44, status: 'AVAILABLE', maintenanceFrom: day(5, 0), createdAt: now() };
    db.vehicles.push(v1, v2);

    const mkTrip = (o) => {
      const tr = Object.assign({
        id: uid('t'), routeId: route.id, price: FARE, journeyMinutes: 120,
        pickupPoint: route.pickupPoint, cancellationPolicy: 'FULL_REFUND_12H',
        notes: null, statusPinned: false, createdAt: now(), updatedAt: now(),
      }, o);
      tr.reportingAt = tr.departureAt - 20 * 60000;
      if (tr.bookingOpenAt == null) tr.bookingOpenAt = tr.departureAt - 14 * 86400000;
      if (tr.bookingCloseAt == null) tr.bookingCloseAt = tr.departureAt - 60 * 60000;
      db.trips.push(tr);
      const veh = db.vehicles.find(v => v.id === tr.vehicleId);
      seatsForVehicle(veh).forEach(s => db.tripSeats.push(Object.assign({
        id: uid('ts'), tripId: tr.id, status: 'AVAILABLE',
        bookingId: null, holdBy: null, holdExpiresAt: null, blockReason: null,
      }, s)));
      return tr;
    };

    const tToday = mkTrip({ vehicleId: v1.id, departureAt: day(0, 17, 30), status: 'BOARDING', statusPinned: true });
    const t1 = mkTrip({ vehicleId: v1.id, departureAt: day(1, 17, 30), status: 'OPEN' });
    const t2 = mkTrip({ vehicleId: v2.id, departureAt: day(2, 9, 0), status: 'OPEN' });
    const t3 = mkTrip({ vehicleId: v1.id, departureAt: day(3, 17, 30), status: 'OPEN' });
    const t4 = mkTrip({ vehicleId: v2.id, departureAt: day(5, 9, 0), status: 'DRAFT' });
    const tPast = mkTrip({ vehicleId: v1.id, departureAt: day(-14, 9, 0), status: 'COMPLETED', statusPinned: true });
    const tPast2 = mkTrip({ vehicleId: v1.id, departureAt: day(-24, 17, 30), status: 'COMPLETED', statusPinned: true });
    const tCancelled = mkTrip({ vehicleId: v2.id, departureAt: day(-40, 17, 30), status: 'CANCELLED', statusPinned: true,
      cancelledReason: 'Vehicle failed its morning safety check' });

    /* §13.4 crew seats blocked by operations, with a reason and an audit entry */
    ['1A', '1B'].forEach(sn => {
      const s = db.tripSeats.find(s => s.tripId === t1.id && s.seatNumber === sn);
      s.status = 'BLOCKED'; s.blockReason = 'Crew seat';
      audit(db, ops, 'seat.block', 'tripSeat', s.id, 'AVAILABLE', 'BLOCKED', 'Crew seat');
    });

    /* --- seeded historical records. Real rows in the real tables, not fixtures
           rendered by a screen: they move through the same code paths. --- */
    const mkBooking = (o, pax, pay) => {
      const b = Object.assign({
        id: uid('b'), code: 'DLT-' + Math.floor(40000 + Math.random() * 9000),
        boardingCode: 'WX' + Math.floor(1000 + Math.random() * 8999),
        ownerId: student.id, status: 'CONFIRMED', bookingType: 'ONLINE',
        contactPhone: student.phone, createdAt: o.createdAt || now(), updatedAt: now(),
        holdExpiresAt: null,
      }, o);
      b.totalAmount = pax.length * FARE;
      db.bookings.push(b);
      pax.forEach(p => {
        const seat = db.tripSeats.find(s => s.tripId === b.tripId && s.seatNumber === p.seat);
        seat.status = b.status === 'CONFIRMED' ? 'BOOKED' : seat.status;
        seat.bookingId = b.id;
        const bp = {
          id: uid('bp'), bookingId: b.id, name: p.name, studentId: p.sid, phone: p.phone,
          tripSeatId: seat.id, seatNumber: seat.seatNumber, seatType: seat.seatType,
          boardingStatus: p.boarded ? 'BOARDED' : 'NOT_BOARDED',
        };
        db.bookingPassengers.push(bp);
        db.passes.push({
          id: uid('pass'), passengerId: bp.id, bookingId: b.id, tripId: b.tripId,
          boardingCode: b.boardingCode, qrToken: 'dlt.' + token(14),
          status: b.status === 'CONFIRMED' ? 'VALID' : 'PENDING', issuedAt: b.createdAt,
        });
        if (p.boarded) db.boardingEvents.push({
          id: uid('be'), passengerId: bp.id, tripId: b.tripId, staffUserId: staff.id,
          staffName: staff.name, result: 'VALID', method: 'SCAN', at: b.tripId === tPast.id
            ? tPast.departureAt - 9 * 60000 : tPast2.departureAt - 12 * 60000, reason: null,
        });
      });
      if (pay) {
        const p = Object.assign({
          id: uid('pay'), bookingId: b.id, provider: 'SANDBOX_CASHFREE',
          providerReference: 'SBX' + Math.floor(5e8 + Math.random() * 4e8),
          amount: b.totalAmount, currency: 'INR', status: 'SUCCESS',
          createdAt: b.createdAt, updatedAt: b.createdAt, idempotencyKey: uid('idem'),
        }, pay);
        db.payments.push(p);
      }
      return b;
    };

    mkBooking({ tripId: t1.id, createdAt: now() - 3600000 },
      [{ name: 'Aarav Menon', sid: 'WU204118', phone: '9876543210', seat: '10A' },
       { name: 'Diya Rao', sid: 'WU204119', phone: '9876511902', seat: '10B' }],
      {});

    const bPast = mkBooking({ tripId: tPast.id, createdAt: tPast.departureAt - 3 * 86400000 },
      [{ name: 'Aarav Menon', sid: 'WU204118', phone: '9876543210', seat: '7D', boarded: true }], {});
    const bPast2 = mkBooking({ tripId: tPast2.id, createdAt: tPast2.departureAt - 4 * 86400000 },
      [{ name: 'Aarav Menon', sid: 'WU204118', phone: '9876543210', seat: '3B', boarded: true }], {});
    db.reviews.push({ id: uid('rev'), tripId: tPast2.id, bookingId: bPast2.id, userId: student.id,
      rating: 5, feedback: 'Left exactly on time and the driver waited for two late students.',
      status: 'VISIBLE', adminResponse: null, createdAt: tPast2.departureAt + 4 * 3600000 });

    const bCan = mkBooking({ tripId: tCancelled.id, status: 'CANCELLED_BY_DLT',
      createdAt: tCancelled.departureAt - 5 * 86400000 },
      [{ name: 'Aarav Menon', sid: 'WU204118', phone: '9876543210', seat: '9A' }], {});
    db.passes.filter(p => p.bookingId === bCan.id).forEach(p => { p.status = 'VOID'; });
    db.refunds.push({ id: uid('ref'), bookingId: bCan.id, paymentId: db.payments.find(p => p.bookingId === bCan.id).id,
      amount: 259, status: 'REFUNDED', reason: 'Trip cancelled by DLT',
      providerReference: 'SBXR' + Math.floor(1e8 + Math.random() * 8e8),
      createdAt: tCancelled.departureAt, updatedAt: tCancelled.departureAt + 3 * 86400000 });

    /* today's boarding trip — a real manifest for the scanner */
    const others = [
      ['Ishaan Kulkarni', 'WU203044', '9003155218', '4C'],
      ['Meera Nair', 'WU205512', '9177240881', '4D'],
      ['Rohit Bhatia', 'WU201987', '9391026644', '7A'],
      ['Sana Fatima', 'WU206310', '9948071235', '9B'],
      ['Kabir Shah', 'WU202771', '9701188342', '2C'],
      ['Priya Deshmukh', 'WU205188', '9885512400', '6D'],
    ];
    others.forEach((o, i) => {
      const u = mkUser(o[1].toLowerCase() + '@woxsen.edu.in', o[0], 'STUDENT',
        { phone: o[2], studentId: o[1], university: 'Woxsen University', emailVerified: true, verifyToken: null });
      mkBooking({ tripId: tToday.id, ownerId: u.id, contactPhone: o[2],
        createdAt: now() - (8 - i) * 3600000 },
        [{ name: o[0], sid: o[1], phone: o[2], seat: o[3] }], {});
    });
    /* two of them already scanned in, so boarding progress is real */
    [0, 2].forEach(i => {
      const bp = db.bookingPassengers.find(p => p.studentId === others[i][1]);
      bp.boardingStatus = 'BOARDED';
      db.boardingEvents.push({ id: uid('be'), passengerId: bp.id, tripId: tToday.id,
        staffUserId: staff.id, staffName: staff.name, result: 'VALID', method: 'SCAN',
        at: now() - (20 - i * 6) * 60000, reason: null });
    });

    /* t2 nearly full, t3 full — real allocations, so availability is computed.
       These belong to the six other students, never the demo student, whose My
       Trips should read like one person's history. */
    const fill = (trip, count, from) => {
      const pool = db.users.filter(u => u.role === 'STUDENT').slice(2);
      const free = db.tripSeats.filter(s => s.tripId === trip.id && s.status === 'AVAILABLE');
      free.slice(0, count).forEach((s, i) => {
        const u = pool[i % pool.length];
        mkBooking({ tripId: trip.id, ownerId: u.id, contactPhone: u.phone, createdAt: now() - (from + i) * 60000 },
          [{ name: u.name, sid: u.studentId, phone: u.phone, seat: s.seatNumber }], {});
      });
    };
    fill(t2, 38, 400);
    fill(t3, 44, 900);

    /* §18 waitlist entries on the full trip */
    ['WU203044', 'WU205512', 'WU201987'].forEach((sid, i) => {
      const u = db.users.find(u => u.studentId === sid);
      db.waitlist.push({ id: uid('wl'), tripId: t3.id, userId: u.id, priority: i + 1,
        joinedAt: now() - (60 - i * 10) * 60000, claimExpiresAt: null, status: 'WAITING' });
    });

    /* §43 reconciliation cases that genuinely exist as payment rows */
    const orphan = (studentName, amount, status, extra) => {
      const u = db.users.find(u => u.name === studentName) || student;
      const b = { id: uid('b'), code: 'DLT-' + Math.floor(40000 + Math.random() * 9000),
        boardingCode: 'WX' + Math.floor(1000 + Math.random() * 8999), tripId: t2.id,
        ownerId: u.id, status: status === 'SUCCESS' ? 'CONFIRMED' : 'PAYMENT_PENDING',
        bookingType: 'ONLINE', contactPhone: u.phone, totalAmount: 518,
        createdAt: now() - 5400000, updatedAt: now(), holdExpiresAt: null };
      db.bookings.push(b);
      db.payments.push(Object.assign({ id: uid('pay'), bookingId: b.id, provider: 'SANDBOX_CASHFREE',
        providerReference: 'SBX' + Math.floor(5e8 + Math.random() * 4e8), amount, currency: 'INR',
        status, createdAt: b.createdAt, updatedAt: now(), idempotencyKey: uid('idem') }, extra || {}));
      return b;
    };
    orphan('Rohit Bhatia', 259, 'PENDING');
    orphan('Meera Nair', 518, 'DUPLICATE', { duplicateOf: 'earlier successful charge' });
    orphan('Ishaan Kulkarni', 500, 'DISCREPANCY', { expectedAmount: 518 });
    orphan('Priya Deshmukh', 259, 'FAILED');
    const ext = orphan('Kabir Shah', 259, 'SUCCESS', { provider: 'MANUAL_EXTERNAL', providerReference: null });
    db.bookings.find(b => b.id === ext.id).bookingType = 'MANUAL_EXTERNAL';

    audit(db, superAdmin, 'system.seed', 'system', 'db', null, 'seeded', 'Initial reference data');
    return write(db);
  }

  /* -------------------------------------------------------------- public API */

  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });

  async function init() {
    if (!raw()) await seed();
    else read(() => {});
    readyResolve(true);
  }

  /* ---- auth (§7, §47) ---- */

  /* §7.2 — "They may begin the booking flow without signing in. Authentication
     is required before payment." A seat hold therefore belongs to a HOLDER,
     which is the signed-in student where there is one and an anonymous browser
     token where there is not. The guest token is local to this browser, holds
     nothing but seat reservations, and is adopted by the account the moment the
     student signs in — so authenticating never costs them their seats. */
  function guestId() {
    let g = localStorage.getItem(GUEST_KEY);
    if (!g) { g = 'guest_' + token(9); localStorage.setItem(GUEST_KEY, g); }
    return g;
  }
  function holderId() {
    const me = sessionUser();
    return me ? me.id : guestId();
  }
  /* every seat this browser was holding becomes the account's on sign-in */
  function adoptGuestHolds(db, userId) {
    const g = localStorage.getItem(GUEST_KEY);
    if (!g) return 0;
    let n = 0;
    db.tripSeats.forEach(s => {
      if (s.status === 'HELD' && s.holdBy === g) { s.holdBy = userId; n++; }
    });
    return n;
  }

  function sessionUser() {
    const tok = localStorage.getItem(SESSION_KEY);
    if (!tok) return null;
    return read(db => {
      const s = db.sessions.find(s => s.token === tok);
      if (!s || s.expiresAt < now()) return null;
      const u = db.users.find(u => u.id === s.userId);
      if (!u || u.status !== 'ACTIVE') return null;
      return publicUser(u);
    });
  }
  function publicUser(u) {
    return { id: u.id, email: u.email, name: u.name, role: u.role, phone: u.phone,
      studentId: u.studentId, university: u.university, status: u.status,
      emailVerified: u.emailVerified, createdAt: u.createdAt,
      emergencyContact: u.emergencyContact ? clone(u.emergencyContact) : null };
  }
  function actorRecord(db, id) {
    const u = db.users.find(u => u.id === id);
    return u ? { id: u.id, name: u.name, email: u.email, role: u.role } : null;
  }

  const auth = {
    current: sessionUser,
    async signUp({ name, email, password, phone, studentId }) {
      if (!name || String(name).trim().length < 3) throw new Error('Enter your full name');
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email || '')) throw new Error('Enter a valid email address');
      if (!password || password.length < 8) throw new Error('Use at least 8 characters');
      if (!/^[6-9]\d{9}$/.test(String(phone || '').replace(/\s/g, ''))) throw new Error('Enter a valid Indian mobile number');
      const salt = token(16);
      const hash = await derive(password, salt);
      return commit(db => {
        if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase()))
          throw new Error('An account already exists for that email');
        const u = { id: uid('u'), email: email.toLowerCase(), name: String(name).trim(), role: 'STUDENT',
          passwordHash: hash, passwordSalt: salt, kdf: KDF, kdfIterations: KDF_ITER,
          emailVerified: false, verifyToken: token(8), status: 'ACTIVE',
          createdAt: now(), phone: String(phone).replace(/\s/g, ''), studentId: studentId || null,
          university: 'Woxsen University', emergencyContact: null };
        db.users.push(u);
        audit(db, null, 'auth.signup', 'user', u.id, null, u.email, null);
        return { user: publicUser(u), verifyToken: u.verifyToken };
      });
    },
    async signIn(email, password) {
      const em = String(email || '').toLowerCase();
      /* the salt belongs to the account, so it has to be read before deriving.
         An unknown address derives against a constant salt anyway, so a missing
         account costs the same time as a wrong password. */
      const probe = read(db => {
        const u = db.users.find(u => u.email === em);
        return u ? { salt: u.passwordSalt || NO_SUCH_USER_SALT } : null;
      });
      const hash = await derive(password || '', probe ? probe.salt : NO_SUCH_USER_SALT);
      /* The attempt counter has to survive a rejected sign-in, so the verdict is
         computed and committed in one successful transaction and the error is
         raised afterwards — throwing inside the transaction rolled the counter
         back, which left rate limiting (§7.1) unenforced. */
      const verdict = commit(db => {
        const r = db.rate[em] || { n: 0, until: 0 };
        if (r.n >= LOGIN_MAX && r.until > now()) {
          return { error: 'Too many attempts. Try again in ' +
            Math.ceil((r.until - now()) / 60000) + ' minutes.' };
        }
        const u = db.users.find(u => u.email === em);
        if (!u || u.passwordHash !== hash) {
          /* §7.1 a FIXED window from the first failure. Extending it on every
             attempt let anyone lock a known address out indefinitely. */
          const fresh = (!r.until || r.until <= now()) ? { n: 0, until: now() + LOGIN_WINDOW_MS } : r;
          fresh.n++;
          db.rate[em] = fresh;
          return { error: 'Email or password is incorrect' };
        }
        if (u.status !== 'ACTIVE') return { error: 'This account is not active. Contact support.' };
        delete db.rate[em];
        const adopted = adoptGuestHolds(db, u.id);
        const s = { token: token(24), userId: u.id, createdAt: now(), expiresAt: now() + 14 * 86400000 };
        db.sessions.push(s);
        audit(db, actorRecord(db, u.id), 'auth.signin', 'user', u.id, null,
          adopted ? adopted + ' held seat(s) adopted' : null, null);
        return { token: s.token, user: publicUser(u) };
      });
      if (verdict.error) throw new Error(verdict.error);
      localStorage.setItem(SESSION_KEY, verdict.token);
      broadcast();
      return verdict.user;
    },
    signOut() {
      const tok = localStorage.getItem(SESSION_KEY);
      localStorage.removeItem(SESSION_KEY);
      if (tok) commit(db => { db.sessions = db.sessions.filter(s => s.token !== tok); });
      broadcast();
    },
    verifyEmail(tok) {
      return commit(db => {
        const u = db.users.find(u => u.verifyToken === tok);
        if (!u) throw new Error('That verification link is not valid');
        u.emailVerified = true; u.verifyToken = null;
        audit(db, actorRecord(db, u.id), 'auth.email_verified', 'user', u.id, 'false', 'true', null);
        return publicUser(u);
      });
    },
    requestReset(email) {
      return commit(db => {
        const u = db.users.find(u => u.email === String(email || '').toLowerCase());
        /* never reveal whether the address exists — and never hand the code back
           to the caller. In production it is emailed; here a Super Admin can
           read it from the support desk (admin.resetCodeFor), which is audited. */
        if (!u) return { sent: true };
        u.resetToken = token(8); u.resetExpiresAt = now() + 3600000;
        audit(db, null, 'auth.reset_requested', 'user', u.id, null, null, null);
        return { sent: true };
      });
    },
    async resetPassword(tok, password) {
      if (!password || password.length < 8) throw new Error('Use at least 8 characters');
      const salt = token(16);
      const hash = await derive(password, salt);
      return commit(db => {
        const u = db.users.find(u => u.resetToken === tok && u.resetExpiresAt > now());
        if (!u) throw new Error('That reset link has expired');
        u.passwordHash = hash; u.passwordSalt = salt; u.kdf = KDF; u.kdfIterations = KDF_ITER;
        u.resetToken = null; u.resetExpiresAt = null;
        db.sessions = db.sessions.filter(s => s.userId !== u.id);   // §47 invalidate sessions
        audit(db, actorRecord(db, u.id), 'auth.password_reset', 'user', u.id, null, null, null);
        return true;
      });
    },
    /* §8.1 normal fields are the student's own; identity fields are protected */
    updateProfile(patch) {
      const me = sessionUser();
      if (!me) throw denied('Sign in required');
      return commit(db => {
        const u = db.users.find(u => u.id === me.id);
        const before = { name: u.name, phone: u.phone, emergencyContact: u.emergencyContact };
        if (patch.name != null) {
          if (String(patch.name).trim().length < 3) throw new Error('Enter your full name');
          u.name = String(patch.name).trim();
        }
        if (patch.phone != null) {
          if (!/^[6-9]\d{9}$/.test(String(patch.phone).replace(/\s/g, ''))) throw new Error('Enter a valid Indian mobile number');
          u.phone = String(patch.phone).replace(/\s/g, '');
        }
        if (patch.emergencyContact !== undefined) u.emergencyContact = patch.emergencyContact;
        if (patch.studentId != null && patch.studentId !== u.studentId) {
          /* §8.1 Student ID changes need Admin review, so this only files a request */
          db.notifications.push({ id: uid('nr'), kind: 'STUDENT_ID_CHANGE', userId: u.id,
            requested: patch.studentId, current: u.studentId, status: 'PENDING', requestedAt: now() });
          audit(db, actorRecord(db, u.id), 'profile.id_change_requested', 'user', u.id, u.studentId, patch.studentId, null);
        }
        audit(db, actorRecord(db, u.id), 'profile.update', 'user', u.id,
          JSON.stringify(before), JSON.stringify({ name: u.name, phone: u.phone }), null);
        return publicUser(u);
      });
    },
    /* §8.3 deletion is a request an admin reviews; financial records survive */
    requestDeletion(reason) {
      const me = sessionUser();
      if (!me) throw denied('Sign in required');
      return commit(db => {
        const open = db.notifications.find(n => n.kind === 'ACCOUNT_DELETION' &&
          n.userId === me.id && n.status === 'PENDING');
        if (open) throw new Error('A deletion request is already with operations and is waiting on review.');
        db.notifications.push({ id: uid('nr'), kind: 'ACCOUNT_DELETION', userId: me.id,
          reason: reason || null, status: 'PENDING', requestedAt: now() });
        audit(db, actorRecord(db, me.id), 'account.deletion_requested', 'user', me.id, null, 'PENDING', reason || null);
        return true;
      });
    },
    /* what the account screen needs to show the true state of its own requests */
    myRequests() {
      const me = sessionUser();
      if (!me) return [];
      return read(db => db.notifications.filter(n => n.userId === me.id)
        .sort((a, b) => b.requestedAt - a.requestedAt)
        .map(n => ({ id: n.id, kind: n.kind, status: n.status, requestedAt: n.requestedAt,
          requested: n.requested || null, decidedAt: n.decidedAt || null, decisionReason: n.decisionReason || null })));
    },
    demoAccounts: [
      { email: 'aarav@woxsen.edu.in', role: 'Student with an upcoming trip' },
      { email: 'super@dlt.co.in', role: 'Super Admin' },
      { email: 'ops@dlt.co.in', role: 'Operations Admin' },
      { email: 'staff@dlt.co.in', role: 'Boarding Staff' },
    ],
    demoPassword: 'dlt1234',
  };

  /* ---- trips & seats (§10, §11, §13) ---- */

  /* The payment that speaks for a booking is the successful one, not the most
     recent row: once a duplicate charge is recorded (§19.7) the newest row is
     the DUPLICATE, and reading that made valid passes fail at the door. */
  function primaryPayment(db, bookingId) {
    const all = db.payments.filter(p => p.bookingId === bookingId);
    return all.find(p => p.status === 'SUCCESS')
      || all.find(p => p.status === 'NOT_APPLICABLE')
      || all.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  /* §17 · how much money actually reached us on this booking, and how much of
     it is already spoken for. A refund can never exceed the difference: a
     complimentary booking (unitPrice 0, nothing charged) used to refund the
     ₹259 launch fare because `unitPrice || FARE` treats a free seat as unset. */
  function moneyIn(db, bookingId) {
    return db.payments
      .filter(p => p.bookingId === bookingId && ['SUCCESS', 'DUPLICATE'].indexOf(p.status) >= 0)
      .reduce((n, p) => n + p.amount, 0);
  }
  function moneyOut(db, bookingId) {
    return db.refunds
      .filter(r => r.bookingId === bookingId && r.status !== 'REFUND_FAILED')
      .reduce((n, r) => n + r.amount, 0);
  }
  function unitPriceOf(b) { return b.unitPrice == null ? FARE : b.unitPrice; }
  function refundCap(db, bookingId) { return Math.max(0, moneyIn(db, bookingId) - moneyOut(db, bookingId)); }

  function tripView(db, tr) {
    const seats = db.tripSeats.filter(s => s.tripId === tr.id);
    const veh = db.vehicles.find(v => v.id === tr.vehicleId);
    const route = db.routes.find(r => r.id === tr.routeId);
    const available = seats.filter(s => s.status === 'AVAILABLE').length;
    const booked = seats.filter(s => s.status === 'BOOKED').length;
    return {
      id: tr.id, status: tr.status, price: tr.price,
      departureAt: tr.departureAt, reportingAt: tr.reportingAt,
      arrivalEstimateAt: tr.departureAt + tr.journeyMinutes * 60000,
      bookingOpenAt: tr.bookingOpenAt, bookingCloseAt: tr.bookingCloseAt,
      pickupPoint: tr.pickupPoint, notes: tr.notes || null,
      cancelledReason: tr.cancelledReason || null,
      vehicle: veh ? { id: veh.id, name: veh.name, registration: veh.registration, capacity: veh.capacity } : null,
      route: route ? { origin: route.origin, destination: route.destination,
        distanceKm: route.distanceKm, journeyMinutes: route.journeyMinutes,
        dropPoint: route.dropPoint } : null,
      capacity: seats.length, available, booked,
      staffUserIds: (tr.staffUserIds || []).slice(),
      assignedStaff: (tr.staffUserIds || []).map(id => {
        const u = db.users.find(u => u.id === id);
        return u ? { id: u.id, name: u.name } : null;
      }).filter(Boolean),
      soldOut: available === 0,
      revenue: booked * tr.price,
      bookable: tr.status === 'OPEN' && available > 0 && now() < tr.bookingCloseAt,
      waitlistCount: db.waitlist.filter(w => w.tripId === tr.id && w.status === 'WAITING').length,
    };
  }

  const trips = {
    /* §10 the next three upcoming eligible trips */
    listPublic(limit) {
      return read(db => db.trips
        .filter(t => ['OPEN', 'BOOKING_CLOSED'].indexOf(t.status) >= 0 && t.departureAt > now())
        .sort((a, b) => a.departureAt - b.departureAt)
        .slice(0, limit || 3)
        .map(t => tripView(db, t)));
    },
    listAll() {
      return read(db => db.trips.slice()
        .sort((a, b) => a.departureAt - b.departureAt).map(t => tripView(db, t)));
    },
    get(id) { return read(db => { const t = db.trips.find(t => t.id === id); return t ? tripView(db, t) : null; }); },
    seatMap(tripId) {
      const holder = holderId();
      return read(db => {
        const rows = {};
        db.tripSeats.filter(s => s.tripId === tripId).forEach(s => {
          rows[s.row] = rows[s.row] || {};
          const mine = s.status === 'HELD' && s.holdBy === holder;
          rows[s.row][s.seatNumber] = {
            id: s.id, seatNumber: s.seatNumber, seatType: s.seatType,
            status: mine ? 'SELECTED' : s.status,
            blockReason: s.blockReason || null,
            holdExpiresAt: mine ? s.holdExpiresAt : null,
          };
        });
        return Object.keys(rows).sort((a, b) => a - b).map(r => ({
          row: Number(r), seats: SEAT_COLS.map(c => rows[r][r + c]).filter(Boolean),
        }));
      });
    },
    myHeld(tripId) {
      const holder = holderId();
      return read(db => db.tripSeats
        .filter(s => s.tripId === tripId && s.status === 'HELD' && s.holdBy === holder)
        .sort((a, b) => a.row - b.row || a.position - b.position)
        .map(s => ({ seatNumber: s.seatNumber, seatType: s.seatType, holdExpiresAt: s.holdExpiresAt })));
    },
  };

  /* ---- seat holds (§13.2, §52) ---- */

  const seats = {
    /* Atomic within the store. Refuses anything not AVAILABLE, enforces the
       five-seat maximum, and refuses once booking has closed (§12.2). */
    hold(tripId, seatNumber) {
      const holder = holderId();
      return commit(db => {
        const tr = db.trips.find(t => t.id === tripId);
        if (!tr) throw new Error('Trip not found');
        if (tr.status !== 'OPEN') throw new Error('This departure is no longer open for booking');
        if (now() >= tr.bookingCloseAt) throw new Error('Booking has closed for this departure');
        const held = db.tripSeats.filter(s => s.tripId === tripId && s.status === 'HELD' && s.holdBy === holder);
        const seat = db.tripSeats.find(s => s.tripId === tripId && s.seatNumber === seatNumber);
        if (!seat) throw new Error('Seat not found');
        if (seat.status === 'HELD' && seat.holdBy === holder) {
          seat.status = 'AVAILABLE'; seat.holdBy = null; seat.holdExpiresAt = null;
          return { seatNumber, held: false };
        }
        if (seat.status !== 'AVAILABLE') {
          throw new Error('Seat ' + seatNumber + ' is ' + seat.status.toLowerCase() + ' and cannot be selected');
        }
        if (held.length >= MAX_PAX) throw new Error('A booking carries at most ' + MAX_PAX + ' passengers');
        /* one shared expiry per basket, set when the first seat is taken */
        const expires = held.length ? held[0].holdExpiresAt : now() + HOLD_MS;
        seat.status = 'HELD'; seat.holdBy = holder; seat.holdExpiresAt = expires;
        return { seatNumber, held: true, holdExpiresAt: expires };
      });
    },
    releaseMine(tripId) {
      const holder = holderId();
      return commit(db => {
        let n = 0;
        db.tripSeats.forEach(s => {
          if (s.tripId === tripId && s.status === 'HELD' && s.holdBy === holder) {
            s.status = 'AVAILABLE'; s.holdBy = null; s.holdExpiresAt = null; n++;
          }
        });
        return n;
      });
    },
  };

  /* ---- bookings (§12, §14, §15) ---- */

  const VALID = {
    name: (v) => String(v || '').trim().length >= 3,
    /* §14.2 + §57: the exact Student ID format is an OPEN DECISION in the
       documentation. We therefore validate presence and a permissive shape only,
       and surface the open question rather than inventing a rule. */
    studentId: (v) => /^[A-Za-z0-9\-\/]{4,20}$/.test(String(v || '').trim()),
    phone: (v) => /^[6-9]\d{9}$/.test(String(v || '').replace(/\s/g, '')),
  };

  const bookings = {
    validatePassenger(p) {
      return { name: VALID.name(p.name), studentId: VALID.studentId(p.studentId), phone: VALID.phone(p.phone) };
    },
    /* §12.2 revalidate everything, then create the booking in PAYMENT_PENDING.
       A booking only becomes CONFIRMED through payment reconciliation. */
    create({ tripId, passengers, contactPhone, idempotencyKey }) {
      const me = sessionUser();
      if (!me) throw denied('Sign in before paying');            // §7.2
      if (me.role !== 'STUDENT') throw denied('Only student accounts can book');
      return commit(db => {
        if (idempotencyKey && db.idem[idempotencyKey]) {         // §50 idempotency
          const prior = db.bookings.find(b => b.id === db.idem[idempotencyKey]);
          if (prior) return bookings._view(db, prior, me);
        }
        /* a flow begun anonymously finishes here, where §7.2 requires the account */
        adoptGuestHolds(db, me.id);
        const tr = db.trips.find(t => t.id === tripId);
        if (!tr) throw new Error('Trip not found');
        if (tr.status !== 'OPEN') throw new Error('This departure is no longer open');
        if (now() >= tr.bookingCloseAt) throw new Error('Booking has closed for this departure');
        const held = db.tripSeats.filter(s => s.tripId === tripId && s.status === 'HELD' && s.holdBy === me.id);
        if (!held.length) throw new Error('Your seat hold has expired. Choose seats again.');
        if (!passengers || passengers.length !== held.length)
          throw new Error('Enter details for every held seat');
        if (passengers.length > MAX_PAX) throw new Error('A booking carries at most ' + MAX_PAX + ' passengers');
        passengers.forEach(p => {
          const v = bookings.validatePassenger(p);
          if (!v.name || !v.studentId || !v.phone) throw new Error('Passenger details are incomplete');
          if (!held.some(s => s.seatNumber === p.seatNumber)) throw new Error('Seat ' + p.seatNumber + ' is not held by you');
        });
        if (!VALID.phone(contactPhone || me.phone)) throw new Error('Enter a valid booking contact number');

        const expires = held[0].holdExpiresAt;
        const b = {
          id: uid('b'), code: 'DLT-' + Math.floor(40000 + Math.random() * 9000),
          boardingCode: 'WX' + Math.floor(1000 + Math.random() * 8999),
          tripId, ownerId: me.id, status: 'PAYMENT_PENDING', bookingType: 'ONLINE',
          contactPhone: String(contactPhone || me.phone).replace(/\s/g, ''),
          totalAmount: held.length * tr.price, unitPrice: tr.price,
          createdAt: now(), updatedAt: now(), holdExpiresAt: expires,
        };
        db.bookings.push(b);
        passengers.forEach(p => {
          const seat = held.find(s => s.seatNumber === p.seatNumber);
          seat.bookingId = b.id;
          db.bookingPassengers.push({
            id: uid('bp'), bookingId: b.id, name: String(p.name).trim(),
            studentId: String(p.studentId).trim().toUpperCase(),
            phone: String(p.phone).replace(/\s/g, ''),
            tripSeatId: seat.id, seatNumber: seat.seatNumber, seatType: seat.seatType,
            boardingStatus: 'NOT_BOARDED',
          });
        });
        if (idempotencyKey) db.idem[idempotencyKey] = b.id;
        audit(db, actorRecord(db, me.id), 'booking.created', 'booking', b.id, null, b.code, null);
        return bookings._view(db, b, me);
      });
    },
    _view(db, b, viewer) {
      const tr = db.trips.find(t => t.id === b.tripId);
      const pax = db.bookingPassengers.filter(p => p.bookingId === b.id);
      const pay = primaryPayment(db, b.id);
      const refunds = db.refunds.filter(r => r.bookingId === b.id);
      const isOwner = viewer && viewer.id === b.ownerId;
      const staffView = viewer && viewer.role === 'BOARDING_STAFF';
      return {
        id: b.id, code: b.code, boardingCode: b.boardingCode, status: b.status,
        bookingType: b.bookingType, totalAmount: b.totalAmount,
        createdAt: b.createdAt, holdExpiresAt: b.holdExpiresAt,
        contactPhone: isOwner || (viewer && viewer.role !== 'BOARDING_STAFF') ? b.contactPhone : null,
        trip: tr ? tripView(db, tr) : null,
        owner: (function () { const u = db.users.find(u => u.id === b.ownerId); return u ? { id: u.id, name: u.name, studentId: u.studentId, email: u.email } : null; })(),
        passengers: pax.map(p => {
          const pass = db.passes.find(x => x.passengerId === p.id);
          const ev = db.boardingEvents.filter(e => e.passengerId === p.id).sort((a, b2) => b2.at - a.at)[0];
          return {
            id: p.id, name: p.name, studentId: p.studentId,
            /* §47 least privilege: boarding staff never sees the phone number */
            phone: staffView ? null : p.phone,
            seatNumber: p.seatNumber, seatType: p.seatType,
            boardingStatus: p.boardingStatus,
            boardedAt: ev && ev.result === 'VALID' ? ev.at : null,
            boardedBy: ev ? ev.staffName : null,
            boardingMethod: ev ? ev.method : null,
            boardingReason: ev ? ev.reason : null,
            passStatus: pass ? pass.status : 'NOT_ISSUED',
            qrToken: pass && isOwner ? pass.qrToken : (pass && viewer && viewer.role !== 'STUDENT' ? pass.qrToken : null),
          };
        }),
        payment: pay ? {
          id: pay.id, status: pay.status, amount: pay.amount, provider: pay.provider,
          providerReference: pay.providerReference, expectedAmount: pay.expectedAmount || null,
          createdAt: pay.createdAt, updatedAt: pay.updatedAt,
        } : null,
        refunds: refunds.map(r => ({ id: r.id, amount: r.amount, status: r.status, reason: r.reason,
          providerReference: r.providerReference, createdAt: r.createdAt, updatedAt: r.updatedAt })),
        refundedTotal: refunds.filter(r => r.status === 'REFUNDED').reduce((n, r) => n + r.amount, 0),
      };
    },
    get(id) {
      const me = sessionUser();
      return read(db => {
        const b = db.bookings.find(b => b.id === id || b.code === id);
        if (!b) return null;
        /* §15.1 owner sees the whole booking; admins see it by permission;
           a passenger who is not the owner sees only their own record */
        if (me && (me.id === b.ownerId || can(me.role, 'booking.read'))) return bookings._view(db, b, me);
        if (me) {
          const mine = db.bookingPassengers.filter(p => p.bookingId === b.id && p.studentId === me.studentId);
          if (mine.length) {
            const v = bookings._view(db, b, me);
            v.passengers = v.passengers.filter(p => p.studentId === me.studentId);
            v.payment = null; v.refunds = []; v.restricted = true;
            return v;
          }
        }
        throw denied('You do not have access to that booking');
      });
    },
    mine(filter) {
      const me = sessionUser();
      if (!me) return [];
      return read(db => {
        const bucket = (b) => {
          const tr = db.trips.find(t => t.id === b.tripId);
          if (['CANCELLED_BY_STUDENT', 'CANCELLED_BY_DLT'].indexOf(b.status) >= 0) {
            const refunded = db.refunds.some(r => r.bookingId === b.id && r.status === 'REFUNDED');
            return refunded ? 'Refunded' : 'Cancelled';
          }
          if (b.status === 'ABANDONED') return 'Cancelled';
          if (tr && (tr.status === 'COMPLETED' || tr.status === 'DEPARTED')) return 'Completed';
          return 'Upcoming';
        };
        return db.bookings
          .filter(b => b.ownerId === me.id && b.status !== 'ABANDONED')
          .map(b => Object.assign(bookings._view(db, b, me), { bucket: bucket(b) }))
          .filter(v => !filter || v.bucket === filter)
          .sort((a, b2) => (b2.trip ? b2.trip.departureAt : 0) - (a.trip ? a.trip.departureAt : 0));
      });
    },
    /* §14.3 the booking contact may be changed for this booking only */
    updateContact(bookingId, phone) {
      const me = sessionUser();
      if (!VALID.phone(phone)) throw new Error('Enter a valid Indian mobile number');
      return commit(db => {
        const b = db.bookings.find(b => b.id === bookingId);
        if (!b) throw new Error('Booking not found');
        if (!me || (me.id !== b.ownerId && !can(me.role, 'booking.cancel'))) throw denied('Not your booking');
        const before = b.contactPhone;
        b.contactPhone = String(phone).replace(/\s/g, ''); b.updatedAt = now();
        audit(db, actorRecord(db, me.id), 'booking.contact_changed', 'booking', b.id, before, b.contactPhone, 'This booking only');
        return bookings._view(db, b, me);
      });
    },
    /* §17.1 exact refund shown before confirmation */
    cancellationQuote(bookingId, passengerIds) {
      const me = sessionUser();
      return read(db => {
        const b = db.bookings.find(b => b.id === bookingId);
        if (!b) throw new Error('Booking not found');
        if (!me || (me.id !== b.ownerId && !can(me.role, 'booking.cancel'))) throw denied('Not your booking');
        const tr = db.trips.find(t => t.id === b.tripId);
        const all = db.bookingPassengers.filter(p => p.bookingId === b.id);
        const ids = passengerIds && passengerIds.length ? passengerIds : all.map(p => p.id);
        const seats = ids.length;
        const hoursOut = (tr.departureAt - now()) / 3600000;
        const refundable = (tr.departureAt - now()) >= REFUND_CUTOFF_MS || !!tr.majorChange;
        const cap = refundCap(db, b.id);
        const headline = seats * unitPriceOf(b);
        const amount = refundable ? Math.min(headline, cap) : 0;
        return {
          seats, hoursOut: Math.max(0, hoursOut),
          amount, refundable, whole: seats === all.length,
          reason: !refundable
            ? 'Less than 12 hours before departure, so the fare is not refundable.'
            : cap === 0
              ? 'Nothing was charged for this booking, so there is nothing to refund.'
              : (tr.majorChange ? 'A major change was made to this trip, so the fare refunds in full.'
                : 'More than 12 hours before departure, so the fare refunds in full.'),
          policy: 'FULL_REFUND_12H',
        };
      });
    },
    cancel(bookingId, passengerIds, reason) {
      const me = sessionUser();
      return commit(db => {
        const b = db.bookings.find(b => b.id === bookingId);
        if (!b) throw new Error('Booking not found');
        const adminActing = me && can(me.role, 'booking.cancel');
        if (!me || (me.id !== b.ownerId && !adminActing)) throw denied('Not your booking');
        if (adminActing && me.id !== b.ownerId && !reason) throw new Error('A cancellation reason is required'); // §17.2
        if (['CANCELLED_BY_STUDENT', 'CANCELLED_BY_DLT'].indexOf(b.status) >= 0)
          throw new Error('This booking is already cancelled');
        const tr = db.trips.find(t => t.id === b.tripId);
        const all = db.bookingPassengers.filter(p => p.bookingId === b.id);
        const ids = passengerIds && passengerIds.length ? passengerIds : all.map(p => p.id);
        const quote = (function () {
          const hoursOk = (tr.departureAt - now()) >= REFUND_CUTOFF_MS || !!tr.majorChange;
          const cap = refundCap(db, b.id);
          return { amount: hoursOk ? Math.min(ids.length * unitPriceOf(b), cap) : 0, refundable: hoursOk };
        })();

        ids.forEach(pid => {
          const p = all.find(p => p.id === pid);
          if (!p) return;
          const seat = db.tripSeats.find(s => s.id === p.tripSeatId);
          if (seat) { seat.status = 'AVAILABLE'; seat.bookingId = null; seat.holdBy = null; seat.holdExpiresAt = null; }
          p.boardingStatus = 'CANCELLED';
          const pass = db.passes.find(x => x.passengerId === p.id);
          if (pass) pass.status = 'VOID';                        // §23.2 QR stops scanning
        });

        const remaining = all.filter(p => ids.indexOf(p.id) < 0);
        if (!remaining.length) {
          b.status = adminActing && me.id !== b.ownerId ? 'CANCELLED_BY_DLT' : 'CANCELLED_BY_STUDENT';
        } else {
          b.totalAmount = remaining.length * unitPriceOf(b);
          /* §16 if the owner cancelled only their own seat another passenger owns it */
          const ownerRec = all.find(p => p.studentId === (db.users.find(u => u.id === b.ownerId) || {}).studentId);
          if (ownerRec && ids.indexOf(ownerRec.id) >= 0) {
            const heir = db.users.find(u => u.studentId === remaining[0].studentId);
            if (heir) {
              audit(db, actorRecord(db, me.id), 'booking.owner_changed', 'booking', b.id,
                b.ownerId, heir.id, 'Owner cancelled their own seat');
              b.ownerId = heir.id;
            }
          }
        }
        b.updatedAt = now();

        if (quote.amount > 0) {
          const pay = db.payments.find(p => p.bookingId === b.id && p.status === 'SUCCESS');
          const r = { id: uid('ref'), bookingId: b.id, paymentId: pay ? pay.id : null,
            amount: quote.amount, status: 'REFUND_PENDING',
            reason: reason || 'Student cancellation within policy',
            providerReference: null, createdAt: now(), updatedAt: now() };
          db.refunds.push(r);
          /* the acquirer settles refunds asynchronously, like the real one */
          db.providerEvents.push({ id: uid('pe'), kind: 'refund', refundId: r.id,
            outcome: 'REFUNDED', at: now() + 1500,
            providerReference: 'SBXR' + Math.floor(1e8 + Math.random() * 8e8) });
        }
        audit(db, actorRecord(db, me.id), 'booking.cancelled', 'booking', b.id, 'CONFIRMED', b.status,
          reason || 'Within refund policy');
        waitlistOffer(db, b.tripId);                             // §18 a released seat is offered on
        return { booking: bookings._view(db, b, me), refundAmount: quote.amount };
      });
    },
  };

  /* ---- payments (§19) ------------------------------------------------------
     The interface can create a payment intent and ASK for reconciliation.
     It cannot set a payment to SUCCESS: only applyProviderEvents can, and it
     only ever acts on an event the provider recorded. That keeps the documented
     rule intact — browser-side success is not payment truth (§19.1). */

  const provider = {
    label: 'Sandbox acquirer (stands in for Cashfree — no real money moves)',
    createOrder(paymentId, amount) {
      return commit(db => {
        const pay = db.payments.find(p => p.id === paymentId);
        if (!pay) throw new Error('Payment not found');
        pay.orderId = 'SBXORD' + Math.floor(1e9 + Math.random() * 8e9);
        pay.status = 'PENDING'; pay.updatedAt = now();
        return { orderId: pay.orderId, amount, currency: 'INR' };
      });
    },
    /* what the hosted checkout page reports back to the acquirer */
    settle(paymentId, outcome, amountPaid) {
      return commit(db => {
        const pay = db.payments.find(p => p.id === paymentId);
        if (!pay) throw new Error('Payment not found');
        db.providerEvents.push({
          id: uid('pe'), kind: 'payment', paymentId,
          outcome, amount: amountPaid == null ? pay.amount : amountPaid,
          providerReference: 'SBX' + Math.floor(5e8 + Math.random() * 4e8),
          at: now() + 900,               // a webhook is never instant
        });
        return true;
      });
    },
  };

  function applyProviderEvents(db) {
    let changed = false;
    db.providerEvents.forEach(ev => {
      if (ev.applied || ev.at > now()) return;
      ev.applied = true; changed = true;

      if (ev.kind === 'refund') {
        const r = db.refunds.find(r => r.id === ev.refundId);
        if (!r || r.status === 'REFUNDED') return;
        r.status = ev.outcome === 'REFUNDED' ? 'REFUNDED' : 'REFUND_FAILED';
        r.providerReference = ev.providerReference; r.updatedAt = now();
        audit(db, null, 'refund.' + r.status.toLowerCase(), 'refund', r.id, 'REFUND_PENDING', r.status, null);
        return;
      }

      const pay = db.payments.find(p => p.id === ev.paymentId);
      if (!pay || pay.status === 'SUCCESS') {
        /* §19.7 a second successful charge never confirms a second booking */
        if (pay && ev.outcome === 'PAID') {
          db.payments.push({ id: uid('pay'), bookingId: pay.bookingId, provider: pay.provider,
            providerReference: ev.providerReference, amount: ev.amount, currency: 'INR',
            status: 'DUPLICATE', duplicateOf: pay.id, createdAt: now(), updatedAt: now() });
          audit(db, null, 'payment.duplicate_detected', 'payment', pay.id, null, ev.providerReference,
            'Extra successful charge on a booking already paid');
        }
        return;
      }
      const b = db.bookings.find(b => b.id === pay.bookingId);

      if (ev.outcome === 'FAILED' || ev.outcome === 'ABANDONED') {
        pay.status = ev.outcome === 'FAILED' ? 'FAILED' : 'EXPIRED';
        pay.updatedAt = now();
        audit(db, null, 'payment.' + pay.status.toLowerCase(), 'payment', pay.id, 'PENDING', pay.status, null);
        return;   /* seats stay held until the hold expires — §19.6 */
      }

      if (ev.amount !== pay.amount) {
        /* §19.8 mismatch never confirms a booking; the payment is preserved */
        pay.status = 'DISCREPANCY'; pay.expectedAmount = pay.amount;
        pay.amount = ev.amount; pay.providerReference = ev.providerReference; pay.updatedAt = now();
        if (b) { b.status = 'PAYMENT_HELD'; b.updatedAt = now(); }
        audit(db, null, 'payment.discrepancy', 'payment', pay.id, pay.expectedAmount, ev.amount,
          'Amount received differs from amount due');
        return;
      }

      pay.status = 'SUCCESS'; pay.providerReference = ev.providerReference; pay.updatedAt = now();
      audit(db, null, 'payment.success', 'payment', pay.id, 'PENDING', 'SUCCESS', null);
      if (!b) return;
      /* §19.6 + §13.2 — the money is real, but the booking may no longer be.
         A settlement that arrives after the hold lapsed (or after the booking
         was cancelled) must NOT confirm it: the seat has been back on open sale
         since the sweep and may already belong to somebody else. Record the
         payment, raise the refund, and leave the booking closed. */
      const closed = ['ABANDONED', 'CANCELLED_BY_STUDENT', 'CANCELLED_BY_DLT'].indexOf(b.status) >= 0;
      if (closed) {
        const r = { id: uid('ref'), bookingId: b.id, paymentId: pay.id, amount: pay.amount,
          status: 'REFUND_PENDING', lateSettlement: true, providerReference: null,
          reason: b.status === 'ABANDONED'
            ? 'Payment verified after the seat hold expired and the booking was released — full refund due'
            : 'Payment verified after the booking was cancelled — full refund due',
          createdAt: now(), updatedAt: now() };
        db.refunds.push(r);
        db.providerEvents.push({ id: uid('pe'), kind: 'refund', refundId: r.id, outcome: 'REFUNDED',
          at: now() + 1500, providerReference: 'SBXR' + Math.floor(1e8 + Math.random() * 8e8) });
        audit(db, null, 'payment.late_settlement', 'payment', pay.id, b.status, 'REFUND_PENDING',
          'Money received after the booking was closed — seat not reissued');
        return;
      }
      finalizeBooking(db, b);
    });
    return changed;
  }

  /* §19.9 booking finalisation is separate from payment, and retried */
  function finalizeBooking(db, b) {
    try {
      if (b.status === 'CONFIRMED') return;
      const pax = db.bookingPassengers.filter(p => p.bookingId === b.id);
      pax.forEach(p => {
        const seat = db.tripSeats.find(s => s.id === p.tripSeatId);
        if (!seat) throw new Error('seat missing');
        /* the last line of defence against double allocation: only take a seat
           that is already ours, or one that is genuinely free */
        const ours = seat.bookingId === b.id;
        const free = seat.status === 'AVAILABLE' && !seat.bookingId;
        if (!ours && !free)
          throw new Error('Seat ' + p.seatNumber + ' was taken while the payment was being verified');
        seat.status = 'BOOKED'; seat.holdBy = null; seat.holdExpiresAt = null; seat.bookingId = b.id;
        if (!db.passes.some(x => x.passengerId === p.id)) {
          db.passes.push({ id: uid('pass'), passengerId: p.id, bookingId: b.id, tripId: b.tripId,
            boardingCode: b.boardingCode, qrToken: 'dlt.' + token(14), status: 'VALID', issuedAt: now() });
        }
      });
      b.status = 'CONFIRMED'; b.holdExpiresAt = null; b.confirmedAt = now(); b.updatedAt = now();
      /* §18.1 a claimed waitlist seat leaves the queue once it is paid for */
      db.waitlist.filter(w => w.tripId === b.tripId && w.userId === b.ownerId &&
        ['WAITING', 'CLAIM_OFFERED', 'CLAIMED'].indexOf(w.status) >= 0).forEach(w => {
          const before = w.status;
          w.status = 'CONVERTED'; w.claimExpiresAt = null;
          audit(db, null, 'waitlist.converted', 'waitlist', w.id, before, 'CONVERTED', 'Claimed seat booked and paid');
        });
      audit(db, null, 'booking.confirmed', 'booking', b.id, 'PAYMENT_PENDING', 'CONFIRMED', null);
    } catch (err) {
      b.status = 'BOOKING_PROCESSING'; b.finalizeError = String(err.message || err); b.updatedAt = now();
      audit(db, null, 'booking.finalize_failed', 'booking', b.id, null, b.finalizeError, null);
    }
  }

  const payments = {
    /* creates the intent only — never a result */
    createIntent(bookingId, idempotencyKey) {
      const me = sessionUser();
      if (!me) throw denied('Sign in before paying');
      return commit(db => {
        const b = db.bookings.find(b => b.id === bookingId);
        if (!b) throw new Error('Booking not found');
        if (b.ownerId !== me.id) throw denied('Not your booking');
        if (b.status === 'CONFIRMED') throw new Error('This booking is already confirmed');
        const tr = db.trips.find(t => t.id === b.tripId);
        const pax = db.bookingPassengers.filter(p => p.bookingId === b.id);
        const due = pax.length * tr.price;
        /* §12.2 · §52 — revalidate the amount against the live fare BEFORE reusing
           any open intent. This used to write the corrected total and then throw,
           which rolled the correction back and left the booking permanently
           unpayable: every retry produced the identical error and there was
           nothing the student could accept. It is now a decision, not a failure. */
        if (due !== b.totalAmount) {
          const from = b.totalAmount;
          b.totalAmount = due; b.unitPrice = tr.price;
          b.priceChanged = { from, to: due, at: now() }; b.updatedAt = now();
          db.payments.filter(p => p.bookingId === b.id && ['INITIATED', 'PENDING'].indexOf(p.status) >= 0)
            .forEach(p => { p.status = 'EXPIRED'; p.updatedAt = now(); });
          audit(db, actorRecord(db, me.id), 'booking.price_revalidated', 'booking', b.id, from, due,
            'Trip fare changed before payment');
          return { repriced: true, bookingId: b.id, amount: due, previousAmount: from };
        }
        if (b.priceChanged) {
          return { repriced: true, bookingId: b.id, amount: b.totalAmount, previousAmount: b.priceChanged.from };
        }
        const key = idempotencyKey || ('pay:' + bookingId);
        const existing = db.payments.find(p => p.idempotencyKey === key &&
          ['INITIATED', 'PENDING'].indexOf(p.status) >= 0);
        if (existing) return { id: existing.id, status: existing.status, amount: existing.amount };
        if (b.holdExpiresAt && b.holdExpiresAt <= now()) throw new Error('Your seat hold expired. Choose seats again.');
        const p = { id: uid('pay'), bookingId: b.id, provider: 'SANDBOX_CASHFREE', providerReference: null,
          amount: due, currency: 'INR', status: 'INITIATED', idempotencyKey: key,
          createdAt: now(), updatedAt: now() };
        db.payments.push(p);
        audit(db, actorRecord(db, me.id), 'payment.initiated', 'payment', p.id, null, due, null);
        return { id: p.id, status: p.status, amount: p.amount };
      });
    },
    /* the student accepts a revalidated fare; the next intent is allowed through */
    confirmReprice(bookingId) {
      const me = sessionUser();
      if (!me) throw denied('Sign in before paying');
      return commit(db => {
        const b = db.bookings.find(b => b.id === bookingId);
        if (!b) throw new Error('Booking not found');
        if (b.ownerId !== me.id) throw denied('Not your booking');
        if (!b.priceChanged) return { amount: b.totalAmount, accepted: true };
        const from = b.priceChanged.from;
        delete b.priceChanged;
        b.updatedAt = now();
        audit(db, actorRecord(db, me.id), 'booking.reprice_accepted', 'booking', b.id, from, b.totalAmount,
          'Student accepted the revalidated fare');
        return { amount: b.totalAmount, accepted: true };
      });
    },
    /* the only path by which a payment can reach a final state */
    reconcile(paymentId) {
      return commit(db => {
        applyProviderEvents(db);
        const p = paymentId ? db.payments.find(p => p.id === paymentId) : null;
        if (p && p.status === 'SUCCESS') {
          const b = db.bookings.find(b => b.id === p.bookingId);
          if (b && b.status === 'BOOKING_PROCESSING') finalizeBooking(db, b);   // retry §19.9
        }
        return p ? { id: p.id, status: p.status, amount: p.amount, providerReference: p.providerReference } : null;
      });
    },
    get(id) { return read(db => db.payments.find(p => p.id === id) || null); },
    receipt(bookingId) {
      const me = sessionUser();
      return read(db => {
        const b = db.bookings.find(b => b.id === bookingId || b.code === bookingId);
        if (!b) return null;
        if (!me || (me.id !== b.ownerId && !can(me.role, 'booking.read'))) throw denied('Not your booking');
        const pay = db.payments.filter(p => p.bookingId === b.id && p.status === 'SUCCESS')[0]
          || db.payments.filter(p => p.bookingId === b.id)[0] || null;
        const refunds = db.refunds.filter(r => r.bookingId === b.id);
        const pax = db.bookingPassengers.filter(p => p.bookingId === b.id);
        return {                                                  /* §21 basic receipt */
          bookingCode: b.code, issuedAt: b.createdAt,
          status: b.status, amount: b.totalAmount,
          unitPrice: b.unitPrice || FARE, seats: pax.map(p => p.seatNumber),
          paidAt: pay ? pay.updatedAt : null, paymentStatus: pay ? pay.status : 'NONE',
          provider: pay ? pay.provider : null, providerReference: pay ? pay.providerReference : null,
          refunds: refunds.map(r => ({ amount: r.amount, status: r.status, at: r.updatedAt, reference: r.providerReference })),
          note: 'V1 receipt. Not a GST invoice (Master §21).',
        };
      });
    },
  };

  /* ---- passes, QR and boarding (§22–25) ---- */

  /* §Boarding 5 — Boarding Staff work an ASSIGNED trip. Without a real
     assignment the scanner had to guess which trip was being boarded, and staff
     could not be scoped to anything. The assignment lives on the trip; the
     scanner and the manifest derive from it and cannot be talked out of it by
     anything the client sends. */
  function assignedTripFor(db, userId) {
    const order = { BOARDING: 0, BOOKING_CLOSED: 1, OPEN: 2, DEPARTED: 3, COMPLETED: 4 };
    const mine = db.trips.filter(t => (t.staffUserIds || []).indexOf(userId) >= 0 &&
      ['BOARDING', 'BOOKING_CLOSED', 'OPEN', 'DEPARTED'].indexOf(t.status) >= 0);
    if (!mine.length) return null;
    mine.sort((a, b) => (order[a.status] - order[b.status]) || (a.departureAt - b.departureAt));
    return mine[0];
  }

  const boarding = {
    /* the trip this staff member is working, decided by the store */
    assignedTrip() {
      const me = sessionUser();
      if (!me) return null;
      return read(db => {
        if (me.role !== 'BOARDING_STAFF') return null;
        const t = assignedTripFor(db, me.id);
        return t ? tripView(db, t) : null;
      });
    },
    passesFor(bookingId) {
      const me = sessionUser();
      return read(db => {
        const b = db.bookings.find(b => b.id === bookingId || b.code === bookingId);
        if (!b) return [];
        const owner = me && me.id === b.ownerId;
        if (!owner && !(me && can(me.role, 'boarding.read'))) {
          const mine = db.bookingPassengers.filter(p => p.bookingId === b.id && me && p.studentId === me.studentId);
          if (!mine.length) throw denied('You do not have access to those passes');
        }
        const tr = db.trips.find(t => t.id === b.tripId);
        const veh = db.vehicles.find(v => v.id === tr.vehicleId);
        const pay = primaryPayment(db, b.id);
        return db.bookingPassengers.filter(p => p.bookingId === b.id)
          .filter(p => owner || (me && can(me.role, 'boarding.read')) || p.studentId === (me || {}).studentId)
          .map(p => {
            const pass = db.passes.find(x => x.passengerId === p.id);
            return {
              passengerId: p.id, name: p.name, studentId: p.studentId,
              seatNumber: p.seatNumber, seatType: p.seatType,
              bookingCode: b.code, boardingCode: b.boardingCode,
              qrToken: pass ? pass.qrToken : null,
              passStatus: pass ? pass.status : 'NOT_ISSUED',
              boardingStatus: p.boardingStatus,
              paymentStatus: pay ? pay.status : 'NONE',
              tripStatus: tr.status,
              departureAt: tr.departureAt, reportingAt: tr.reportingAt,
              pickupPoint: tr.pickupPoint, route: 'Woxsen to Miyapur',
              vehicle: veh ? veh.name + ' · ' + veh.registration : null,
              fareShare: b.unitPrice || FARE, total: b.totalAmount,
            };
          });
      });
    },
    manifest(tripId) {
      const me = sessionUser();
      assert(me, 'boarding.read');
      return read(db => {
        if (me.role === 'BOARDING_STAFF') {
          const mine = assignedTripFor(db, me.id);
          if (!mine) throw denied('You are not assigned to a trip. Operations assigns boarding staff to a departure.');
          if (tripId && tripId !== mine.id) throw denied('You are assigned to ' + fmtWhen(mine.departureAt) + ', not that trip.');
          tripId = mine.id;
        }
        const rows = [];
        db.bookings.filter(b => b.tripId === tripId &&
          ['CONFIRMED', 'PAYMENT_HELD', 'BOOKING_PROCESSING'].indexOf(b.status) >= 0)
          .forEach(b => {
            db.bookingPassengers.filter(p => p.bookingId === b.id).forEach(p => {
              const ev = db.boardingEvents.filter(e => e.passengerId === p.id && e.result === 'VALID')
                .sort((a, c) => c.at - a.at)[0];
              rows.push({
                passengerId: p.id, name: p.name, studentId: p.studentId,
                phone: me.role === 'BOARDING_STAFF' ? null : p.phone,    // §25, §47
                seatNumber: p.seatNumber, seatType: p.seatType,
                bookingCode: b.code, bookingStatus: b.status,
                boardingStatus: p.boardingStatus,
                boardedAt: ev ? ev.at : null, boardedBy: ev ? ev.staffName : null,
                method: ev ? ev.method : null, reason: ev ? ev.reason : null,
              });
            });
          });
        return rows.sort((a, b) => (a.seatNumber > b.seatNumber ? 1 : -1));
      });
    },
    /* §23.1 every documented check, server-side, idempotent (§50).

       ONE validation chain, whatever the door used to identify the passenger.
       `code` may be a QR token, a boarding code or a booking code (§Boarding 6:
       the documented fallback when a QR will not scan). Resolution happens
       first and yields a pass; from there every check below is identical, so
       there is no second, weaker path for hand-typed codes. Where a code
       identifies a booking carrying several passengers the store refuses to
       guess and returns CHOOSE with the manifest rows for that booking. */
    scan(code, tripId, passengerId) {
      const me = sessionUser();
      assert(me, 'boarding.scan');
      return commit(db => {
        /* staff scan their assigned trip whatever the client asks for */
        if (me.role === 'BOARDING_STAFF') {
          const mine = assignedTripFor(db, me.id);
          if (!mine) throw denied('You are not assigned to a trip. Operations assigns boarding staff to a departure.');
          tripId = mine.id;
        }
        const raw = String(code == null ? '' : code).trim();
        const record = (result, detail, passengerId2, reason, method) => {
          db.boardingEvents.push({ id: uid('be'), passengerId: passengerId2 || null, tripId,
            staffUserId: me.id, staffName: me.name, result, method: method || 'SCAN', at: now(),
            reason: reason || null, token: raw.slice(0, 24) });
          return { result, detail };
        };

        /* ---- resolution ---- */
        let pass = db.passes.find(p => p.qrToken === raw);
        let method = 'SCAN';
        if (!pass) {
          const key = raw.toUpperCase().replace(/\s+/g, '');
          const byCode = db.bookings.filter(b =>
            String(b.boardingCode || '').toUpperCase() === key ||
            String(b.code || '').toUpperCase() === key);
          if (byCode.length) {
            method = 'CODE';
            const b0 = byCode[0];
            const pax = db.bookingPassengers.filter(p => p.bookingId === b0.id);
            let chosen = null;
            if (passengerId) chosen = pax.find(p => p.id === passengerId) || null;
            else if (pax.length === 1) chosen = pax[0];
            else if (pax.length > 1) {
              /* never guess which of several travellers is at the door */
              return { result: 'CHOOSE', detail: b0.code + ' carries ' + pax.length +
                ' passengers. Choose who is boarding.',
                bookingCode: b0.code,
                passengers: pax.map(p => ({ id: p.id, name: p.name, seatNumber: p.seatNumber,
                  studentId: p.studentId, boardingStatus: p.boardingStatus })) };
            }
            if (!chosen) return record('INVALID', 'No passenger on ' + b0.code + ' matches that choice.', null, 'passenger not on booking', 'CODE');
            pass = db.passes.find(p => p.passengerId === chosen.id);
            if (!pass) return record('INVALID', 'No boarding pass has been issued for ' + chosen.name + ' yet.', chosen.id, 'pass not issued', 'CODE');
          }
        }
        if (!pass) return record('INVALID', 'This code is not a DLT boarding pass, boarding code or booking ID.', null, null, method);
        const p = db.bookingPassengers.find(x => x.id === pass.passengerId);
        const b = db.bookings.find(x => x.id === pass.bookingId);
        const tr = db.trips.find(t => t.id === pass.tripId);
        if (!p || !b || !tr) return record('INVALID', 'The booking behind this pass no longer exists.', null, null, method);
        if (me.role === 'BOARDING_STAFF' && tripId !== pass.tripId) {
          return record('INVALID', 'This pass belongs to ' + fmtWhen(tr.departureAt) + ', not the trip you are boarding.', p.id, 'wrong trip', method);
        }
        if (tripId && tripId !== pass.tripId)
          return record('INVALID', 'Wrong trip: this pass is for ' + fmtWhen(tr.departureAt) + '.', p.id, 'wrong trip', method);
        if (['CANCELLED_BY_STUDENT', 'CANCELLED_BY_DLT'].indexOf(b.status) >= 0)
          return record('INVALID', 'Booking ' + b.code + ' is cancelled.', p.id, 'cancelled booking', method);
        if (pass.status === 'VOID')
          return record('INVALID', 'This pass has been voided.', p.id, 'void pass', method);
        if (db.refunds.some(r => r.bookingId === b.id && r.status === 'REFUNDED' && p.boardingStatus === 'CANCELLED'))
          return record('INVALID', 'This seat was refunded.', p.id, 'refunded', method);
        const pay = primaryPayment(db, b.id);
        if (!pay || ['SUCCESS', 'NOT_APPLICABLE'].indexOf(pay.status) < 0)
          return record('INVALID', 'Payment for ' + b.code + ' is ' + (pay ? pay.status.toLowerCase() : 'missing') + '.', p.id, 'payment not successful', method);
        if (tr.status === 'COMPLETED')
          return record('INVALID', 'That journey is already complete.', p.id, 'completed journey', method);
        if (p.boardingStatus === 'BOARDED') {
          const ev = db.boardingEvents.filter(e => e.passengerId === p.id && e.result === 'VALID').sort((a, c) => c.at - a.at)[0];
          return record('ALREADY BOARDED', p.name + ' · seat ' + p.seatNumber + ' boarded at ' + fmtTime(ev ? ev.at : now()) + '.', p.id, 'second scan', method);
        }
        if (p.boardingStatus === 'DENIED_BOARDING')
          return record('INVALID', p.name + ' was denied boarding.', p.id, 'denied boarding', method);
        p.boardingStatus = 'BOARDED';
        const out = record('VALID', p.name + ' · seat ' + p.seatNumber + ' · ' + p.seatType.toLowerCase(), p.id, null, method);
        audit(db, actorRecord(db, me.id), method === 'CODE' ? 'boarding.code_entry' : 'boarding.scanned',
          'passenger', p.id, 'NOT_BOARDED', 'BOARDED', method === 'CODE' ? 'Boarded by ' + raw.toUpperCase() : null);
        out.passenger = { name: p.name, seatNumber: p.seatNumber, seatType: p.seatType,
          studentId: p.studentId, bookingCode: b.code, boardedAt: now() };
        return out;
      });
    },
    /* §24.3 manual boarding: Ops and Super only, reason mandatory, audited */
    manual(passengerId, reason) {
      const me = sessionUser();
      assert(me, 'boarding.manual');
      if (!reason || String(reason).trim().length < 4) throw new Error('A reason is required for manual boarding');
      return commit(db => {
        const p = db.bookingPassengers.find(x => x.id === passengerId);
        if (!p) throw new Error('Passenger not found');
        if (p.boardingStatus === 'BOARDED') throw new Error(p.name + ' has already boarded');
        const b = db.bookings.find(x => x.id === p.bookingId);
        p.boardingStatus = 'BOARDED';
        db.boardingEvents.push({ id: uid('be'), passengerId: p.id, tripId: b.tripId,
          staffUserId: me.id, staffName: me.name, result: 'VALID', method: 'MANUAL',
          at: now(), reason: String(reason).trim() });
        audit(db, actorRecord(db, me.id), 'boarding.manual', 'passenger', p.id, 'NOT_BOARDED', 'BOARDED', String(reason).trim());
        return { name: p.name, seatNumber: p.seatNumber, at: now() };
      });
    },
    /* §25.2 a distinct state, not a cancellation */
    deny(passengerId, reason) {
      const me = sessionUser();
      assert(me, 'boarding.deny');
      if (!reason || String(reason).trim().length < 4) throw new Error('A reason is required to deny boarding');
      return commit(db => {
        const p = db.bookingPassengers.find(x => x.id === passengerId);
        if (!p) throw new Error('Passenger not found');
        const b = db.bookings.find(x => x.id === p.bookingId);
        const before = p.boardingStatus;
        p.boardingStatus = 'DENIED_BOARDING';
        const pass = db.passes.find(x => x.passengerId === p.id);
        if (pass) pass.status = 'VOID';
        db.boardingEvents.push({ id: uid('be'), passengerId: p.id, tripId: b.tripId,
          staffUserId: me.id, staffName: me.name, result: 'DENIED', method: 'MANUAL',
          at: now(), reason: String(reason).trim() });
        audit(db, actorRecord(db, me.id), 'boarding.denied', 'passenger', p.id, before, 'DENIED_BOARDING', String(reason).trim());
        return { name: p.name };
      });
    },
    /* §25.1 admin confirms the final no-show; no automatic refund */
    confirmNoShow(passengerId, reason) {
      const me = sessionUser();
      assert(me, 'boarding.noshow');
      return commit(db => {
        const p = db.bookingPassengers.find(x => x.id === passengerId);
        if (!p) throw new Error('Passenger not found');
        if (p.boardingStatus !== 'POTENTIAL_NO_SHOW')
          throw new Error(p.name + ' is not marked as a potential no-show');
        p.boardingStatus = 'NO_SHOW';
        audit(db, actorRecord(db, me.id), 'boarding.no_show_confirmed', 'passenger', p.id,
          'POTENTIAL_NO_SHOW', 'NO_SHOW', reason || 'Confirmed after departure — no refund');
        return { name: p.name };
      });
    },
  };

  /* ---- waitlist (§18) ---- */

  /* §18.1 — an offer is a RESERVATION, not a notification. The released seat is
     held for the offered student for the whole claim window, so the thing they
     are told they can claim cannot be sold to somebody else while they claim it.
     When the window lapses the hold sweep frees the seat and the entry expires,
     and sweep re-offers it to the next student in line. */
  function waitlistOffer(db, tripId) {
    const queue = db.waitlist.filter(w => w.tripId === tripId && w.status === 'WAITING')
      .sort((a, b) => a.priority - b.priority || a.joinedAt - b.joinedAt);
    if (!queue.length) return;
    const free = db.tripSeats.filter(s => s.tripId === tripId && s.status === 'AVAILABLE')
      .sort((a, b) => a.row - b.row || a.position - b.position);
    for (let i = 0; i < queue.length && i < free.length; i++) {
      const w = queue[i], seat = free[i];
      w.status = 'CLAIM_OFFERED';
      w.claimExpiresAt = now() + CLAIM_MS;
      w.reservedSeat = seat.seatNumber;
      seat.status = 'HELD'; seat.holdBy = w.userId; seat.holdExpiresAt = w.claimExpiresAt;
      seat.waitlistId = w.id;
      audit(db, null, 'waitlist.claim_offered', 'waitlist', w.id, 'WAITING', 'CLAIM_OFFERED',
        'Seat ' + seat.seatNumber + ' reserved for 30 minutes');
    }
  }

  const waitlist = {
    join(tripId) {
      const me = sessionUser();
      if (!me) throw denied('Sign in to join the waitlist');
      return commit(db => {
        const existing = db.waitlist.find(w => w.tripId === tripId && w.userId === me.id &&
          ['WAITING', 'CLAIM_OFFERED'].indexOf(w.status) >= 0);
        if (existing) return waitlist._view(db, existing);
        const max = db.waitlist.filter(w => w.tripId === tripId).length;
        const w = { id: uid('wl'), tripId, userId: me.id, priority: max + 1,
          joinedAt: now(), claimExpiresAt: null, status: 'WAITING' };
        db.waitlist.push(w);
        audit(db, actorRecord(db, me.id), 'waitlist.joined', 'waitlist', w.id, null, 'WAITING', null);
        waitlistOffer(db, tripId);
        return waitlist._view(db, w);
      });
    },
    _view(db, w) {
      const ahead = db.waitlist.filter(x => x.tripId === w.tripId && x.status === 'WAITING' &&
        (x.priority < w.priority)).length;
      return { id: w.id, tripId: w.tripId, status: w.status, position: ahead + 1,
        reservedSeat: w.reservedSeat || null,
        claimExpiresAt: w.claimExpiresAt, joinedAt: w.joinedAt };
    },
    /* §18.1 the student takes up the offer: the reserved seat becomes a normal
       hold on their basket and they finish through the ordinary booking flow. */
    claim(entryId) {
      const me = sessionUser();
      if (!me) throw denied('Sign in to claim your seat');
      return commit(db => {
        const w = db.waitlist.find(w => w.id === entryId);
        if (!w) throw new Error('Waitlist entry not found');
        if (w.userId !== me.id) throw denied('That offer belongs to another student');
        if (['CLAIM_OFFERED', 'CLAIMED'].indexOf(w.status) < 0)
          throw new Error(w.status === 'CLAIM_EXPIRED'
            ? 'That claim window has closed and the seat has passed to the next student.'
            : 'There is no seat offered to you on this trip right now.');
        if (!w.claimExpiresAt || w.claimExpiresAt <= now())
          throw new Error('That claim window has closed and the seat has passed to the next student.');
        const seat = db.tripSeats.find(s => s.tripId === w.tripId && s.seatNumber === w.reservedSeat);
        if (!seat || seat.status === 'BOOKED' || (seat.holdBy && seat.holdBy !== me.id))
          throw new Error('The seat reserved for you is no longer available. You are still on the list.');
        seat.status = 'HELD'; seat.holdBy = me.id; seat.holdExpiresAt = w.claimExpiresAt;
        if (w.status !== 'CLAIMED') {
          w.status = 'CLAIMED';
          audit(db, actorRecord(db, me.id), 'waitlist.claimed', 'waitlist', w.id, 'CLAIM_OFFERED', 'CLAIMED',
            'Seat ' + seat.seatNumber + ' claimed');
        }
        return { tripId: w.tripId, seatNumbers: [seat.seatNumber], claimExpiresAt: w.claimExpiresAt };
      });
    },
    /* giving up an offer early passes the seat on immediately */
    decline(entryId) {
      const me = sessionUser();
      if (!me) throw denied('Sign in required');
      return commit(db => {
        const w = db.waitlist.find(w => w.id === entryId);
        if (!w || w.userId !== me.id) throw denied('That offer belongs to another student');
        const before = w.status;
        const seat = db.tripSeats.find(s => s.tripId === w.tripId && s.seatNumber === w.reservedSeat &&
          s.status === 'HELD' && s.holdBy === me.id);
        if (seat) { seat.status = 'AVAILABLE'; seat.holdBy = null; seat.holdExpiresAt = null; seat.waitlistId = null; }
        w.status = 'CLAIM_DECLINED'; w.claimExpiresAt = null;
        audit(db, actorRecord(db, me.id), 'waitlist.declined', 'waitlist', w.id, before, 'CLAIM_DECLINED', null);
        waitlistOffer(db, w.tripId);
        return true;
      });
    },
    mine() {
      const me = sessionUser();
      if (!me) return [];
      return read(db => db.waitlist.filter(w => w.userId === me.id &&
        ['WAITING', 'CLAIM_OFFERED', 'CLAIMED'].indexOf(w.status) >= 0).map(w => waitlist._view(db, w)));
    },
    forTrip(tripId) {
      const me = sessionUser();
      assert(me, 'waitlist.read');
      return read(db => db.waitlist.filter(w => w.tripId === tripId)
        .sort((a, b) => a.priority - b.priority)
        .map(w => {
          const u = db.users.find(u => u.id === w.userId);
          return Object.assign(waitlist._view(db, w),
            { student: u ? u.name : 'Unknown', studentId: u ? u.studentId : null, email: u ? u.email : null });
        }));
    },
    /* §18.2 manual reorder keeps the original join time and needs a reason */
    reorder(entryId, newPriority, reason) {
      const me = sessionUser();
      assert(me, 'waitlist.reorder');
      if (!reason) throw new Error('A reason is required to reorder the waitlist');
      return commit(db => {
        const w = db.waitlist.find(w => w.id === entryId);
        if (!w) throw new Error('Waitlist entry not found');
        const before = w.priority;
        w.priority = Math.max(1, Number(newPriority) || 1);
        audit(db, actorRecord(db, me.id), 'waitlist.reordered', 'waitlist', w.id, before, w.priority, reason);
        return waitlist._view(db, w);
      });
    },
  };

  /* ---- reviews (§31) ---- */

  const reviews = {
    canRate(bookingId) {
      const me = sessionUser();
      if (!me) return { allowed: false, reason: 'Sign in to rate a trip' };
      return read(db => {
        const b = db.bookings.find(b => b.id === bookingId);
        if (!b || b.ownerId !== me.id) return { allowed: false, reason: 'Not your booking' };
        const tr = db.trips.find(t => t.id === b.tripId);
        const windowEnd = tr.departureAt + tr.journeyMinutes * 60000;
        if (now() < windowEnd) return { allowed: false, reason: 'Rating opens when the journey is complete' };
        if (db.reviews.some(r => r.bookingId === b.id)) return { allowed: false, reason: 'You have already rated this trip' };
        return { allowed: true };
      });
    },
    submit(bookingId, rating, feedback) {
      const me = sessionUser();
      if (!me) throw denied('Sign in required');
      const r = Number(rating);
      if (!(r >= 1 && r <= 5)) throw new Error('Choose between one and five stars');
      return commit(db => {
        const b = db.bookings.find(b => b.id === bookingId);
        if (!b || b.ownerId !== me.id) throw denied('Not your booking');
        const tr = db.trips.find(t => t.id === b.tripId);
        if (now() < tr.departureAt + tr.journeyMinutes * 60000)
          throw new Error('Rating opens once the journey is complete');
        if (db.reviews.some(x => x.bookingId === b.id)) throw new Error('You have already rated this trip');
        const rev = { id: uid('rev'), tripId: b.tripId, bookingId: b.id, userId: me.id,
          rating: r, feedback: (feedback || '').trim() || null, status: 'VISIBLE',
          adminResponse: null, createdAt: now() };
        db.reviews.push(rev);
        audit(db, actorRecord(db, me.id), 'review.submitted', 'review', rev.id, null, r, null);
        return rev;
      });
    },
    list() {
      const me = sessionUser();
      assert(me, 'feedback.read');
      return read(db => db.reviews.slice().sort((a, b) => b.createdAt - a.createdAt).map(r => {
        const u = db.users.find(u => u.id === r.userId);
        const tr = db.trips.find(t => t.id === r.tripId);
        return { id: r.id, rating: r.rating, feedback: r.feedback, status: r.status,
          adminResponse: r.adminResponse, createdAt: r.createdAt,
          student: u ? u.name : 'Unknown', trip: tr ? fmtWhen(tr.departureAt) : null };
      }));
    },
    moderate(id, action, text) {
      const me = sessionUser();
      assert(me, 'feedback.moderate');
      return commit(db => {
        const r = db.reviews.find(r => r.id === id);
        if (!r) throw new Error('Review not found');
        const before = r.status;
        if (action === 'hide') r.status = 'HIDDEN';
        else if (action === 'show') r.status = 'VISIBLE';
        else if (action === 'resolve') r.status = 'RESOLVED';
        else if (action === 'respond') { r.adminResponse = (text || '').trim(); r.status = 'RESOLVED'; }
        audit(db, actorRecord(db, me.id), 'review.' + action, 'review', r.id, before, r.status, text || null);
        return r;
      });
    },
  };

  /* ---- notifications (§32) ---- */

  const notifications = {
    requestNotify({ channel, contact, tripId }) {
      const me = sessionUser();
      return commit(db => {
        const rec = { id: uid('nr'), kind: 'GET_NOTIFIED', userId: me ? me.id : null,
          channel: channel || 'WHATSAPP',
          contact: contact || (me ? (channel === 'EMAIL' ? me.email : me.phone) : null),
          tripId: tripId || null, routeId: 'r_wox_miy', status: 'PENDING', requestedAt: now() };
        if (!rec.contact) throw new Error('Enter a WhatsApp number or email so we can reach you');
        db.notifications.push(rec);
        audit(db, me ? actorRecord(db, me.id) : null, 'notification.requested', 'notification', rec.id, null, rec.channel, null);
        return rec;
      });
    },
    list() {
      const me = sessionUser();
      assert(me, 'notification.read');
      return read(db => db.notifications.slice().sort((a, b) => b.requestedAt - a.requestedAt).map(n => {
        const u = n.userId ? db.users.find(u => u.id === n.userId) : null;
        return Object.assign({}, n, { student: u ? u.name : 'Not signed in', studentId: u ? u.studentId : null });
      }));
    },
    markNotified(id) {
      const me = sessionUser();
      assert(me, 'notification.read');
      return commit(db => {
        const n = db.notifications.find(n => n.id === id);
        if (!n) throw new Error('Request not found');
        n.status = 'NOTIFIED'; n.notifiedAt = now();
        audit(db, actorRecord(db, me.id), 'notification.marked_notified', 'notification', n.id, 'PENDING', 'NOTIFIED', null);
        return n;
      });
    },
    /* §8.1 / §8.3 — the two requests that change or close an account are decided
       here, with a mandatory reason, and nowhere else. Approving an ID change is
       the only path by which a protected identity field moves; approving a
       deletion anonymises the person and keeps every operational and financial
       record, as Security §5 requires. */
    resolveRequest(id, decision, reason) {
      const me = sessionUser();
      assert(me, 'notification.resolve');
      if (['approve', 'reject'].indexOf(decision) < 0) throw new Error('Choose approve or reject');
      if (!reason || String(reason).trim().length < 4) throw new Error('A reason is required to decide a request');
      return commit(db => {
        const n = db.notifications.find(n => n.id === id);
        if (!n) throw new Error('Request not found');
        if (n.status !== 'PENDING') throw new Error('That request has already been decided');
        if (['STUDENT_ID_CHANGE', 'ACCOUNT_DELETION'].indexOf(n.kind) < 0)
          throw new Error('That request kind is not decided here');
        const u = db.users.find(u => u.id === n.userId);
        if (!u) throw new Error('The account behind this request no longer exists');
        const before = n.status;
        n.status = decision === 'approve' ? 'APPROVED' : 'REJECTED';
        n.decidedAt = now(); n.decidedBy = me.id; n.decisionReason = String(reason).trim();

        if (decision === 'approve' && n.kind === 'STUDENT_ID_CHANGE') {
          const old = u.studentId;
          u.studentId = n.requested;
          audit(db, actorRecord(db, me.id), 'student.id_change_approved', 'user', u.id, old, u.studentId, n.decisionReason);
        }
        if (decision === 'approve' && n.kind === 'ACCOUNT_DELETION') {
          const wasEmail = u.email;
          u.status = 'DELETED';
          u.name = 'Deleted student';
          u.email = 'deleted+' + u.id + '@dlt.invalid';
          u.phone = null;
          u.emergencyContact = null;
          u.passwordHash = token(32); u.passwordSalt = token(16);
          db.sessions = db.sessions.filter(s => s.userId !== u.id);
          audit(db, actorRecord(db, me.id), 'account.deletion_approved', 'user', u.id, wasEmail,
            'anonymised — bookings, payments and boarding records retained', n.decisionReason);
        }
        if (decision === 'reject') {
          audit(db, actorRecord(db, me.id), n.kind === 'ACCOUNT_DELETION'
            ? 'account.deletion_rejected' : 'student.id_change_rejected',
            'user', u.id, before, 'REJECTED', n.decisionReason);
        }
        return { id: n.id, kind: n.kind, status: n.status, student: u.name };
      });
    },
    /* §17.3 the ready-to-send message an admin copies into WhatsApp */
    template(tripId) {
      const me = sessionUser();
      assert(me, 'trip.cancel');
      return read(db => {
        const tr = db.trips.find(t => t.id === tripId);
        const affected = [];
        db.bookings.filter(b => b.tripId === tripId).forEach(b => {
          const u = db.users.find(u => u.id === b.ownerId);
          db.bookingPassengers.filter(p => p.bookingId === b.id).forEach(p => affected.push({
            name: p.name, phone: p.phone, seat: p.seatNumber, booking: b.code, owner: u ? u.name : null,
          }));
        });
        return {
          affected,
          message: 'DLT: the ' + fmtWhen(tr.departureAt) + ' Woxsen to Miyapur departure has been cancelled'
            + (tr.cancelledReason ? ' (' + tr.cancelledReason + ')' : '')
            + '. Your full fare is being refunded to the original payment method and normally lands within 3 to 5 working days. '
            + 'Your boarding passes for this trip no longer scan. You can rebook any open departure on the DLT site.',
        };
      });
    },
  };

  /* ---- admin: vehicles, trips, seat blocking, reports (§26, §11, §41, §42) ---- */

  const admin = {
    can(action) { const me = sessionUser(); return !!me && can(me.role, action); },
    role() { const me = sessionUser(); return me ? me.role : null; },

    vehicles() {
      const me = sessionUser(); assert(me, 'vehicle.read');
      return read(db => db.vehicles.map(v => {
        const assigned = db.trips.filter(t => t.vehicleId === v.id &&
          ['OPEN', 'BOOKING_CLOSED', 'BOARDING', 'DRAFT'].indexOf(t.status) >= 0);
        return Object.assign({}, v, { assignedTrips: assigned.length,
          nextTripAt: assigned.length ? Math.min.apply(null, assigned.map(t => t.departureAt)) : null });
      }));
    },
    saveVehicle(patch) {
      const me = sessionUser(); assert(me, 'vehicle.write');
      return commit(db => {
        let v = patch.id ? db.vehicles.find(v => v.id === patch.id) : null;
        const before = v ? clone(v) : null;
        if (!v) {
          v = { id: uid('v'), createdAt: now(), status: 'AVAILABLE', rowCount: 11 };
          db.vehicles.push(v);
        }
        if (patch.name != null) v.name = String(patch.name).trim();
        if (patch.registration != null) v.registration = String(patch.registration).trim().toUpperCase();
        if (patch.rowCount != null) {
          const rows = Math.max(4, Math.min(20, Number(patch.rowCount)));
          const inUse = db.trips.some(t => t.vehicleId === v.id &&
            db.tripSeats.some(s => s.tripId === t.id && s.status === 'BOOKED'));
          if (inUse && rows !== v.rowCount)
            throw new Error('Seat configuration cannot change while this vehicle has booked seats');   // §27
          v.rowCount = rows;
        }
        v.capacity = v.rowCount * 4;
        if (patch.status != null) {
          if (['AVAILABLE', 'MAINTENANCE', 'INACTIVE'].indexOf(patch.status) < 0) throw new Error('Unknown vehicle status');
          if (patch.status !== 'AVAILABLE') {
            const clash = db.trips.filter(t => t.vehicleId === v.id &&
              ['OPEN', 'BOOKING_CLOSED', 'BOARDING'].indexOf(t.status) >= 0);
            if (clash.length) throw new Error('Reassign ' + clash.length + ' published trip(s) before taking this vehicle out of service');
          }
          v.status = patch.status;
        }
        if (!v.name || !v.registration) throw new Error('A vehicle needs a name and a registration number');
        audit(db, actorRecord(db, me.id), before ? 'vehicle.updated' : 'vehicle.created', 'vehicle', v.id,
          before ? JSON.stringify({ status: before.status, rows: before.rowCount }) : null,
          JSON.stringify({ status: v.status, rows: v.rowCount }), patch.reason || null);
        return clone(v);
      });
    },

    createDraft(input) {
      const me = sessionUser(); assert(me, 'trip.create');
      return commit(db => {
        const tr = {
          id: uid('t'), routeId: 'r_wox_miy', vehicleId: input.vehicleId,
          departureAt: Number(input.departureAt), journeyMinutes: Number(input.journeyMinutes || 120),
          price: Number(input.price || FARE), pickupPoint: input.pickupPoint || 'Woxsen main gate loop',
          cancellationPolicy: 'FULL_REFUND_12H', notes: input.notes || null,
          status: 'DRAFT', statusPinned: false, createdAt: now(), updatedAt: now(),
        };
        tr.reportingAt = tr.departureAt - 20 * 60000;
        tr.bookingOpenAt = Number(input.bookingOpenAt || (tr.departureAt - 14 * 86400000));
        tr.bookingCloseAt = Number(input.bookingCloseAt || (tr.departureAt - 3600000));
        const veh = db.vehicles.find(v => v.id === tr.vehicleId);
        if (!veh) throw new Error('Choose a vehicle for this trip');
        db.trips.push(tr);
        /* §11 seat capacity is derived from the vehicle, never hardcoded */
        seatsForVehicle(veh).forEach(s => db.tripSeats.push(Object.assign({
          id: uid('ts'), tripId: tr.id, status: 'AVAILABLE',
          bookingId: null, holdBy: null, holdExpiresAt: null, blockReason: null,
        }, s)));
        audit(db, actorRecord(db, me.id), 'trip.draft_created', 'trip', tr.id, null, fmtWhen(tr.departureAt), null);
        return tripView(db, tr);
      });
    },
    /* §11.3 real validation, returning every problem it finds */
    validateDraft(tripId) {
      const me = sessionUser(); assert(me, 'trip.read');
      return read(db => {
        const tr = db.trips.find(t => t.id === tripId);
        if (!tr) throw new Error('Trip not found');
        const problems = [], checks = [];
        const veh = db.vehicles.find(v => v.id === tr.vehicleId);
        const ok = (label) => checks.push(label);

        if (!veh) problems.push('No vehicle assigned');
        else if (veh.status !== 'AVAILABLE') problems.push(veh.name + ' is ' + veh.status.toLowerCase() + ' and cannot be assigned');
        else if (veh.maintenanceFrom && tr.departureAt >= veh.maintenanceFrom)
          problems.push(veh.name + ' enters maintenance on ' + fmtDate(veh.maintenanceFrom) + ', before this departure');
        else ok(veh.name + ' is available');

        const overlap = db.trips.filter(t => t.id !== tr.id && t.vehicleId === tr.vehicleId &&
          ['OPEN', 'BOOKING_CLOSED', 'BOARDING', 'DEPARTED'].indexOf(t.status) >= 0 &&
          Math.abs(t.departureAt - tr.departureAt) < (tr.journeyMinutes + 60) * 60000);
        if (overlap.length) problems.push('Vehicle clash with ' + fmtWhen(overlap[0].departureAt));
        else ok('No overlapping vehicle assignment');

        if (!(tr.departureAt > now())) problems.push('Departure is in the past');
        else ok('Departure ' + fmtWhen(tr.departureAt));
        if (!(tr.bookingOpenAt < tr.bookingCloseAt && tr.bookingCloseAt <= tr.departureAt))
          problems.push('Booking window is not valid');
        else ok('Booking window valid');
        if (!(tr.price > 0)) problems.push('Fare must be greater than zero');
        else ok('Fare Rs ' + tr.price);
        const seats = db.tripSeats.filter(s => s.tripId === tr.id).length;
        if (veh && seats !== veh.capacity) problems.push('Seat map has ' + seats + ' seats, vehicle has ' + veh.capacity);
        else if (veh) ok(seats + ' seats mapped, 2 + 2');
        if (!tr.cancellationPolicy) problems.push('No cancellation policy set');
        else ok('Cancellation policy: full refund 12h+');
        if (!tr.pickupPoint) problems.push('No pickup point');
        else ok('Pickup ' + tr.pickupPoint);

        return { valid: problems.length === 0, problems, checks };
      });
    },
    publishTrip(tripId) {
      const me = sessionUser(); assert(me, 'trip.publish');
      const check = admin.validateDraft(tripId);
      if (!check.valid) { const e = new Error('Cannot publish: ' + check.problems[0]); e.problems = check.problems; throw e; }
      return commit(db => {
        const tr = db.trips.find(t => t.id === tripId);
        if (tr.status !== 'DRAFT') throw new Error('Only a draft can be published');
        tr.status = 'OPEN'; tr.updatedAt = now(); tr.publishedAt = now();
        audit(db, actorRecord(db, me.id), 'trip.published', 'trip', tr.id, 'DRAFT', 'OPEN', null);
        return tripView(db, tr);
      });
    },
    setTripStatus(tripId, status, reason) {
      const me = sessionUser(); assert(me, 'trip.status');
      const allowed = ['OPEN', 'BOOKING_CLOSED', 'BOARDING', 'DEPARTED', 'COMPLETED'];
      if (allowed.indexOf(status) < 0) throw new Error('Use cancelTrip to cancel a trip');
      return commit(db => {
        const tr = db.trips.find(t => t.id === tripId);
        if (!tr) throw new Error('Trip not found');
        if (tr.status === 'CANCELLED') throw new Error('This trip is cancelled');
        const before = tr.status;
        tr.status = status; tr.statusPinned = true; tr.updatedAt = now();
        audit(db, actorRecord(db, me.id), 'trip.status_changed', 'trip', tr.id, before, status,
          reason || 'Manual correction');
        return tripView(db, tr);
      });
    },
    /* §17.3 the full documented cascade */
    cancelTrip(tripId, reason) {
      const me = sessionUser(); assert(me, 'trip.cancel');
      if (!reason || String(reason).trim().length < 4) throw new Error('A cancellation reason is required');
      return commit(db => {
        const tr = db.trips.find(t => t.id === tripId);
        if (!tr) throw new Error('Trip not found');
        const before = tr.status;
        tr.status = 'CANCELLED'; tr.statusPinned = true; tr.cancelledReason = String(reason).trim(); tr.updatedAt = now();
        let refunded = 0, affected = 0;
        db.bookings.filter(b => b.tripId === tripId).forEach(b => {
          if (['CANCELLED_BY_DLT', 'CANCELLED_BY_STUDENT', 'ABANDONED'].indexOf(b.status) >= 0) return;
          affected++;
          const pax = db.bookingPassengers.filter(p => p.bookingId === b.id);
          pax.forEach(p => {
            p.boardingStatus = 'CANCELLED';
            const pass = db.passes.find(x => x.passengerId === p.id);
            if (pass) pass.status = 'VOID';
            const seat = db.tripSeats.find(s => s.id === p.tripSeatId);
            if (seat) { seat.status = 'AVAILABLE'; seat.bookingId = null; }
          });
          const pay = db.payments.find(p => p.bookingId === b.id && p.status === 'SUCCESS');
          if (pay) {
            const r = { id: uid('ref'), bookingId: b.id, paymentId: pay.id, amount: b.totalAmount,
              status: 'REFUND_PENDING', reason: 'Trip cancelled by DLT: ' + tr.cancelledReason,
              providerReference: null, createdAt: now(), updatedAt: now() };
            db.refunds.push(r);
            refunded += r.amount;
            db.providerEvents.push({ id: uid('pe'), kind: 'refund', refundId: r.id,
              outcome: Math.random() < 0.92 ? 'REFUNDED' : 'FAILED', at: now() + 2000,
              providerReference: 'SBXR' + Math.floor(1e8 + Math.random() * 8e8) });
          }
          b.status = 'CANCELLED_BY_DLT'; b.updatedAt = now();
        });
        audit(db, actorRecord(db, me.id), 'trip.cancelled', 'trip', tr.id, before, 'CANCELLED', String(reason).trim());
        return { affectedBookings: affected, refundInitiated: refunded };
      });
    },
    blockSeat(tripId, seatNumber, reason) {
      const me = sessionUser(); assert(me, 'seat.block');
      return commit(db => {
        const s = db.tripSeats.find(s => s.tripId === tripId && s.seatNumber === seatNumber);
        if (!s) throw new Error('Seat not found');
        const before = s.status;
        if (s.status === 'BLOCKED') { s.status = 'AVAILABLE'; s.blockReason = null; }
        else {
          if (s.status === 'BOOKED') throw new Error('Seat ' + seatNumber + ' is booked and cannot be blocked');
          if (!reason || String(reason).trim().length < 3) throw new Error('A reason is required to block a seat');
          s.status = 'BLOCKED'; s.blockReason = String(reason).trim(); s.holdBy = null; s.holdExpiresAt = null;
        }
        audit(db, actorRecord(db, me.id), s.status === 'BLOCKED' ? 'seat.block' : 'seat.release',
          'tripSeat', s.id, before, s.status, s.blockReason);
        return { seatNumber, status: s.status, reason: s.blockReason };
      });
    },
    /* §Boarding 5 · Admin §7 — operations decide who is on the door */
    assignStaff(tripId, staffUserId, reason) {
      const me = sessionUser(); assert(me, 'staff.assign');
      return commit(db => {
        const tr = db.trips.find(t => t.id === tripId);
        if (!tr) throw new Error('Trip not found');
        const u = db.users.find(u => u.id === staffUserId);
        if (!u || u.role !== 'BOARDING_STAFF') throw new Error('Choose a boarding staff account');
        if (u.status !== 'ACTIVE') throw new Error('That staff account is not active');
        tr.staffUserIds = tr.staffUserIds || [];
        const at = tr.staffUserIds.indexOf(u.id);
        const removing = at >= 0;
        if (removing) tr.staffUserIds.splice(at, 1);
        else {
          /* one door at a time: an active assignment elsewhere is moved, not duplicated */
          db.trips.forEach(other => {
            if (other.id === tr.id || !other.staffUserIds) return;
            if (['BOARDING', 'BOOKING_CLOSED', 'OPEN'].indexOf(other.status) < 0) return;
            const k = other.staffUserIds.indexOf(u.id);
            if (k >= 0) other.staffUserIds.splice(k, 1);
          });
          tr.staffUserIds.push(u.id);
        }
        tr.updatedAt = now();
        audit(db, actorRecord(db, me.id), removing ? 'trip.staff_unassigned' : 'trip.staff_assigned',
          'trip', tr.id, removing ? u.name : null, removing ? null : u.name, reason || null);
        return { assigned: !removing, staff: u.name, trip: fmtWhen(tr.departureAt) };
      });
    },
    staffAccounts() {
      const me = sessionUser(); assert(me, 'staff.assign');
      return read(db => db.users.filter(u => u.role === 'BOARDING_STAFF')
        .map(u => ({ id: u.id, name: u.name, email: u.email, status: u.status,
          assignedTo: (function () { const t = assignedTripFor(db, u.id); return t ? fmtWhen(t.departureAt) : null; })() })));
    },
    /* §17 · §43 — a REAL override. The policy path (bookings.cancel) computes the
       refund from the 12-hour rule and is right to; this is the separate,
       Super-Admin-only path for refunding what the policy would not. It states an
       amount, refuses zero, refuses more than the money we actually hold, and
       returns the amount it really raised so nothing can report success on ₹0. */
    overrideRefund({ bookingId, amount, reason, cancelBooking }) {
      const me = sessionUser();
      if (!me || me.role !== 'SUPER_ADMIN') throw denied('A policy override is Super Admin only');
      if (!reason || String(reason).trim().length < 4) throw new Error('A reason is required for a policy override');
      const want = Math.round(Number(amount));
      if (!(want > 0)) throw new Error('Enter the refund amount. A zero-value override is not an override.');
      return commit(db => {
        const b = db.bookings.find(b => b.id === bookingId);
        if (!b) throw new Error('Booking not found');
        const cap = refundCap(db, b.id);
        if (cap <= 0) throw new Error('Nothing is left to refund on ' + b.code +
          ' — ₹' + moneyIn(db, b.id) + ' was received and ₹' + moneyOut(db, b.id) + ' is already refunded or pending.');
        if (want > cap) throw new Error('₹' + want + ' is more than the ₹' + cap +
          ' still refundable on ' + b.code + '.');
        const pay = db.payments.find(p => p.bookingId === b.id && p.status === 'SUCCESS') || null;
        const r = { id: uid('ref'), bookingId: b.id, paymentId: pay ? pay.id : null,
          amount: want, status: 'REFUND_PENDING', override: true,
          reason: 'Policy override: ' + String(reason).trim(),
          providerReference: null, createdAt: now(), updatedAt: now() };
        db.refunds.push(r);
        db.providerEvents.push({ id: uid('pe'), kind: 'refund', refundId: r.id, outcome: 'REFUNDED',
          at: now() + 1500, providerReference: 'SBXR' + Math.floor(1e8 + Math.random() * 8e8) });

        let released = 0;
        const active = ['CANCELLED_BY_STUDENT', 'CANCELLED_BY_DLT', 'ABANDONED'].indexOf(b.status) < 0;
        if (cancelBooking && active) {
          db.bookingPassengers.filter(p => p.bookingId === b.id).forEach(p => {
            p.boardingStatus = 'CANCELLED';
            const pass = db.passes.find(x => x.passengerId === p.id);
            if (pass) pass.status = 'VOID';
            const seat = db.tripSeats.find(s => s.id === p.tripSeatId);
            if (seat) { seat.status = 'AVAILABLE'; seat.bookingId = null; seat.holdBy = null; seat.holdExpiresAt = null; released++; }
          });
          b.status = 'CANCELLED_BY_DLT'; b.updatedAt = now();
          waitlistOffer(db, b.tripId);
        }
        audit(db, actorRecord(db, me.id), 'refund.policy_override', 'booking', b.id,
          'refundable by policy: ₹0', '₹' + want, String(reason).trim());
        return { amount: want, refundId: r.id, seatsReleased: released,
          bookingStatus: b.status, remainingRefundable: cap - want };
      });
    },
    bookings(filter) {
      const me = sessionUser(); assert(me, 'booking.read');
      return read(db => db.bookings
        .filter(b => !filter || !filter.tripId || b.tripId === filter.tripId)
        .filter(b => b.status !== 'ABANDONED')
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, (filter && filter.limit) || 60)
        .map(b => bookings._view(db, b, me)));
    },
    /* §39 search across the permitted identifiers */
    search(q) {
      const me = sessionUser(); assert(me, 'booking.read');
      const term = String(q || '').trim().toLowerCase();
      if (term.length < 3) return [];
      return read(db => {
        const hits = new Set();
        db.bookings.forEach(b => {
          if (b.code.toLowerCase().indexOf(term) >= 0 || b.boardingCode.toLowerCase().indexOf(term) >= 0) hits.add(b.id);
          if (String(b.contactPhone || '').indexOf(term) >= 0) hits.add(b.id);
        });
        db.bookingPassengers.forEach(p => {
          if (p.name.toLowerCase().indexOf(term) >= 0 ||
              String(p.studentId).toLowerCase().indexOf(term) >= 0 ||
              String(p.phone).indexOf(term) >= 0) hits.add(p.bookingId);
        });
        db.payments.forEach(p => {
          if (can(me.role, 'payment.read') || me.role === 'SUPER_ADMIN') {
            if (String(p.providerReference || '').toLowerCase().indexOf(term) >= 0) hits.add(p.bookingId);
          }
        });
        return Array.from(hits).map(id => bookings._view(db, db.bookings.find(b => b.id === id), me))
          .filter(Boolean).slice(0, 25);
      });
    },
    /* §40 manual bookings, never presented as a Cashfree payment */
    createManualBooking({ tripId, passengers, type, reason, contactPhone, studentEmail }) {
      const me = sessionUser(); assert(me, '*');
      if (!reason || String(reason).trim().length < 4) throw new Error('A reason is required for a manual booking');
      if (['COMPLIMENTARY', 'PAID_EXTERNALLY'].indexOf(type) < 0) throw new Error('Choose complimentary or paid externally');
      return commit(db => {
        const tr = db.trips.find(t => t.id === tripId);
        if (!tr) throw new Error('Trip not found');
        const owner = studentEmail ? db.users.find(u => u.email === String(studentEmail).toLowerCase()) : null;
        const free = db.tripSeats.filter(s => s.tripId === tripId && s.status === 'AVAILABLE');
        if (free.length < passengers.length) throw new Error('Not enough available seats');
        const b = { id: uid('b'), code: 'DLT-' + Math.floor(40000 + Math.random() * 9000),
          boardingCode: 'WX' + Math.floor(1000 + Math.random() * 8999), tripId,
          ownerId: owner ? owner.id : me.id, status: 'CONFIRMED',
          bookingType: 'MANUAL_' + type, contactPhone: contactPhone || null,
          totalAmount: type === 'COMPLIMENTARY' ? 0 : passengers.length * tr.price,
          unitPrice: type === 'COMPLIMENTARY' ? 0 : tr.price,
          createdAt: now(), updatedAt: now(), confirmedAt: now(), holdExpiresAt: null,
          manualReason: String(reason).trim(), createdByAdminId: me.id };
        db.bookings.push(b);
        passengers.forEach((p, i) => {
          const seat = free[i];
          seat.status = 'BOOKED'; seat.bookingId = b.id;
          const bp = { id: uid('bp'), bookingId: b.id, name: p.name, studentId: p.studentId,
            phone: p.phone, tripSeatId: seat.id, seatNumber: seat.seatNumber,
            seatType: seat.seatType, boardingStatus: 'NOT_BOARDED' };
          db.bookingPassengers.push(bp);
          db.passes.push({ id: uid('pass'), passengerId: bp.id, bookingId: b.id, tripId,
            boardingCode: b.boardingCode, qrToken: 'dlt.' + token(14), status: 'VALID', issuedAt: now() });
        });
        db.payments.push({ id: uid('pay'), bookingId: b.id,
          provider: type === 'COMPLIMENTARY' ? 'NONE_COMPLIMENTARY' : 'MANUAL_EXTERNAL',
          providerReference: null, amount: b.totalAmount, currency: 'INR',
          status: type === 'COMPLIMENTARY' ? 'NOT_APPLICABLE' : 'SUCCESS',
          createdAt: now(), updatedAt: now(), idempotencyKey: uid('idem'), manual: true });
        audit(db, actorRecord(db, me.id), 'booking.manual_created', 'booking', b.id, null,
          b.code + ' · ' + b.bookingType, String(reason).trim());
        return bookings._view(db, b, me);
      });
    },
    /* §43 reconciliation, Super Admin only */
    payments(filter) {
      const me = sessionUser();
      if (!me || me.role !== 'SUPER_ADMIN') throw denied('Payment reconciliation is Super Admin only');
      return read(db => {
        const bucketOf = (p) => {
          if (p.provider === 'MANUAL_EXTERNAL' || p.provider === 'NONE_COMPLIMENTARY') return 'Manual/external';
          return { SUCCESS: 'Successful', PENDING: 'Pending', INITIATED: 'Pending', FAILED: 'Failed',
            EXPIRED: 'Failed', DUPLICATE: 'Duplicate', DISCREPANCY: 'Discrepancy',
            NOT_APPLICABLE: 'Manual/external' }[p.status] || p.status;
        };
        return db.payments.slice().sort((a, b) => b.createdAt - a.createdAt).map(p => {
          const b = db.bookings.find(b => b.id === p.bookingId);
          const u = b ? db.users.find(u => u.id === b.ownerId) : null;
          const refunds = db.refunds.filter(r => r.paymentId === p.id);
          return { id: p.id, bookingId: p.bookingId, bookingCode: b ? b.code : '—',
            student: u ? u.name : '—', amount: p.amount, expectedAmount: p.expectedAmount || null,
            provider: p.provider, providerReference: p.providerReference,
            status: p.status, bucket: bucketOf(p),
            refundStatus: refunds.length ? refunds[refunds.length - 1].status : null,
            duplicateOf: p.duplicateOf || null, createdAt: p.createdAt, updatedAt: p.updatedAt,
            bookingStatus: b ? b.status : null };
        }).filter(r => !filter || filter === 'All' || r.bucket === filter);
      });
    },
    reconcilePayment(paymentId) {
      const me = sessionUser();
      if (!me || me.role !== 'SUPER_ADMIN') throw denied('Payment reconciliation is Super Admin only');
      return commit(db => {
        applyProviderEvents(db);
        const p = db.payments.find(p => p.id === paymentId);
        if (!p) throw new Error('Payment not found');
        const b = db.bookings.find(b => b.id === p.bookingId);
        if (p.status === 'SUCCESS' && b && b.status !== 'CONFIRMED') finalizeBooking(db, b);
        audit(db, actorRecord(db, me.id), 'payment.reconciled', 'payment', p.id, null, p.status, null);
        return { status: p.status, bookingStatus: b ? b.status : null };
      });
    },
    resolveDiscrepancy(paymentId, decision, reason) {
      const me = sessionUser();
      if (!me || me.role !== 'SUPER_ADMIN') throw denied('Super Admin only');
      if (!reason) throw new Error('A reason is required');
      return commit(db => {
        const p = db.payments.find(p => p.id === paymentId);
        if (!p) throw new Error('Payment not found');
        const b = db.bookings.find(b => b.id === p.bookingId);
        const before = p.status;
        if (decision === 'accept') {
          /* accept the short payment and confirm at the paid amount */
          p.status = 'SUCCESS'; p.updatedAt = now();
          if (b) { b.totalAmount = p.amount; finalizeBooking(db, b); }
        } else if (decision === 'refund') {
          p.status = 'REFUND_PENDING'; p.updatedAt = now();
          const r = { id: uid('ref'), bookingId: p.bookingId, paymentId: p.id, amount: p.amount,
            status: 'REFUND_PENDING', reason, providerReference: null, createdAt: now(), updatedAt: now() };
          db.refunds.push(r);
          db.providerEvents.push({ id: uid('pe'), kind: 'refund', refundId: r.id, outcome: 'REFUNDED',
            at: now() + 1500, providerReference: 'SBXR' + Math.floor(1e8 + Math.random() * 8e8) });
          if (b) { b.status = 'CANCELLED_BY_DLT'; b.updatedAt = now(); }
        } else throw new Error('Unknown decision');
        audit(db, actorRecord(db, me.id), 'payment.discrepancy_resolved', 'payment', p.id, before, p.status, reason);
        return { status: p.status };
      });
    },
    refundExtra(paymentId, reason) {
      const me = sessionUser();
      if (!me || me.role !== 'SUPER_ADMIN') throw denied('Super Admin only');
      if (!reason) throw new Error('A reason is required');
      return commit(db => {
        const p = db.payments.find(p => p.id === paymentId);
        if (!p || p.status !== 'DUPLICATE') throw new Error('That payment is not marked duplicate');
        const r = { id: uid('ref'), bookingId: p.bookingId, paymentId: p.id, amount: p.amount,
          status: 'REFUND_PENDING', reason, providerReference: null, createdAt: now(), updatedAt: now() };
        db.refunds.push(r);
        db.providerEvents.push({ id: uid('pe'), kind: 'refund', refundId: r.id, outcome: 'REFUNDED',
          at: now() + 1500, providerReference: 'SBXR' + Math.floor(1e8 + Math.random() * 8e8) });
        audit(db, actorRecord(db, me.id), 'payment.duplicate_refunded', 'payment', p.id, 'DUPLICATE', 'REFUND_PENDING', reason);
        return { refundId: r.id };
      });
    },
    /* §7 · Security §1 — there is no mail server in the prototype, so a reset code
       is retrievable only by a Super Admin acting as the support desk, with a
       reason, and the lookup itself is audited. It is never returned to the
       person who asked for the reset. */
    resetCodeFor(userId, reason) {
      const me = sessionUser();
      if (!me || me.role !== 'SUPER_ADMIN') throw denied('Super Admin only');
      if (!reason || String(reason).trim().length < 4) throw new Error('A reason is required to read a reset code');
      return commit(db => {
        const u = db.users.find(u => u.id === userId);
        if (!u) throw new Error('Account not found');
        if (!u.resetToken || !(u.resetExpiresAt > now()))
          throw new Error('No reset request is outstanding for ' + u.email);
        audit(db, actorRecord(db, me.id), 'auth.reset_code_viewed', 'user', u.id, null, null, String(reason).trim());
        return { email: u.email, resetToken: u.resetToken, expiresAt: u.resetExpiresAt };
      });
    },
    students() {
      const me = sessionUser(); assert(me, 'student.read');
      return read(db => db.users.filter(u => u.role === 'STUDENT').map(u => ({
        id: u.id, name: u.name, email: u.email, phone: u.phone, studentId: u.studentId,
        university: u.university, status: u.status, emailVerified: u.emailVerified, createdAt: u.createdAt,
        bookings: db.bookings.filter(b => b.ownerId === u.id && b.status !== 'ABANDONED').length,
        /* §8.2 the emergency contact is not returned to a general admin listing */
        emergencyContactAvailable: !!u.emergencyContact,
      })));
    },
    /* §8.2 reading it is a sensitive action, and is audited */
    revealEmergencyContact(userId, reason) {
      const me = sessionUser();
      if (!me || me.role !== 'SUPER_ADMIN') throw denied('Super Admin only');
      if (!reason) throw new Error('A reason is required to view an emergency contact');
      return commit(db => {
        const u = db.users.find(u => u.id === userId);
        if (!u) throw new Error('Student not found');
        audit(db, actorRecord(db, me.id), 'student.emergency_contact_viewed', 'user', u.id, null, null, reason);
        return u.emergencyContact ? clone(u.emergencyContact) : null;
      });
    },
    dashboard() {
      const me = sessionUser(); assert(me, 'trip.read');
      return read(db => {
        const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
        const dayEnd = dayStart.getTime() + 86400000;
        const today = db.trips.filter(t => t.departureAt >= dayStart.getTime() && t.departureAt < dayEnd &&
          t.status !== 'DRAFT' && t.status !== 'CANCELLED');
        let pax = 0, seatsSold = 0, capacity = 0, revenue = 0, boarded = 0;
        today.forEach(tr => {
          const v = tripView(db, tr);
          capacity += v.capacity; seatsSold += v.booked; revenue += v.revenue;
          db.bookings.filter(b => b.tripId === tr.id && b.status === 'CONFIRMED').forEach(b => {
            const ps = db.bookingPassengers.filter(p => p.bookingId === b.id);
            pax += ps.length;
            boarded += ps.filter(p => p.boardingStatus === 'BOARDED').length;
          });
        });
        const refundToday = db.refunds.filter(r => r.updatedAt >= dayStart.getTime() && r.status === 'REFUNDED')
          .reduce((n, r) => n + r.amount, 0);
        const alerts = [];
        db.payments.filter(p => p.status === 'DISCREPANCY').forEach(p => {
          const b = db.bookings.find(b => b.id === p.bookingId);
          alerts.push({ id: p.id, kind: 'payment', title: 'Amount mismatch on ' + (b ? b.code : p.id),
            detail: 'Rs ' + p.amount + ' received against Rs ' + (p.expectedAmount || '?') + ' expected · booking held, not confirmed',
            cta: 'Reconcile', section: 'Payments' });
        });
        db.payments.filter(p => p.status === 'DUPLICATE').forEach(p => {
          const b = db.bookings.find(b => b.id === p.bookingId);
          alerts.push({ id: p.id, kind: 'payment', title: 'Duplicate charge on ' + (b ? b.code : p.id),
            detail: 'Rs ' + p.amount + ' taken twice · refund the extra charge', cta: 'Reconcile', section: 'Payments' });
        });
        db.refunds.filter(r => r.status === 'REFUND_PENDING' && r.lateSettlement).forEach(r => {
          const b = db.bookings.find(b => b.id === r.bookingId);
          alerts.push({ id: r.id, kind: 'refund',
            title: 'Late payment on a closed booking ' + (b ? b.code : r.id),
            detail: 'Rs ' + r.amount + ' arrived after the seat was released · refund raised, seat not reissued',
            cta: 'Reconcile', section: 'Payments' });
        });
        db.refunds.filter(r => r.status === 'REFUND_FAILED').forEach(r => {
          const b = db.bookings.find(b => b.id === r.bookingId);
          alerts.push({ id: r.id, kind: 'refund', title: 'Refund failed on ' + (b ? b.code : r.id),
            detail: 'Rs ' + r.amount + ' did not reach the student', cta: 'Reconcile', section: 'Payments' });
        });
        db.vehicles.filter(v => v.maintenanceFrom && v.maintenanceFrom < now() + 7 * 86400000).forEach(v => {
          const clash = db.trips.filter(t => t.vehicleId === v.id && t.departureAt >= v.maintenanceFrom &&
            ['DRAFT', 'OPEN'].indexOf(t.status) >= 0);
          if (clash.length) alerts.push({ id: v.id, kind: 'vehicle',
            title: v.name + ' due for maintenance ' + fmtDate(v.maintenanceFrom),
            detail: 'Blocks ' + clash.length + ' trip(s) · reassign before publishing', cta: 'Open trips', section: 'Trips' });
        });
        db.bookings.filter(b => b.status === 'BOOKING_PROCESSING').forEach(b => {
          alerts.push({ id: b.id, kind: 'booking', title: 'Booking finalisation failed on ' + b.code,
            detail: b.finalizeError || 'Payment succeeded, booking not issued', cta: 'Reconcile', section: 'Payments' });
        });
        return {
          tripsToday: today.length,
          tripsTodayDetail: today.map(t => t.status.toLowerCase().replace('_', ' ')).join(' · ') || 'none scheduled',
          passengers: pax, seatsSold, capacity,
          occupancy: capacity ? Math.round((seatsSold / capacity) * 100) : 0,
          revenue, refundToday, boarded,
          boardingTripId: (today.find(t => t.status === 'BOARDING') || today[0] || {}).id || null,
          alerts,
          activity: db.auditLogs.slice(0, 12).map(a => ({
            at: a.at, text: describeAudit(a), actor: a.actorName, role: a.actorRole })),
        };
      });
    },
    audit(filter) {
      const me = sessionUser();
      if (!me || me.role !== 'SUPER_ADMIN') throw denied('The audit log is Super Admin only');
      return read(db => db.auditLogs
        .filter(a => !filter || !filter.q ||
          (a.action + ' ' + a.actorName + ' ' + (a.reason || '')).toLowerCase().indexOf(String(filter.q).toLowerCase()) >= 0)
        .slice(0, (filter && filter.limit) || 120)
        .map(a => ({ id: a.id, at: a.at, actor: a.actorName, actorRole: label(a.actorRole),
          action: a.action, entity: a.entityType + ' ' + String(a.entityId || '').slice(0, 12),
          oldValue: a.oldValue, newValue: a.newValue, reason: a.reason, text: describeAudit(a) })));
    },

    /* §42 reports, computed from records, exported as real files */
    report(kind, filter) {
      const me = sessionUser(); assert(me, 'report.read');
      return read(db => {
        const inRange = (t) => (!filter || !filter.from || t >= filter.from) && (!filter || !filter.to || t <= filter.to);
        const tripsIn = db.trips.filter(t => inRange(t.departureAt) &&
          (!filter || !filter.tripId || t.id === filter.tripId));
        if (kind === 'bookings') {
          const rows = [];
          db.bookings.filter(b => b.status !== 'ABANDONED').forEach(b => {
            const tr = db.trips.find(t => t.id === b.tripId);
            if (!tr || !inRange(tr.departureAt)) return;
            if (filter && filter.bookingStatus && filter.bookingStatus !== 'All' && b.status !== filter.bookingStatus) return;
            const u = db.users.find(u => u.id === b.ownerId);
            const pax = db.bookingPassengers.filter(p => p.bookingId === b.id);
            rows.push({ Booking: b.code, Trip: fmtWhen(tr.departureAt), Status: b.status,
              Owner: u ? u.name : '', Passengers: pax.length,
              Seats: pax.map(p => p.seatNumber).join(' '), Amount: b.totalAmount,
              Type: b.bookingType, Created: fmtDateTime(b.createdAt) });
          });
          return rows;
        }
        if (kind === 'revenue') {
          return tripsIn.map(tr => {
            const v = tripView(db, tr);
            const refunds = db.bookings.filter(b => b.tripId === tr.id)
              .reduce((n, b) => n + db.refunds.filter(r => r.bookingId === b.id && r.status === 'REFUNDED')
                .reduce((m, r) => m + r.amount, 0), 0);
            return { Trip: fmtWhen(tr.departureAt), Vehicle: v.vehicle ? v.vehicle.name : '',
              Status: tr.status, Capacity: v.capacity, Booked: v.booked,
              Gross: v.revenue, Refunded: refunds, Net: v.revenue - refunds };
          });
        }
        if (kind === 'passengers' || kind === 'manifest') {
          const rows = [];
          tripsIn.forEach(tr => db.bookings.filter(b => b.tripId === tr.id && b.status === 'CONFIRMED')
            .forEach(b => db.bookingPassengers.filter(p => p.bookingId === b.id).forEach(p => {
              const ev = db.boardingEvents.filter(e => e.passengerId === p.id && e.result === 'VALID')[0];
              rows.push({ Trip: fmtWhen(tr.departureAt), Passenger: p.name, StudentID: p.studentId,
                Phone: me.role === 'BOARDING_STAFF' ? '' : p.phone, Seat: p.seatNumber,
                Type: p.seatType, Booking: b.code, Boarding: p.boardingStatus,
                BoardedAt: ev ? fmtTime(ev.at) : '', Method: ev ? ev.method : '' });
            })));
          return rows;
        }
        if (kind === 'occupancy') {
          return tripsIn.map(tr => {
            const v = tripView(db, tr);
            return { Trip: fmtWhen(tr.departureAt), Vehicle: v.vehicle ? v.vehicle.name : '',
              Capacity: v.capacity, Booked: v.booked, Available: v.available,
              Occupancy: (v.capacity ? Math.round((v.booked / v.capacity) * 100) : 0) + '%' };
          });
        }
        if (kind === 'boarding' || kind === 'noshow') {
          const rows = [];
          tripsIn.forEach(tr => db.bookings.filter(b => b.tripId === tr.id).forEach(b =>
            db.bookingPassengers.filter(p => p.bookingId === b.id).forEach(p => {
              if (kind === 'noshow' && ['NO_SHOW', 'POTENTIAL_NO_SHOW'].indexOf(p.boardingStatus) < 0) return;
              const ev = db.boardingEvents.filter(e => e.passengerId === p.id).sort((a, c) => c.at - a.at)[0];
              rows.push({ Trip: fmtWhen(tr.departureAt), Passenger: p.name, StudentID: p.studentId,
                Seat: p.seatNumber, Booking: b.code, Status: p.boardingStatus,
                At: ev ? fmtDateTime(ev.at) : '', By: ev ? ev.staffName : '', Reason: ev ? (ev.reason || '') : '' });
            })));
          return rows;
        }
        if (kind === 'payments' || kind === 'refunds') {
          if (me.role !== 'SUPER_ADMIN') throw denied('Payment reports are Super Admin only');
          if (kind === 'refunds') {
            return db.refunds.map(r => {
              const b = db.bookings.find(b => b.id === r.bookingId);
              return { Booking: b ? b.code : '', Amount: r.amount, Status: r.status,
                Reason: r.reason || '', Reference: r.providerReference || '',
                Requested: fmtDateTime(r.createdAt), Settled: r.status === 'REFUNDED' ? fmtDateTime(r.updatedAt) : '' };
            });
          }
          return db.payments.filter(p => !filter || !filter.paymentStatus ||
            filter.paymentStatus === 'All' || p.status === filter.paymentStatus).map(p => {
            const b = db.bookings.find(b => b.id === p.bookingId);
            return { Booking: b ? b.code : '', Amount: p.amount, Expected: p.expectedAmount || p.amount,
              Status: p.status, Provider: p.provider, Reference: p.providerReference || '',
              Created: fmtDateTime(p.createdAt), Updated: fmtDateTime(p.updatedAt) };
          });
        }
        if (kind === 'posttrip') {
          const tr = db.trips.find(t => t.id === (filter && filter.tripId)) ||
            db.trips.filter(t => t.status === 'COMPLETED').sort((a, b) => b.departureAt - a.departureAt)[0];
          if (!tr) return null;
          const v = tripView(db, tr);
          const bs = db.bookings.filter(b => b.tripId === tr.id);
          const pax = [].concat.apply([], bs.map(b => db.bookingPassengers.filter(p => p.bookingId === b.id)));
          const refunds = bs.reduce((n, b) => n + db.refunds.filter(r => r.bookingId === b.id && r.status === 'REFUNDED')
            .reduce((m, r) => m + r.amount, 0), 0);
          const rating = db.reviews.filter(r => r.tripId === tr.id);
          return {
            tripId: tr.id, route: 'Woxsen to Miyapur', when: fmtWhen(tr.departureAt),
            departedAt: tr.status === 'COMPLETED' || tr.status === 'DEPARTED' ? fmtTime(tr.departureAt) : '—',
            capacity: v.capacity, booked: v.booked,
            boarded: pax.filter(p => p.boardingStatus === 'BOARDED').length,
            noShow: pax.filter(p => ['NO_SHOW', 'POTENTIAL_NO_SHOW'].indexOf(p.boardingStatus) >= 0).length,
            denied: pax.filter(p => p.boardingStatus === 'DENIED_BOARDING').length,
            revenue: v.revenue, refunded: refunds,
            vehicle: v.vehicle ? v.vehicle.name + ' · ' + v.vehicle.registration : '—',
            driver: 'Not assigned (Master §26: driver management is out of V1 scope)',
            rating: rating.length ? (rating.reduce((n, r) => n + r.rating, 0) / rating.length).toFixed(1) : '—',
            status: tr.status,
          };
        }
        throw new Error('Unknown report: ' + kind);
      });
    },
    exportCsv(kind, filter) {
      const rows = admin.report(kind, filter);
      const list = Array.isArray(rows) ? rows : [rows];
      if (!list.length || !list[0]) throw new Error('That report has no rows for the current filter');
      const cols = Object.keys(list[0]);
      const esc = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const csv = [cols.join(',')].concat(list.map(r => cols.map(c => esc(r[c])).join(','))).join('\r\n');
      const name = 'dlt-' + kind + '-' + new Date().toISOString().slice(0, 10) + '.csv';
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      const me = sessionUser();
      commit(db => audit(db, actorRecord(db, me.id), 'report.exported', 'report', kind, null, name, null));
      return { name, rows: list.length };
    },
  };

  function describeAudit(a) {
    const map = {
      'booking.created': 'Booking created', 'booking.confirmed': 'Booking confirmed',
      'booking.cancelled': 'Booking cancelled', 'booking.contact_changed': 'Booking contact changed',
      'booking.manual_created': 'Manual booking created', 'booking.owner_changed': 'Booking owner changed',
      'booking.finalize_failed': 'Booking finalisation failed',
      'payment.initiated': 'Payment initiated', 'payment.success': 'Payment verified and applied',
      'payment.failed': 'Payment failed', 'payment.expired': 'Payment expired',
      'payment.discrepancy': 'Payment amount mismatch', 'payment.duplicate_detected': 'Duplicate payment detected',
      'payment.duplicate_refunded': 'Duplicate charge refunded', 'payment.reconciled': 'Payment reconciled',
      'payment.discrepancy_resolved': 'Discrepancy resolved',
      'refund.refunded': 'Refund settled', 'refund.refund_failed': 'Refund failed',
      'boarding.scanned': 'Passenger boarded by scan', 'boarding.code_entry': 'Passenger boarded by code entry',
      'boarding.manual': 'Passenger boarded manually',
      'boarding.denied': 'Boarding denied', 'boarding.no_show_confirmed': 'No-show confirmed',
      'seat.block': 'Seat blocked', 'seat.release': 'Seat released',
      'trip.draft_created': 'Trip draft created', 'trip.published': 'Trip published',
      'trip.status_changed': 'Trip status changed', 'trip.cancelled': 'Trip cancelled',
      'vehicle.created': 'Vehicle created', 'vehicle.updated': 'Vehicle updated',
      'waitlist.joined': 'Waitlist joined', 'waitlist.claim_offered': 'Waitlist claim offered',
      'waitlist.reordered': 'Waitlist reordered',
      'review.submitted': 'Trip rated', 'notification.requested': 'Notification requested',
      'notification.marked_notified': 'Marked as notified',
      'auth.signin': 'Signed in', 'auth.signup': 'Account created',
      'student.emergency_contact_viewed': 'Emergency contact viewed',
      'report.exported': 'Report exported', 'system.seed': 'Reference data seeded',
      'profile.update': 'Profile updated', 'profile.id_change_requested': 'Student ID change requested',
      'account.deletion_requested': 'Account deletion requested',
      'auth.password_reset': 'Password reset', 'auth.email_verified': 'Email verified',
      'auth.reset_requested': 'Password reset requested',
    };
    const base = map[a.action] || a.action;
    const bits = [base];
    if (a.entityType && a.entityId) bits.push('· ' + a.entityType);
    if (a.oldValue && a.newValue) bits.push('· ' + a.oldValue + ' → ' + a.newValue);
    else if (a.newValue) bits.push('· ' + a.newValue);
    if (a.reason) bits.push('· ' + a.reason);
    return bits.join(' ');
  }

  /* ---- formatting helpers shared by every screen ---- */
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtTime(ts) { const d = new Date(ts); return two(d.getHours()) + ':' + two(d.getMinutes()); }
  function fmtDate(ts) { const d = new Date(ts); return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()]; }
  function fmtWhen(ts) { return fmtDate(ts) + ' · ' + fmtTime(ts); }
  function fmtDateTime(ts) { return fmtDate(ts) + ' ' + fmtTime(ts); }
  function fmtCountdown(ms) {
    if (ms <= 0) return '0:00';
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
    return m + ':' + two(s);
  }
  function relativeDay(ts) {
    const d = new Date(ts), t = new Date();
    d.setHours(0, 0, 0, 0); t.setHours(0, 0, 0, 0);
    const n = Math.round((d - t) / 86400000);
    return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n > 1 ? 'in ' + n + ' days' : Math.abs(n) + ' days ago';
  }

  window.DLT = {
    ready, init, FARE, HOLD_MS, CLAIM_MS, MAX_PAX, SEAT_COLS,
    auth, trips, seats, bookings, payments, provider, boarding,
    waitlist, reviews, notifications, admin,
    can, roleLabel: label, seatType,
    fmt: { time: fmtTime, date: fmtDate, when: fmtWhen, dateTime: fmtDateTime,
      countdown: fmtCountdown, relativeDay },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /* reconciliation runs on a timer, the way a real one would */
    startReconciler(ms) {
      if (window.__dltRecon) return;
      window.__dltRecon = setInterval(() => {
        try { commit(db => applyProviderEvents(db)); } catch (e) {}
      }, ms || 1500);
    },
    /* development escape hatch: wipe and reseed. Only touches DLT's own keys. */
    async reset() {
      localStorage.removeItem(KEY); localStorage.removeItem(SESSION_KEY);
      await seed(); broadcast(); return true;
    },
    _debug: { raw, seed, KEY, SESSION_KEY },
  };

  init().then(() => window.DLT.startReconciler());
})();
