/** Treat payment status API responses as external evidence, not instructions.
 * A provider order and its amount must match our stored payment exactly.
 */
export type ReconciledProviderStatus =
  | 'success' | 'pending' | 'failed' | 'expired'
  | 'mismatch' | 'unknown';

function cents(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = /^([0-9]{1,14})(?:\\.([0-9]{1,2}))?$/.exec(String(value));
  if (!match) return null;
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}

export function verifyProviderStatus(
  source: unknown, expectedOrderId: string, expectedAmount: number | string,
): ReconciledProviderStatus {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return 'unknown';
  const data = source as Record<string, unknown>;
  if (typeof data.order_id !== 'string' ||
      data.order_id !== expectedOrderId ||
      cents(data.gross_amount) === null ||
      cents(data.gross_amount) !== cents(expectedAmount)) return 'mismatch';
  const status = data.transaction_status;
  if (typeof status !== 'string') return 'unknown';
  if (status === 'settlement' || (status === 'capture' && data.fraud_status === 'accept')) return 'success';
  if (status === 'pending' || (status === 'capture' && data.fraud_status !== 'accept')) return 'pending';
  if (status === 'expire') return 'expired';
  if (status === 'deny' || status === 'cancel' || status === 'failure') return 'failed';
  // refund, chargeback and unknown transitions require human reconciliation.
  return 'unknown';
}
