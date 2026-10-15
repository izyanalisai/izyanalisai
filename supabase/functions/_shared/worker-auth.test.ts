import { hasValidWorkerSecret, hasValidSecretHeader } from './worker-auth.ts'

const secret = 'worker-auth-test-secret-with-adequate-entropy-123'

Deno.test('rejects requests without a worker secret', async () => {
  const request = new Request('https://example.invalid/task', {method: 'POST'})
  if (await hasValidWorkerSecret(request, secret)) throw new Error('missing secret permitted')
})

Deno.test('rejects unset and short configured secrets', async () => {
  for (const expected of [undefined, null, '', 'password']) {
    const request = new Request('https://example.invalid/task', {
      method: 'POST', headers: {'x-worker-secret': String(expected || 'password')},
    })
    if (await hasValidWorkerSecret(request, expected)) throw new Error('weak secret permitted')
  }
})

Deno.test('rejects invalid credentials of equal length', async () => {
  const request = new Request('https://example.invalid/task', {
    method: 'POST', headers: {'x-worker-secret': secret.replace('123','456')},
  })
  if (await hasValidWorkerSecret(request, secret)) throw new Error('incorrect secret permitted')
})

Deno.test('rejects credentials of different lengths', async () => {
  const request = new Request('https://example.invalid/task', {
    method: 'POST', headers: {'x-worker-secret': secret.slice(1)},
  })
  if (await hasValidWorkerSecret(request, secret)) throw new Error('truncated secret permitted')
})

Deno.test('accepts exactly matching configured worker credentials', async () => {
  const request = new Request('https://example.invalid/task', {
    method: 'POST', headers: {'x-worker-secret': secret},
  })
  if (!(await hasValidWorkerSecret(request, secret))) throw new Error('valid worker rejected')
})

Deno.test('Telegram signature header is mandatory and checked independently', async () => {
  const signedRequest = new Request('https://example.invalid/telegram', {
    method: 'POST', headers: {'x-telegram-bot-api-secret-token': secret},
  })
  if (!(await hasValidSecretHeader(signedRequest, secret, 'x-telegram-bot-api-secret-token')))
    throw new Error('valid Telegram header rejected')
  if (await hasValidWorkerSecret(signedRequest, secret))
    throw new Error('Telegram header improperly accepted as worker credential')
  const unsigned = new Request('https://example.invalid/telegram', { method: 'POST' })
  if (await hasValidSecretHeader(unsigned, secret, 'x-telegram-bot-api-secret-token'))
    throw new Error('unsigned Telegram webhook permitted')
})
