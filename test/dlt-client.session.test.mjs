import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {};

async function sessionClient(name) {
  const client = await import('../dlt-client.js?session-test=' + name);
  globalThis.fetch = async () => new Response(JSON.stringify({
    user: { id: 'operator', role: 'SUPER_ADMIN' }, permissions: ['trip.read'],
  }), { status: 200 });
  await client.boot();
  return client;
}

test('expired protected requests clear identity and permissions before notifying the screen', async () => {
  const { DLT, setUnauthenticatedHandler } = await sessionClient('expired');
  let notifications = 0, handled = 0;
  DLT.subscribe(() => { notifications++; assert.equal(DLT.auth.current(), null); });
  setUnauthenticatedHandler(() => {
    handled++;
    assert.equal(DLT.auth.current(), null);
    assert.equal(DLT.can('SUPER_ADMIN', 'trip.read'), false);
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 'UNAUTHENTICATED', message: 'Sign in required' },
  }), { status: 401 });
  await assert.rejects(DLT.admin.listAllTrips(), { code: 'UNAUTHENTICATED' });
  assert.equal(notifications, 1);
  assert.equal(handled, 1);
});

test('incorrect credentials do not expire a valid cached session', async () => {
  const { DLT, setUnauthenticatedHandler } = await sessionClient('credentials');
  let handled = 0;
  setUnauthenticatedHandler(() => handled++);
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' },
  }), { status: 401 });
  await assert.rejects(DLT.auth.signIn('operator@example.com', 'wrong'), { code: 'INVALID_CREDENTIALS' });
  assert.equal(DLT.auth.current().role, 'SUPER_ADMIN');
  assert.equal(DLT.can('SUPER_ADMIN', 'trip.read'), true);
  assert.equal(handled, 0);
});
