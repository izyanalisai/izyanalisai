// Deno test untuk logic murni signature.ts. Jalankan: deno test signature.test.ts
// (atau `supabase functions test` kalau nanti runner test Supabase Edge Functions
// sudah dipasang -- untuk sekarang cukup `deno test` langsung, tidak butuh Supabase
// client / server berjalan sama sekali).

import { assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { sha512Hex, verifyMidtransSignature, resolvePaymentStatus } from './signature.ts';

Deno.test('sha512Hex - hasil cocok dengan vektor SHA-512 dikenal', async () => {
  // SHA-512("") -- vektor kosong, nilai baku yang bisa dicek ulang di sumber manapun
  const hash = await sha512Hex('');
  assertEquals(
    hash,
    'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e'
  );
});

Deno.test('verifyMidtransSignature - signature valid dikenali cocok', async () => {
  const orderId = 'ORDER-123';
  const statusCode = '200';
  const grossAmount = '59000.00';
  const serverKey = 'SB-Mid-server-DUMMY-KEY';
  const validSignature = await sha512Hex(orderId + statusCode + grossAmount + serverKey);

  const ok = await verifyMidtransSignature({
    orderId,
    statusCode,
    grossAmount,
    serverKey,
    signatureKey: validSignature,
  });
  assertEquals(ok, true);
});

Deno.test('verifyMidtransSignature - signature yang dipalsukan HARUS ditolak', async () => {
  const ok = await verifyMidtransSignature({
    orderId: 'ORDER-123',
    statusCode: '200',
    grossAmount: '59000.00',
    serverKey: 'SB-Mid-server-DUMMY-KEY',
    signatureKey: 'signature-ngasal-dari-penyerang',
  });
  assertEquals(ok, false);
});

Deno.test('verifyMidtransSignature - gross_amount digeser sedikit pun HARUS gagal (deteksi tampering)', async () => {
  const orderId = 'ORDER-123';
  const statusCode = '200';
  const serverKey = 'SB-Mid-server-DUMMY-KEY';
  // signature dihitung untuk 59000.00, tapi kita klaim gross_amount 1.00
  // (skenario: penyerang coba downgrade nilai transaksi tapi pakai signature lama)
  const validSignature = await sha512Hex(orderId + statusCode + '59000.00' + serverKey);

  const ok = await verifyMidtransSignature({
    orderId,
    statusCode,
    grossAmount: '1.00',
    serverKey,
    signatureKey: validSignature,
  });
  assertEquals(ok, false);
});

Deno.test('verifyMidtransSignature - server key salah (misconfig) HARUS gagal, bukan malah lolos', async () => {
  const orderId = 'ORDER-123';
  const statusCode = '200';
  const grossAmount = '59000.00';
  const validSignature = await sha512Hex(orderId + statusCode + grossAmount + 'server-key-asli');

  const ok = await verifyMidtransSignature({
    orderId,
    statusCode,
    grossAmount,
    serverKey: 'server-key-BEDA',
    signatureKey: validSignature,
  });
  assertEquals(ok, false);
});

Deno.test('resolvePaymentStatus - capture + fraud accept -> success', () => {
  assertEquals(
    resolvePaymentStatus({ transactionStatus: 'capture', fraudStatus: 'accept' }),
    'success'
  );
});

Deno.test('resolvePaymentStatus - capture + fraud challenge/deny -> BUKAN success (celah fraud harus ditolak)', () => {
  assertEquals(resolvePaymentStatus({ transactionStatus: 'capture', fraudStatus: 'challenge' }), null);
  assertEquals(resolvePaymentStatus({ transactionStatus: 'capture', fraudStatus: 'deny' }), null);
});

Deno.test('resolvePaymentStatus - settlement -> success (fraud_status tidak relevan utk settlement)', () => {
  assertEquals(resolvePaymentStatus({ transactionStatus: 'settlement', fraudStatus: '' }), 'success');
});

Deno.test('resolvePaymentStatus - pending -> pending', () => {
  assertEquals(resolvePaymentStatus({ transactionStatus: 'pending', fraudStatus: '' }), 'pending');
});

Deno.test('resolvePaymentStatus - expire -> expired (bukan "failed")', () => {
  assertEquals(resolvePaymentStatus({ transactionStatus: 'expire', fraudStatus: '' }), 'expired');
});

for (const status of ['deny', 'cancel', 'failure']) {
  Deno.test(`resolvePaymentStatus - ${status} -> failed`, () => {
    assertEquals(resolvePaymentStatus({ transactionStatus: status, fraudStatus: '' }), 'failed');
  });
}

Deno.test('resolvePaymentStatus - status tak dikenal -> null (jangan diam-diam dianggap sukses)', () => {
  assertEquals(resolvePaymentStatus({ transactionStatus: 'authorize', fraudStatus: '' }), null);
});
