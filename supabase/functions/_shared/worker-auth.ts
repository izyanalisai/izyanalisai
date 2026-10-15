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
