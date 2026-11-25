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
