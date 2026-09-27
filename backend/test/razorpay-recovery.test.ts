import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRazorpayProvider } from '../src/integrations/razorpay/index.ts';

const provider = () => createRazorpayProvider({ keyId: 'test-key', keySecret: 'test-secret',
  webhookSecrets: ['test-webhook'], baseUrl: 'https://provider.invalid/v1' });

test('refund retries send the same dedicated idempotency key and body', async (t) => {
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    requests.push(init);
    if (requests.length === 1) throw new Error('response lost after provider accepted refund');
    return Response.json({ id: 'rfnd_one', status: 'pending' });
  });
  const p = provider();
  const input = { providerPaymentId: 'pay_capture', amountRupees: 259,
    reference: '550e8400-e29b-41d4-a716-446655440000', note: 'Student cancellation' };
  await assert.rejects(p.createRefund(input), /response lost/);
  assert.equal((await p.createRefund(input)).providerRefundId, 'rfnd_one');
  for (const request of requests) {
    assert.equal(new Headers(request.headers).get('X-Refund-Idempotency'), input.reference);
    assert.ok(request.signal, 'network requests have a timeout');
  }
  assert.equal(requests[0].body, requests[1].body);
});

test('paid order with failed payment lookup must retry instead of confirming without a payment ID', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (String(url).endsWith('/payments')) throw new Error('payment lookup unavailable');
    return Response.json({ id: 'order_paid', status: 'paid', amount: 25900 });
  });
  await assert.rejects(provider().fetchOrder('order_paid'), /payment lookup unavailable/);
});

test('paid order without captured payment must retry', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => Response.json(
    String(url).endsWith('/payments') ? { items: [{ id: 'pay_auth', status: 'authorized' }] }
      : { id: 'order_paid', status: 'paid', amount: 25900 }));
  await assert.rejects(provider().fetchOrder('order_paid'), /no captured payment/);
});

test('reconciliation uses captured payment identity and actual amount over an earlier failed attempt', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => Response.json(
    String(url).endsWith('/payments') ? { items: [
      { id: 'pay_failed', status: 'failed', amount: 25900 },
      { id: 'pay_capture', status: 'captured', amount: 20000 },
    ] } : { id: 'order_paid', status: 'paid', amount: 25900 }));
  const order = await provider().fetchOrder('order_paid');
  assert.equal(order.kind, 'PAYMENT_SUCCEEDED');
  assert.equal(order.paymentId, 'pay_capture');
  assert.equal(order.amountRupees, 200);
});
