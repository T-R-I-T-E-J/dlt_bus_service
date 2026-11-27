/* The seat fare is shown as ₹299 + ₹21 GST = ₹320. The server's price is what
 * is charged; this split is presentation only and must always add back up to it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
const { DLT } = await import('../dlt-client.js');

test('a ₹320 seat is shown as ₹299 fare + ₹21 GST', () => {
  assert.deepEqual(DLT.fare.split(320), { base: 299, gst: 21, total: 320 });
});

test('several seats multiply both parts and still add up to the charge', () => {
  assert.deepEqual(DLT.fare.split(320, 3), { base: 897, gst: 63, total: 960 });
});

test('no price from the server means no invented breakdown', () => {
  assert.equal(DLT.fare.split(null), null);
  assert.equal(DLT.fare.split(undefined, 2), null);
  assert.equal(DLT.fare.split(10), null);
});

const { readFileSync } = await import('node:fs');
function screen(file) {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    .match(/<script[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/)[1];
  class Logic { props = {}; setState(patch) { Object.assign(this.state, patch); } }
  const api = { ...DLT, auth: { current: () => ({ name: 'Test Student', role: 'STUDENT', phone: '9876543210' }) } };
  const browser = { DLT: api, matchMedia: () => ({ matches: true }) };
  return new (new Function('DCLogic', 'DLT', 'window', source + '\nreturn Component;')(Logic, api, browser))();
}
const trip = { id: 'trip', price: 320, departureAt: '2027-01-01T08:00:00Z',
  reportingAt: '2027-01-01T07:30:00Z', arrivalEstimateAt: '2027-01-01T10:00:00Z',
  origin: 'Woxsen', destination: 'Miyapur', capacity: 44, available: 40, bookable: true };

test('homepage advertises the tax-exclusive fare for each departure', () => {
  const page = screen('DLT Homepage.dc.html');
  page.state.data.trips = [trip];
  const view = page.renderVals();
  assert.equal(view.fare, '299');
  assert.match(view.fareNote, /excluding tax/);
  assert.equal(view.trips[0].price, 299);
});

test('selection shows base fares, then review reveals GST and the full charge for one or several seats', () => {
  for (const n of [1, 3, 5]) {
    const page = screen('DLT Booking.dc.html');
    const held = Array.from({ length: n }, (_, i) => ({ seatNumber: `${i+2}A`, seatType: 'WINDOW' }));
    Object.assign(page.state, { ready: true, step: 'seats' });
    Object.assign(page.state.data, { trip, openTrips: [trip] });
    page.heldSeats = () => held;
    for (const phase of ['seats', 'passengers', 'review']) {
      page.state.step = phase;
      const view = page.renderVals();
      assert.equal(view.departureFare, 299);
      assert.equal(view.seatRows[0].price, 299);
      assert.match(view.summaryLineLabel, /excluding tax/);
      assert.equal(view.total, n * 320, 'payment authority remains the full amount');
      if (phase === 'review') {
        assert.equal(view.summaryGst, `₹${n*21}`);
        assert.equal(view.summaryTotal, `₹${n*320}`);
        assert.equal(view.summaryTotalLabel, 'Total payable');
        assert.equal(view.primaryLabel, `Pay ₹${n*320}`);
        assert.match(view.summaryTaxNote, /excluding tax.*GST/);
      } else {
        assert.equal(view.summaryGst, null);
        assert.equal(view.summaryTotal, `₹${n*299}`);
        assert.match(view.summaryTotalLabel, /excluding tax/);
      }
    }
  }
});

test('boarding pass and receipt distinguish fare, tax and the actual charged total', () => {
  const page = screen('DLT Dashboard.dc.html');
  const booking = { id: 'booking', code: 'DLT-DEMO', status: 'CONFIRMED', trip,
    unitPrice: 320, totalAmount: 640, passengers: [{ seatNumber: '2A' }, { seatNumber: '2B' }],
    payment: { status: 'SUCCESS' }, refunds: [] };
  Object.assign(page.state, { ready: true, loading: false, receiptOpen: true });
  Object.assign(page.state.data, { bookings: [booking], openTrips: [trip], passesBookingId: booking.id, passes: [{
    name: 'Test Student', studentId: 'TEST1', seatNumber: '2A', passStatus: 'VALID',
    fareShare: 320, total: 640, paymentStatus: 'SUCCESS', departureAt: trip.departureAt,
    reportingAt: trip.reportingAt, route: 'Woxsen → Miyapur',
  }] });
  const view = page.renderVals();
  const pass = Object.fromEntries(view.passFacts.map(r => [r.k, r.v]));
  assert.equal(pass['Fare (excluding tax)'], '₹299');
  assert.equal(pass.GST, '₹21');
  assert.equal(pass['Seat total'], '₹320');
  const receipt = Object.fromEntries(view.receiptRows.map(r => [r.k, r.v]));
  assert.equal(receipt['Fare (excluding tax)'], '₹299 × 2');
  assert.equal(receipt.GST, '₹21 × 2');
  assert.equal(receipt['Total charged'], '₹640');
  assert.match(view.openTripsLabel, /₹299 excluding tax/);
});

test('the home next-trip banner resolves route details from the public departure',()=>{
 const p=screen('DLT Homepage.dc.html');p.state.ready=true;
 p.state.data.trips=[trip];p.state.data.nextBooking={id:'booking',trip:{id:trip.id,departureAt:trip.departureAt,reportingAt:trip.reportingAt},passengers:[{seatNumber:'2A'}]};
 const view=p.renderVals();assert.match(view.nextTripWhen,/Woxsen -> Miyapur/);assert.doesNotMatch(view.nextTripWhen,/undefined/);
});
