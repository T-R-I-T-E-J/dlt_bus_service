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
