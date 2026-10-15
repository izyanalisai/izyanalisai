import { verifyProviderStatus } from './provider-status.ts';

const base = {
  order_id: 'IZY-example', gross_amount: '59000.00',
  transaction_status: 'settlement', fraud_status: 'accept',
};
function expect(actual: string, expected: string) {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}
Deno.test('confirmed settlement with exact order and IDR amount', () => {
  expect(verifyProviderStatus(base, 'IZY-example', 59000), 'success');
});
Deno.test('tampered order, amount, and malformed payload cannot grant access', () => {
  expect(verifyProviderStatus({ ...base, order_id: 'IZY-other' }, 'IZY-example', 59000), 'mismatch');
  expect(verifyProviderStatus({ ...base, gross_amount: '59000.01' }, 'IZY-example', 59000), 'mismatch');
  expect(verifyProviderStatus({ ...base, gross_amount: '59000xyz' }, 'IZY-example', 59000), 'mismatch');
  expect(verifyProviderStatus([], 'IZY-example', 59000), 'unknown');
});
Deno.test('pending, expired, failed, and refunded remain distinct', () => {
  expect(verifyProviderStatus({ ...base, transaction_status: 'pending' }, 'IZY-example', 59000), 'pending');
  expect(verifyProviderStatus({ ...base, transaction_status: 'expire' }, 'IZY-example', 59000), 'expired');
  expect(verifyProviderStatus({ ...base, transaction_status: 'cancel' }, 'IZY-example', 59000), 'failed');
  expect(verifyProviderStatus({ ...base, transaction_status: 'refund' }, 'IZY-example', 59000), 'unknown');
  expect(verifyProviderStatus({ ...base, transaction_status: 'capture', fraud_status: 'challenge' }, 'IZY-example', 59000), 'pending');
});
