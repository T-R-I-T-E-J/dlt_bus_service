import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function component(file, api, location = { search: '', href: '' }) {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    .match(/<script[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/)[1];
  class Logic { setState(patch, done) { Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch); done?.(); } }
  return new (new Function('DCLogic','DLT','window','location', source + '\nreturn Component;')(Logic,api,{DLT:api},location))();
}

test('an existing boarding session goes directly to staff controls from Account', async () => {
  const location = { search: '', href: '' };
  const page = component('DLT Account.dc.html', {
    boot: async () => {}, setUnauthenticatedHandler() {}, auth: { current: () => ({ role: 'BOARDING_STAFF' }) },
  }, location);
  await page.componentDidMount();
  assert.equal(location.href, './DLT Admin.dc.html');
});

test('signed-out Account with next=book does not redirect in a loop', async () => {
  const location = { search: '?next=book', href: '' };
  const page = component('DLT Account.dc.html', {
    boot: async () => {}, setUnauthenticatedHandler() {}, auth: { current: () => null },
  }, location);
  await page.componentDidMount();
  assert.equal(location.href, '');
});

test('admin expiry stops camera and polling and cannot restart polling during mount', async () => {
  let handler, current = { role: 'SUPER_ADMIN' }, stopped = 0, cameraStopped = 0, started = 0;
  const page = component('DLT Admin.dc.html', {
    boot: async () => {}, setUnauthenticatedHandler: fn => { handler = fn; },
    auth: { current: () => current },
  });
  page._stopLiveRefresh = () => stopped++;
  page._stopCamera = () => cameraStopped++;
  page._startLiveRefresh = () => started++;
  page._loadCore = async () => { current = null; handler(); };
  page._loadSection = async () => {};
  await page.componentDidMount();
  assert.equal(stopped, 1);
  assert.equal(cameraStopped, 1);
  assert.equal(started, 0);
  assert.equal(page.state.cameraOn, false);
  assert.equal(page.state.ready, true);
  assert.match(page.state.toast, /session ended/i);
  page.componentWillUnmount();
  assert.equal(handler, null);
});

test('rapid login clicks send one authentication request', async () => {
  let calls = 0, resolve;
  const pending = new Promise(r => { resolve = r; });
  const page = component('DLT Account.dc.html', { auth: {
    current: () => null, signIn: () => { calls++; return pending; },
  } });
  const requests = [page.submit(), page.submit()];
  const started = calls; resolve(); await Promise.all(requests);
  assert.equal(started, 1);
  assert.equal(page._submitInFlight, false);
});

test('rapid checkout clicks create one checkout and allow retry after a failure', async () => {
  let creates = 0, resolve;
  const pending = new Promise(r => { resolve = r; });
  const page = component('DLT Booking.dc.html', {
    bookings: { create: async () => { creates++; await pending; return { id: 'booking' }; } },
    payments: { createIntent: async () => { throw new Error('temporary failure'); } },
  });
  page.heldSeats = () => [{ seatNumber: '2B' }]; page.paxFor = () => ({ name: 'Student' });
  const requests = [page.startPayment(), page.startPayment()];
  const started = creates; resolve(); await Promise.all(requests);
  assert.equal(started, 1);
  assert.equal(page._paymentInFlight, false);
  assert.equal(page.state.error, 'temporary failure');
});

test('a payment confirmed while Checkout is open still shows the confirmed booking', async () => {
  /* Real failure: the webhook confirmed the booking while the student was in
     their UPI app, the seat poll returned no HELD seats, and the expiry check
     wiped bookingId - so the "confirmed" screen rendered with no booking. */
  let openCheckout;
  const booking = { id: 'b1', code: 'DLT-7Q2K', boardingCode: '4821', status: 'CONFIRMED',
    totalAmount: 320, passengers: [{ name: 'Student', studentId: 'S1', seatNumber: '2B', seatType: 'WINDOW', passStatus: 'VALID' }] };
  const page = component('DLT Booking.dc.html', {
    bookings: { create: async () => ({ id: 'b1' }), get: async id => { assert.equal(id, 'b1'); return booking; } },
    payments: { createIntent: async () => ({ paymentId: 'p1', providerOrderId: 'order_1' }) },
    checkout: {
      open: () => new Promise(r => { openCheckout = r; }),
      awaitConfirmation: async () => booking,
    },
    trips: { listPublic: async () => [], get: async () => ({ id: 't1', price: 320 }), seatMap: async () => ({ rows: [], held: [] }) },
    auth: { current: () => ({ phone: '9' }) },
  });
  page.state.tripId = 't1';
  page.heldSeats = () => page.state.data.held.length ? page.state.data.held : [{ seatNumber: '2B' }];
  page.paxFor = () => ({ name: 'Student' });
  page.state.data.held = [{ seatNumber: '2B' }];
  const paying = page.startPayment();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(page.state.step, 'checkout');
  page.state.data.held = [];        // seat poll after the webhook booked the seat
  page._expireCheck();              // the 1s presentation tick
  openCheckout({});
  await paying;
  assert.equal(page.state.step, 'done');
  assert.equal(page.state.bookingId, 'b1');
  assert.equal(page.state.data.booking && page.state.data.booking.code, 'DLT-7Q2K');
});

test('the signed-in student is not asked to type their own details twice', () => {
  const me = { name: 'Asha Rao', phone: '9876543210', studentId: 'WU2024017', role: 'STUDENT' };
  const page = component('DLT Booking.dc.html', {
    auth: { current: () => me },
    bookings: { validatePassenger: p => ({ name: !!p.name, studentId: !!p.studentId, phone: /^[6-9]\d{9}$/.test(p.phone) }) },
  });
  Object.assign(page.state, { ready: true, step: 'seats', tripId: 't1', contact: '',
    data: { ...page.state.data, trip: { id: 't1', price: 320 }, held: [{ seatNumber: '2B' }, { seatNumber: '2C' }] } });
  page.toPassengers();                     // Continue to passengers
  assert.equal(page.state.step, 'passengers');
  assert.deepEqual(page.paxFor('2B'), { name: 'Asha Rao', studentId: 'WU2024017', phone: '9876543210', seatNumber: '2B' });
  assert.deepEqual(page.paxFor('2C'), { name: '', studentId: '', phone: '', seatNumber: '2C' });
  page.setField('2C', 'name', 'Friend'); page.setField('2C', 'studentId', 'WU2024099'); page.setField('2C', 'phone', '9123456780');
  page.toReview();                         // Review booking: no second entry of the contact number
  assert.equal(page.state.error, null);
  assert.equal(page.state.step, 'review');
  assert.equal(page.state.contact, '9876543210');
});

test('details already typed for a seat are never overwritten by the account', () => {
  const page = component('DLT Booking.dc.html', { auth: { current: () => ({ name: 'Asha Rao', phone: '9876543210', studentId: 'WU2024017' }) } });
  Object.assign(page.state, { ready: true, step: 'seats', tripId: 't1',
    pax: { '2B': { name: 'Someone Else' } },
    data: { ...page.state.data, trip: { id: 't1', price: 320 }, held: [{ seatNumber: '2B' }] } });
  page.toPassengers();
  assert.deepEqual(page.paxFor('2B'), { name: 'Someone Else', studentId: '', phone: '', seatNumber: '2B' });
});
