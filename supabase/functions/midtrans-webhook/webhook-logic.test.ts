// Test idempotency midtrans-webhook: event Midtrans yang sama (transaction_id sama)
// dikirim ulang -- misalnya karena Midtrans retry saat respons kita timeout --
// tidak boleh diproses dua kali (tidak boleh aktivasi subscription dua kali).
// Jalankan: deno test webhook-logic.test.ts

import { assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { processMidtransEvent, type WebhookDeps, type WebhookBody } from './webhook-logic.ts';

// Fake store in-memory yang mensimulasikan constraint asli di Postgres:
// UNIQUE(external_event_id) di tabel payment_events. Insert kedua dengan
// transaction_id yang sama akan gagal dengan code '23505', persis seperti
// Postgres.
function makeFakeDeps(opts?: { activationFails?: boolean; statusUpdateFails?: boolean; eventAckFails?: boolean }) {
  const processedEvents = new Set<string>();
  const payments = new Map<string, { id: string; status: string; amount: number; order_id: string }>();
  payments.set('ORDER-1', { id: 'pay_1', status: 'pending', amount: 59000, order_id: 'ORDER-1' });
  let activationCallCount = 0;

  const deps: WebhookDeps = {
    async insertEvent(transactionId) {
      if (processedEvents.has(transactionId)) {
        return { error: { code: '23505' } }; // unique violation, sama seperti Postgres
      }
      processedEvents.add(transactionId);
      return { error: null };
    },
    async findPaymentByOrderId(orderId) {
      const p = payments.get(orderId);
      return p ? { id: p.id, status: p.status, amount: p.amount } : null;
    },
    async updatePaymentStatus(paymentId, status) {
      if (opts?.statusUpdateFails) throw new Error('Synthetic database outage');
      for (const p of payments.values()) {
        if (p.id === paymentId) p.status = status;
      }
    },
    async activateSubscription() {
      activationCallCount++;
      if (opts?.activationFails) {
        return { error: 'RPC_FAILED' };
      }
      return { error: null };
    },
    async markEventProcessed() {
      if (opts?.eventAckFails) throw new Error('Synthetic event ACK outage');
    },
    async deleteEvent(transactionId) {
      processedEvents.delete(transactionId);
    },
  };

  return {
    deps,
    getActivationCallCount: () => activationCallCount,
    getPaymentStatus: (orderId: string) => payments.get(orderId)?.status,
  };
}

function successEvent(transactionId: string): WebhookBody {
  return {
    order_id: 'ORDER-1',
    transaction_id: transactionId,
    status_code: '200',
    gross_amount: '59000.00',
    signature_key: 'sudah-divalidasi-di-index.ts',
    transaction_status: 'settlement',
    fraud_status: '',
  };
}

Deno.test('processMidtransEvent - event baru diproses normal, subscription diaktivasi', async () => {
  const { deps, getActivationCallCount, getPaymentStatus } = makeFakeDeps();
  const outcome = await processMidtransEvent(successEvent('TXN-1'), deps);
  assertEquals(outcome.status, 200);
  assertEquals(outcome.body, 'OK');
  assertEquals(outcome.activationCalled, true);
  assertEquals(getActivationCallCount(), 1);
  assertEquals(getPaymentStatus('ORDER-1'), 'success');
});

Deno.test('processMidtransEvent - event yang SAMA dikirim ulang (retry Midtrans) TIDAK diproses dua kali', async () => {
  const { deps, getActivationCallCount } = makeFakeDeps();

  const first = await processMidtransEvent(successEvent('TXN-DUPLIKAT'), deps);
  assertEquals(first.status, 200);
  assertEquals(first.activationCalled, true);
  assertEquals(getActivationCallCount(), 1);

  // Midtrans kirim ulang notifikasi persis sama (transaction_id sama) --
  // skenario umum kalau respons kita sempat timeout di percobaan pertama.
  const retry = await processMidtransEvent(successEvent('TXN-DUPLIKAT'), deps);
  assertEquals(retry.status, 200);
  assertEquals(retry.body, 'OK (already processed)');
  assertEquals(retry.activationCalled, false);

  // Bagian paling penting: aktivasi subscription cuma kepanggil SEKALI meskipun
  // event diterima dua kali.
  assertEquals(getActivationCallCount(), 1);
});

Deno.test('processMidtransEvent - dikirim ulang 5x beruntun tetap cuma aktivasi sekali', async () => {
  const { deps, getActivationCallCount } = makeFakeDeps();
  for (let i = 0; i < 5; i++) {
    await processMidtransEvent(successEvent('TXN-BERULANG'), deps);
  }
  assertEquals(getActivationCallCount(), 1);
});

Deno.test('processMidtransEvent - transaction_id BEDA untuk order yang sama tetap diproses independen (bukan dianggap duplikat oleh unique constraint)', async () => {
  const { deps, getActivationCallCount } = makeFakeDeps();
  const pendingBody = successEvent('TXN-A');
  pendingBody.transaction_status = 'pending';
  const firstOutcome = await processMidtransEvent(pendingBody, deps);
  // event pertama (transaction_id beda dari sebelumnya) tidak boleh ditolak
  // sebagai "already processed" -- itu cuma berlaku untuk transaction_id yang
  // SAMA persis.
  assertEquals(firstOutcome.body, 'OK');
  assertEquals(getActivationCallCount(), 0); // masih pending, belum aktivasi

  const secondOutcome = await processMidtransEvent(successEvent('TXN-B'), deps);
  assertEquals(secondOutcome.body, 'OK');
  assertEquals(secondOutcome.activationCalled, true);
  assertEquals(getActivationCallCount(), 1);
});

Deno.test('processMidtransEvent - kalau aktivasi RPC gagal, event row dihapus supaya retry berikutnya diproses ulang (bukan malah dikunci gagal permanen)', async () => {
  const { deps, getActivationCallCount } = makeFakeDeps({ activationFails: true });

  const first = await processMidtransEvent(successEvent('TXN-GAGAL-AKTIVASI'), deps);
  assertEquals(first.status, 500);
  assertEquals(first.body, 'ACTIVATION_ERROR');
  assertEquals(getActivationCallCount(), 1);

  // Midtrans retry setelah kita balas 500 -- karena row payment_events sudah
  // dihapus (self-healing), event ini HARUS dianggap baru lagi dan aktivasi
  // dicoba ulang, bukan malah short-circuit ke "already processed" padahal
  // subscription belum pernah aktif.
  const retry = await processMidtransEvent(successEvent('TXN-GAGAL-AKTIVASI'), deps);
  assertEquals(retry.activationCalled, true);
  assertEquals(getActivationCallCount(), 2);
});

Deno.test('processMidtransEvent - REGRESI: payments.status TIDAK boleh kepatri "success" duluan sebelum aktivasi terbukti berhasil (kalau tidak, self-healing di atas jadi percuma)', async () => {
  const { deps, getPaymentStatus } = makeFakeDeps({ activationFails: true });
  await processMidtransEvent(successEvent('TXN-CEK-STATUS'), deps);
  // Karena aktivasi gagal, status payment HARUS masih 'pending' (bukan 'success')
  // -- kalau ini gagal berarti bug lama (status diupdate sebelum aktivasi
  // dipastikan sukses) balik lagi.
  assertEquals(getPaymentStatus('ORDER-1'), 'pending');
});

Deno.test('processMidtransEvent - payment tidak ditemukan untuk order_id -> 404, tidak insert efek samping', async () => {
  const { deps, getActivationCallCount } = makeFakeDeps();
  const body = successEvent('TXN-ORDER-ASING');
  body.order_id = 'ORDER-TIDAK-ADA';
  const outcome = await processMidtransEvent(body, deps);
  assertEquals(outcome.status, 404);
  assertEquals(outcome.body, 'PAYMENT_NOT_FOUND');
  assertEquals(getActivationCallCount(), 0);
});

Deno.test('processMidtransEvent - status pending TIDAK memicu aktivasi subscription', async () => {
  const { deps, getActivationCallCount, getPaymentStatus } = makeFakeDeps();
  const body = successEvent('TXN-PENDING');
  body.transaction_status = 'pending';
  const outcome = await processMidtransEvent(body, deps);
  assertEquals(outcome.status, 200);
  assertEquals(outcome.activationCalled, false);
  assertEquals(getActivationCallCount(), 0);
  assertEquals(getPaymentStatus('ORDER-1'), 'pending');
});


Deno.test('processMidtransEvent rejects a signed but incorrect transaction amount', async () => {
  const { deps, getActivationCallCount, getPaymentStatus } = makeFakeDeps();
  const invalid = successEvent('TXN-AMOUNT');
  invalid.gross_amount = '59001.00';
  const result = await processMidtransEvent(invalid, deps);
  assertEquals(result.status, 422);
  assertEquals(result.body, 'PAYMENT_AMOUNT_MISMATCH');
  assertEquals(getActivationCallCount(), 0);
  assertEquals(getPaymentStatus('ORDER-1'), 'pending');
  // A corrected notification with the same transaction ID is no longer locked.
  const retry = await processMidtransEvent(successEvent('TXN-AMOUNT'), deps);
  assertEquals(retry.status, 200);
  assertEquals(getActivationCallCount(), 1);
});

Deno.test('processMidtransEvent rejects malformed, negative and fractional rupiah amounts', async () => {
  const { deps, getActivationCallCount } = makeFakeDeps();
  for (const amount of ['NaN', '-59000', '59000.001', '5.9e4', '0', '']) {
    const body = successEvent('TXN-BAD-AMOUNT-' + amount);
    body.gross_amount = amount;
    const result = await processMidtransEvent(body, deps);
    assertEquals(result.status, 422);
  }
  assertEquals(getActivationCallCount(), 0);
});

Deno.test('processMidtransEvent does not downgrade a settled order', async () => {
  const { deps, getActivationCallCount, getPaymentStatus } = makeFakeDeps();
  assertEquals((await processMidtransEvent(successEvent('TXN-SETTLED'), deps)).status, 200);
  const delayed = successEvent('TXN-LATE-EXPIRE');
  delayed.transaction_status = 'expire';
  const outcome = await processMidtransEvent(delayed, deps);
  assertEquals(outcome.status, 200);
  assertEquals(outcome.activationCalled, false);
  assertEquals(getPaymentStatus('ORDER-1'), 'success');
  assertEquals(getActivationCallCount(), 1);
});


Deno.test('Midtrans event remains retryable when payment status persistence fails', async () => {
  const { deps, getPaymentStatus, getActivationCallCount } = makeFakeDeps({ statusUpdateFails: true });
  const event = successEvent('TXN-WRITE-FAIL');
  const result = await processMidtransEvent(event, deps);
  assertEquals(result.status, 500);
  assertEquals(result.body, 'DB_ERROR');
  assertEquals(getPaymentStatus('ORDER-1'), 'pending');
  assertEquals(getActivationCallCount(), 1);
  const retry = await processMidtransEvent(event, deps);
  assertEquals(retry.status, 500);
  assertEquals(retry.body, 'DB_ERROR');
  assertEquals(getActivationCallCount(), 2);
});

Deno.test('Midtrans event does not return 200 when its acknowledgement fails', async () => {
  const { deps, getPaymentStatus, getActivationCallCount } = makeFakeDeps({ eventAckFails: true });
  const event = successEvent('TXN-ACK-FAIL');
  const first = await processMidtransEvent(event, deps);
  assertEquals(first.status, 500);
  assertEquals(first.body, 'DB_ERROR');
  assertEquals(getPaymentStatus('ORDER-1'), 'success');
  const retry = await processMidtransEvent(event, deps);
  assertEquals(retry.status, 500);
  assertEquals(getActivationCallCount(), 1); // no repeat subscription activation
});


Deno.test('Midtrans pending and settlement with same transaction ID are distinct events', async () => {
  const { deps, getActivationCallCount, getPaymentStatus } = makeFakeDeps();
  const pending = successEvent('TXN-SHARED-STATUS');
  pending.transaction_status = 'pending';
  assertEquals((await processMidtransEvent(pending, deps)).status, 200);
  assertEquals(getPaymentStatus('ORDER-1'), 'pending');

  // Midtrans does not issue a new transaction ID when payment settles.
  const settled = successEvent('TXN-SHARED-STATUS');
  const settledResult = await processMidtransEvent(settled, deps);
  assertEquals(settledResult.status, 200);
  assertEquals(settledResult.body, 'OK');
  assertEquals(getPaymentStatus('ORDER-1'), 'success');
  assertEquals(getActivationCallCount(), 1);

  const duplicate = await processMidtransEvent(settled, deps);
  assertEquals(duplicate.body, 'OK (already processed)');
  assertEquals(getActivationCallCount(), 1);
});

Deno.test('Late pending status for same transaction cannot downgrade settlement', async () => {
  const { deps, getPaymentStatus, getActivationCallCount } = makeFakeDeps();
  const settled = successEvent('TXN-LATE-PENDING-SHARED');
  const pending = successEvent('TXN-LATE-PENDING-SHARED');
  pending.transaction_status = 'pending';
  assertEquals((await processMidtransEvent(settled, deps)).status, 200);
  assertEquals((await processMidtransEvent(pending, deps)).status, 200);
  assertEquals(getPaymentStatus('ORDER-1'), 'success');
  assertEquals(getActivationCallCount(), 1);
});

Deno.test('Event uniqueness key is bounded and does not expose a raw transaction identifier', async () => {
  const { deps } = makeFakeDeps();
  let claimKey = '';
  const insert = deps.insertEvent;
  deps.insertEvent = async (key, body) => {
    claimKey = key;
    return insert(key, body);
  };
  await processMidtransEvent(successEvent('TXN-PRIVATE-ID-123'), deps);
  assertEquals(claimKey.startsWith('midtrans:v2:'), true);
  assertEquals(claimKey.length, 'midtrans:v2:'.length + 64);
  assertEquals(claimKey.includes('PRIVATE'), false);
});
