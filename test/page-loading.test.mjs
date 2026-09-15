import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function component(page, api) {
  const html = readFileSync(new URL('../' + page, import.meta.url), 'utf8');
  const source = html.match(/<script[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/)[1];
  class Logic {
    setState(patch, done) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      done?.();
    }
  }
  const Page = new Function('DCLogic', 'DLT', 'window', source + '\nreturn Component;')(Logic, api, { DLT: api });
  const pageInstance = new Page();
  pageInstance.fail = error => { throw error; };
  return pageInstance;
}

test('admin refresh skips unchanged data and merges queued responses', () => {
  const page = component('DLT Admin.dc.html', {});
  const queued = [];
  page.setState = update => queued.push(update);
  page._patch({ vehicles: [{ id: 'vehicle' }] });
  page._patch({ staff: [{ id: 'staff' }] });
  for (const update of queued) Object.assign(page.state, update(page.state));
  assert.equal(page.state.data.vehicles[0].id, 'vehicle');
  assert.equal(page.state.data.staff[0].id, 'staff');
  queued.length = 0;
  page._patch({ vehicles: [{ id: 'vehicle' }] });
  assert.equal(queued[0](page.state), null);
});

test('booking starts independent reads together and preserves server seat state', async () => {
  const started = [];
  const pending = [];
  const read = (name, value) => () => {
    started.push(name);
    return new Promise(resolve => pending.push(() => resolve(value)));
  };
  const api = {
    trips: { listPublic: read('trips', [{ id: 'trip' }]), get: read('trip', { id: 'trip' }),
      seatMap: read('seats', { rows: ['1A'], held: ['1A'] }) },
    bookings: { get: read('booking', { id: 'booking' }) },
    auth: { current: () => ({ role: 'STUDENT' }) },
    waitlist: { mine: read('waitlist', []) }
  };
  const page = component('DLT Booking.dc.html', api);
  Object.assign(page.state, { tripId: 'trip', bookingId: 'booking' });
  const loading = page._load();
  assert.deepEqual(started, ['trips', 'trip', 'seats', 'booking', 'waitlist']);
  pending.forEach(resolve => resolve());
  await loading;
  assert.deepEqual(page.state.data.held, ['1A']);
  assert.equal(page.state.data.booking.id, 'booking');
  assert.equal(page.state.loading, false);
});

test('dashboard keeps bookings when optional waitlist fails', async () => {
  const api = {
    auth: { current: () => ({ role: 'STUDENT' }) },
    bookings: { mine: async () => [{ id: 'booking' }] },
    trips: { listPublic: async () => [{ id: 'trip' }] },
    waitlist: { mine: async () => { throw new Error('unavailable'); } }
  };
  const page = component('DLT Dashboard.dc.html', api);
  page._loadPasses = () => {};
  await page._load();
  assert.equal(page.state.data.bookings[0].id, 'booking');
  assert.deepEqual(page.state.data.waitlist, []);
  assert.equal(page.state.loading, false);
});
