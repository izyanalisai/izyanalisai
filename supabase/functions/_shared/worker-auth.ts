/** Verify a private scheduler header before running service-role jobs. */
export async function hasValidSecretHeader(
  request: Request,
  expected: string | null | undefined,
  headerName: string,
): Promise<boolean> {
  const provided = request.headers.get(headerName)
  // Do not accept short, unset, or unbounded credentials, even if both sides
  // accidentally default to the same value.
  if (!expected || expected.length < 32 || expected.length > 512 ||
      !provided || provided.length !== expected.length) return false

  const encoder = new TextEncoder()
  const [expectedDigest, providedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
  ])
  const a = new Uint8Array(expectedDigest)
  const b = new Uint8Array(providedDigest)
  let different = 0
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i]
  return different === 0
}

export async function hasValidWorkerSecret(
  request: Request,
  expected: string | null | undefined,
): Promise<boolean> {
  return hasValidSecretHeader(request, expected, 'x-worker-secret')
}

/**
 * Authorize service-role scheduled jobs, including safely handling a missing
 * or temporarily unavailable configured secret. Never run the privileged
 * operation or reveal provider/database details to an unauthenticated caller.
 */
export async function rejectUnauthorizedWorker(
  request: Request,
  lookupSecret: () => Promise<string | null | undefined>,
): Promise<Response | null> {
  if (!request.headers.get('x-worker-secret')) {
    return new Response('UNAUTHORIZED', { status: 401 })
  }
  let expected: string | null | undefined
  try {
    expected = await lookupSecret()
  } catch {
    return new Response('WORKER_UNAVAILABLE', { status: 503 })
  }
  if (!expected || expected.length < 32) {
    return new Response('WORKER_UNAVAILABLE', { status: 503 })
  }
  if (!(await hasValidWorkerSecret(request, expected))) {
    return new Response('UNAUTHORIZED', { status: 401 })
  }
  return null
}
