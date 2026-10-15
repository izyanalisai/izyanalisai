/** Do not create paid transactions when the rate limiter is unavailable. */
export function decidePaymentRateLimit(
  allowed: boolean | null | undefined,
  error: unknown,
): { status: number; error: string } | null {
  if (error != null || allowed == null) {
    return { status: 503, error: 'RATE_LIMIT_UNAVAILABLE' };
  }
  if (allowed !== true) {
    return { status: 429, error: 'RATE_LIMITED' };
  }
  return null;
}
