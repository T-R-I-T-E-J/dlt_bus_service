import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { httpTransport } from '../src/integrations/email/index.ts';
import { AppError } from '../src/domain/errors.ts';

const originalFetch = globalThis.fetch;
type CapturedRequest = { url: string; init: RequestInit };

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Resend HTTPS email transport', () => {
  test('posts the existing verification template to Resend without exposing secrets', async () => {
    let capturedRequest: CapturedRequest | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedRequest = { url: String(url), init: init! };
      return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
    }) as typeof fetch;

    const transport = httpTransport({
      apiKey: 're_test_key',
      fromAddress: 'no-reply@dlt.co.in',
      fromName: 'DLT',
    });

    await transport.send({
      to: 'student@woxsen.edu.in',
      template: 'verify-email',
      vars: { name: 'Aarav Menon', code: '123456' },
    });

    assert.ok(capturedRequest);
    const request = capturedRequest;
    assert.equal(transport.name, 'resend');
    assert.equal(request.url, 'https://api.resend.com/emails');
    assert.equal(request.init.method, 'POST');
    assert.equal((request.init.headers as Record<string, string>).authorization, 'Bearer re_test_key');
    assert.equal((request.init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.equal((request.init.headers as Record<string, string>)['user-agent'], 'dlt-bus-service/0.1');

    const body = JSON.parse(String(request.init.body));
    assert.deepEqual(body.to, ['student@woxsen.edu.in']);
    assert.equal(body.from, 'DLT <no-reply@dlt.co.in>');
    assert.equal(body.subject, 'Verify your DLT account');
    assert.match(body.text, /123456/);
    assert.match(body.html, /123456/);
  });

  test('turns Resend failures into the existing generic email error', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'bad key' }), { status: 403 })) as typeof fetch;

    const transport = httpTransport({
      apiKey: 're_test_key',
      fromAddress: 'no-reply@dlt.co.in',
      fromName: 'DLT',
    });

    await assert.rejects(
      transport.send({
        to: 'student@woxsen.edu.in',
        template: 'password-reset',
        vars: { name: 'Aarav Menon', code: '654321', minutes: 30 },
      }),
      (e: unknown) => {
        assert.ok(e instanceof AppError);
        assert.equal(e.code, 'INTERNAL');
        assert.equal(e.message, 'We could not send that email. Try again shortly.');
        return true;
      },
    );
  });
});
