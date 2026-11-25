import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function scanner({ native, scan = async () => ({ result: 'VALID' }) } = {}) {
  const source = readFileSync(new URL('../DLT Admin.dc.html', import.meta.url), 'utf8')
    .match(/<script[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/)[1];
  class Logic { setState(patch, done) { Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch); done?.(); } }
  const frames = [], timers = [];
  let stopped = 0, contextReads = 0;
  const stream = { getTracks: () => [{ stop: () => stopped++ }] };
  const win = { BarcodeDetector: native, jsQR: () => ({ data: 'real-test-token' }), isSecureContext: true };
  const doc = { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }) }) };
  const api = { auth: { current: () => ({ role: 'BOARDING_STAFF' }) }, boarding: {
    scan, context: async () => { contextReads++; return { assigned: true, trip: { id: 'assigned-trip' } }; },
    manifest: async () => ({ passengers: [] }), events: async () => [],
  } };
  const Page = new Function('DCLogic', 'DLT', 'window', 'navigator', 'document', 'setInterval', 'clearInterval', 'setTimeout',
    source + '\nreturn Component;')(Logic, api, win,
    { mediaDevices: { getUserMedia: async () => stream } }, doc,
    fn => { frames.push(fn); return frames.length; }, () => {}, fn => { timers.push(fn); return timers.length; });
  const page = new Page();
  page._video = { readyState: 2, videoWidth: 1280, videoHeight: 720, play: () => Promise.resolve() };
  return { page, frames, timers, stopped: () => stopped, contextReads: () => contextReads };
}

test('unsupported native QR decoder falls back to jsQR before starting capture', async () => {
  class Unsupported { constructor() { throw new Error('QR not supported'); } }
  const { page } = scanner({ native: Unsupported });
  await page._startCamera();
  assert.equal(page.state.engine, 'jsqr');
  page._stopCamera();
});

test('native detection failure falls back to decoding the same frame', async () => {
  class Broken { async detect() { throw new Error('native capture failed'); } }
  const { page, frames } = scanner({ native: Broken });
  const codes = [];
  page._doScan = async code => { codes.push(code); };
  await page._startCamera();
  await frames[0]();
  assert.deepEqual(codes, ['real-test-token']);
  assert.equal(page.state.engine, 'jsqr');
  page._stopCamera();
});

test('repeated scan clicks send only one in-flight validation request', async () => {
  let resolve, calls = 0;
  const pending = new Promise(r => { resolve = r; });
  const { page } = scanner({ scan: () => { calls++; return pending; } });
  page._loadBoarding = async () => {};
  const first = page._doScan('token');
  const second = page._doScan('token');
  assert.equal(calls, 1);
  resolve({ result: 'VALID' });
  await Promise.all([first, second]);
});

test('boarding refresh picks up an assignment made after the page opened', async () => {
  const { page, contextReads } = scanner();
  page.state.data.scannerTrip = { assigned: false, trip: null };
  await page._loadBoarding();
  assert.equal(contextReads(), 1);
  assert.equal(page.state.data.scannerTrip.trip.id, 'assigned-trip');
});

test('every supported boarding QR version decodes back to its exact token', () => {
  const ctx = vm.createContext({ window: {}, TextEncoder, Uint8Array, Uint8ClampedArray, console });
  vm.runInContext(readFileSync(new URL('../dlt-qr.js', import.meta.url), 'utf8'), ctx);
  vm.runInContext(readFileSync(new URL('../jsqr.vendor.js', import.meta.url), 'utf8'), ctx);
  for (const length of [6, 16, 30, 43, 60, 80, 100]) {
    const token = 'aB_09-'.repeat(18).slice(0, length);
    const qr = ctx.window.DLTQR.matrix(token), scale = 6, width = (qr.size + 8) * scale;
    const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.get(x, y))
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const i = (((y + 4) * scale + dy) * width + (x + 4) * scale + dx) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
      }
    assert.equal(ctx.jsQR(pixels, width, width)?.data, token, `version ${qr.version}`);
  }
});
