import { hasValidWorkerSecret, hasValidSecretHeader, rejectUnauthorizedWorker } from './worker-auth.ts'

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

Deno.test('privileged worker guard denies absent header without reading database', async () => {
  let lookedUp = false
  const request = new Request('https://example.invalid/job')
  const response = await rejectUnauthorizedWorker(request, async () => {
    lookedUp = true
    return secret
  })
  if (response?.status !== 401 || lookedUp) throw new Error('Missing header did not fail early')
})

Deno.test('privileged worker guard fails closed on secret-storage outage', async () => {
  const request = new Request('https://example.invalid/job', {
    headers: {'x-worker-secret': secret},
  })
  const response = await rejectUnauthorizedWorker(request, async () => {
    throw new Error('Secret storage is offline')
  })
  if (response?.status !== 503) throw new Error('Secret-storage outage permitted a worker')
})

Deno.test('privileged worker guard rejects invalid and weak stored secrets', async () => {
  const request = new Request('https://example.invalid/job', {
    headers: {'x-worker-secret': secret},
  })
  if ((await rejectUnauthorizedWorker(request, async () => 'short'))?.status !== 503)
    throw new Error('Weak configured credential permitted')
  if ((await rejectUnauthorizedWorker(request, async () => secret.replace('123', '456')))?.status !== 401)
    throw new Error('Invalid worker credential permitted')
})

Deno.test('privileged worker guard admits an exactly matching authorized worker', async () => {
  const request = new Request('https://example.invalid/job', {
    headers: {'x-worker-secret': secret},
  })
  if ((await rejectUnauthorizedWorker(request, async () => secret)) !== null)
    throw new Error('Authorized worker rejected')
})
