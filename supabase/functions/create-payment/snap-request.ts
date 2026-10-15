/** Midtrans Snap request: distinguish definitive rejection from ambiguous outcomes.
 * A network failure, 5xx or malformed response must not be treated as proof that
 * Midtrans never accepted an order.
 */
export type SnapOutcome =
  | { kind: 'issued'; token: string; redirect_url: string }
  | { kind: 'rejected' }
  | { kind: 'unknown' };

export async function requestSnap(
  endpoint: string,
  basicAuthorization: string,
  orderId: string,
  amountIdr: number,
  enabledPayments: readonly string[],
  email: string | undefined,
  send: typeof fetch = fetch,
): Promise<SnapOutcome> {
  let response: Response;
  try {
    response = await send(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicAuthorization}`,
      },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        transaction_details: { order_id: orderId, gross_amount: amountIdr },
        enabled_payments: enabledPayments,
        customer_details: { email },
      }),
    });
  } catch {
    return { kind: 'unknown' };
  }
  // Only a provider 4xx is a definitive request rejection. A 5xx may have
  // occurred after order creation, so it needs reconciliation.
  if (response.status >= 400 && response.status < 500) {
    return { kind: 'rejected' };
  }
  if (!response.ok) return { kind: 'unknown' };
  try {
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object') return { kind: 'unknown' };
    const data = payload as Record<string, unknown>;
    if (typeof data.token !== 'string' || !data.token.trim() ||
        typeof data.redirect_url !== 'string' || !data.redirect_url.trim()) {
      return { kind: 'unknown' };
    }
    return { kind: 'issued', token: data.token, redirect_url: data.redirect_url };
  } catch {
    return { kind: 'unknown' };
  }
}
