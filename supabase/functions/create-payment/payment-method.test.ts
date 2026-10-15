import { isAllowedPaymentMethod } from './payment-method.ts';

const METHODS = { QRIS: ['qris'], VA_BANK: ['bca_va'] };

Deno.test('only configured payment methods are accepted', () => {
  if (!isAllowedPaymentMethod(METHODS, 'QRIS')) throw Error('expected QRIS');
  if (!isAllowedPaymentMethod(METHODS, 'VA_BANK')) throw Error('expected VA_BANK');
});

Deno.test('unknown and non-string payment methods are rejected', () => {
  for (const method of [null, undefined, [], {}, 1, true, '', 'qris', 'QRIS ']) {
    if (isAllowedPaymentMethod(METHODS, method)) throw Error('invalid payment method');
  }
});
