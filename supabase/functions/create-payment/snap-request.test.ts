import { requestSnap } from './snap-request.ts';

const args = ['https://app.sandbox.midtrans.com/snap/v1/transactions',
  'sandbox-key', 'IZY-test', 59000, ['qris'], 'test@example.com'] as const;
function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new Error(message);
}
function fakeResponse(status: number, body: string): typeof fetch {
  return (async (_url, options) => {
    assert(options?.signal instanceof AbortSignal, 'missing timeout signal');
    return new Response(body, { status });
  }) as typeof fetch;
}

Deno.test('Snap returns token and redirect for a complete successful response', async () => {
  const outcome = await requestSnap(...args, fakeResponse(
    201, JSON.stringify({ token: 'sandbox-only', redirect_url: 'https://app.sandbox.midtrans.com/checkout' }),
  ));
  assert(outcome.kind === 'issued');
  assert(outcome.token === 'sandbox-only');
});

Deno.test('provider 4xx is definitive rejection', async () => {
  const outcome = await requestSnap(...args, fakeResponse(400, '{"error":"bad order"}'));
  assert(outcome.kind === 'rejected');
});

Deno.test('provider 5xx remains unknown, not rejected', async () => {
  const outcome = await requestSnap(...args, fakeResponse(500, '{"error":"server failed"}'));
  assert(outcome.kind === 'unknown');
});

Deno.test('network rejection is an unknown order outcome', async () => {
  const fail = (async () => { throw new Error('no network'); }) as typeof fetch;
  const outcome = await requestSnap(...args, fail);
  assert(outcome.kind === 'unknown');
});

Deno.test('malformed success response is not returned as payable', async () => {
  const invalidJson = await requestSnap(...args, fakeResponse(200, '<html>bad gateway</html>'));
  const missingToken = await requestSnap(...args, fakeResponse(200, '{"redirect_url":"https://example.org"}'));
  assert(invalidJson.kind === 'unknown');
  assert(missingToken.kind === 'unknown');
});
