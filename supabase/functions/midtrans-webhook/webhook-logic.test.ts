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
function makeFakeDeps(opts?: { activationFails?: boolean }) {
  const processedEvents = new Set<string>();
  const payments = new Map<string, { id: string; status: string; order_id: string }>();
  payments.set('ORDER-1', { id: 'pay_1', status: 'pending', order_id: 'ORDER-1' });
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
      return p ? { id: p.id, status: p.status } : null;
    },
    async updatePaymentStatus(paymentId, status) {
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
      // no-op untuk test, cukup dicek lewat processedEvents
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
