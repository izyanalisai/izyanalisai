import { hasValidWorkerSecret } from './worker-auth.ts'

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
