// Logic murni (tanpa I/O) yang di-extract dari midtrans-webhook/index.ts supaya
// bisa dites otomatis (Deno test) tanpa perlu spin up server / mock Supabase client.
// Spec v6.1 section 4 prioritas #2 butir 2: payment webhook -- signature verification,
// idempotency.

/**
 * SHA-512 hex digest, dipakai untuk verifikasi signature Midtrans.
 */
export async function sha512Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-512', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verifikasi signature_key dari webhook Midtrans.
 * Formula resmi Midtrans: SHA512(order_id + status_code + gross_amount + ServerKey)
 * https://docs.midtrans.com/docs/https-notification-webhooks
 */
export async function verifyMidtransSignature(params: {
  orderId: string;
  statusCode: string;
  grossAmount: string;
  serverKey: string;
  signatureKey: string;
}): Promise<boolean> {
  const { orderId, statusCode, grossAmount, serverKey, signatureKey } = params;
  const expected = await sha512Hex(orderId + statusCode + grossAmount + serverKey);
  return expected === signatureKey;
}

/**
 * Menentukan status pembayaran internal dari transaction_status + fraud_status
 * Midtrans. Pure function -- tidak menyentuh DB.
 */
export function resolvePaymentStatus(params: {
  transactionStatus: string;
  fraudStatus: string;
}): 'success' | 'pending' | 'failed' | 'expired' | null {
  const { transactionStatus, fraudStatus } = params;
  if ((transactionStatus === 'capture' && fraudStatus === 'accept') || transactionStatus === 'settlement') {
    return 'success';
  }
  if (transactionStatus === 'pending') {
    return 'pending';
  }
  if (['deny', 'cancel', 'expire', 'failure'].includes(transactionStatus)) {
    return transactionStatus === 'expire' ? 'expired' : 'failed';
  }
  return null;
}
