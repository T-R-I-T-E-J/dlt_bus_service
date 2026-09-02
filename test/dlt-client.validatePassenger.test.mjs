/* DLT · test/dlt-client.validatePassenger.test.mjs
 *
 * Regression test for a bug reported directly on the Booking passenger step:
 * a valid phone (8886791166) and a valid name ("tritej") both showed inline
 * "invalid" errors that never cleared.
 *
 * ROOT CAUSE: dlt-client.js's validatePassenger() returned a single collapsed
 * boolean, but Booking.dc.html's renderVals() reads it as an object with
 * per-field flags (v.name / v.studentId / v.phone). On a boolean primitive
 * those are always undefined, so every field read as invalid the instant it
 * was touched — regardless of the actual value. The validation RULES
 * (regex, length thresholds) were never wrong; only the return shape was.
 * Confirmed against dlt-store.js's pre-migration prototype, which returned
 * exactly this per-field object shape.
 *
 * dlt-client.js is a browser module (references `window` at load time), so a
 * minimal window stub is provided here purely to let Node import it — this
 * does not change or duplicate any of the module's logic.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
const { DLT } = await import('../dlt-client.js');
const { validatePassenger } = DLT.bookings;

describe('DLT.bookings.validatePassenger — per-field result shape', () => {
  test('THE REPRODUCED BUG · a genuinely valid passenger is reported valid on every field', () => {
    const v = validatePassenger({ name: 'tritej', studentId: 'WU204118', phone: '8886791166' });
    assert.equal(v.name, true, 'name "tritej" (6 chars) must pass — the ≥3 char rule is unchanged');
    assert.equal(v.studentId, true);
    assert.equal(v.phone, true, '8886791166 matches ^[6-9]\\d{9}$ — starts with 8, 10 digits');
  });

  test('the result is a per-field object, not a collapsed boolean', () => {
    const v = validatePassenger({ name: 'Aarav Menon', studentId: 'WU204118', phone: '9876543210' });
    assert.equal(typeof v, 'object', 'must be an object so v.name/v.studentId/v.phone are readable');
    assert.notEqual(typeof v, 'boolean');
    assert.deepEqual(Object.keys(v).sort(), ['name', 'phone', 'studentId']);
  });

  test('a phone starting 6, 7, 8, or 9 is accepted — the documented product contract', () => {
    for (const prefix of ['6', '7', '8', '9']) {
      const phone = prefix + '123456789';
      assert.equal(validatePassenger({ name: 'Test User', studentId: 'WU100000', phone }).phone, true,
        `${phone} should be accepted`);
    }
  });

  test('a phone NOT starting 6-9, or the wrong length, is still correctly rejected', () => {
    assert.equal(validatePassenger({ name: 'Test User', studentId: 'WU100000', phone: '5886791166' }).phone,
      false, 'leading 5 is not a valid Indian mobile prefix');
    assert.equal(validatePassenger({ name: 'Test User', studentId: 'WU100000', phone: '888679116' }).phone,
      false, '9 digits is too short');
    assert.equal(validatePassenger({ name: 'Test User', studentId: 'WU100000', phone: '88867911660' }).phone,
      false, '11 digits is too long');
  });

  test('an empty phone remains permitted — the field is optional, matching the server schema', () => {
    assert.equal(validatePassenger({ name: 'Test User', studentId: 'WU100000', phone: '' }).phone, true);
    assert.equal(validatePassenger({ name: 'Test User', studentId: 'WU100000' }).phone, true);
  });

  test('a short name is still correctly rejected — the rule itself did not weaken', () => {
    assert.equal(validatePassenger({ name: 'Al', studentId: 'WU100000', phone: '9876543210' }).name, false);
    assert.equal(validatePassenger({ name: '  ', studentId: 'WU100000', phone: '9876543210' }).name, false);
  });

  test('a malformed student ID is still correctly rejected', () => {
    assert.equal(validatePassenger({ name: 'Test User', studentId: 'WU', phone: '9876543210' }).studentId, false);
    assert.equal(validatePassenger({ name: 'Test User', studentId: '', phone: '9876543210' }).studentId, false);
  });

  test('no passenger object at all — every field reads false, not a crash', () => {
    const v = validatePassenger(null);
    assert.deepEqual(v, { name: false, studentId: false, phone: false });
  });
});
