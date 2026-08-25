// Logic murni (I/O di-inject lewat parameter) yang di-extract dari index.ts supaya
// alur idempotency bisa dites otomatis (Deno test) dengan fake store, tanpa perlu
// Supabase asli. Spec v6.1 section 4 prioritas #2 butir 2: payment webhook --
// idempotency (event yang sama dikirim ulang tidak boleh diproses dua kali).
//
// index.ts tetap pegang: parse request, ambil server key, verifikasi signature
// (lewat signature.ts) -- baru panggil processMidtransEvent di sini kalau signature
// valid. Fungsi ini murni orkestrasi payment_events + payments, tidak melakukan
// verifikasi signature sendiri.

import { resolvePaymentStatus } from './signature.ts';

export interface WebhookBody {
  order_id?: unknown;
  status_code?: unknown;
  gross_amount?: unknown;
  signature_key?: unknown;
  transaction_status?: unknown;
  fraud_status?: unknown;
  transaction_id?: unknown;
}

export interface InsertEventResult {
  error: { code: string } | null;
}

export interface PaymentRow {
  id: string;
  status: string;
}

// Interface I/O yang di-inject -- implementasi asli (index.ts) membungkus Supabase
// client, implementasi test (webhook-logic.test.ts) pakai Map in-memory yang
// mensimulasikan unique constraint payment_events.external_event_id.
export interface WebhookDeps {
  insertEvent(transactionId: string, payload: unknown): Promise<InsertEventResult>;
  findPaymentByOrderId(orderId: string): Promise<PaymentRow | null>;
  updatePaymentStatus(paymentId: string, status: string): Promise<void>;
  activateSubscription(paymentId: string): Promise<{ error: unknown }>;
  markEventProcessed(transactionId: string): Promise<void>;
  deleteEvent(transactionId: string): Promise<void>;
}

export interface WebhookOutcome {
  status: number;
  body: string;
  // dipakai test untuk memastikan aktivasi subscription tidak terpanggil dobel
  activationCalled: boolean;
}

export async function processMidtransEvent(body: WebhookBody, deps: WebhookDeps): Promise<WebhookOutcome> {
  const orderId = String(body.order_id ?? '');
  const transactionId = String(body.transaction_id ?? '');
  const transactionStatus = String(body.transaction_status ?? '');
  const fraudStatus = String(body.fraud_status ?? '');

  // Idempotency: transaction_id Midtrans cuma diproses sekali. Kalau row sudah
  // ada (unique violation, kode Postgres 23505), event ini adalah retry/duplikat
  // -- aman untuk return 200 tanpa mengulang efek samping (update status, aktivasi).
  const { error: eventInsertErr } = await deps.insertEvent(transactionId, body);
  if (eventInsertErr) {
    if (eventInsertErr.code === '23505') {
      return { status: 200, body: 'OK (already processed)', activationCalled: false };
    }
    return { status: 500, body: 'DB_ERROR', activationCalled: false };
  }

  const payment = await deps.findPaymentByOrderId(orderId);
  if (!payment) {
    return { status: 404, body: 'PAYMENT_NOT_FOUND', activationCalled: false };
  }

  // FIX (25 Agustus 2026, ditemukan saat nulis test idempotency): sebelumnya
  // payments.status diupdate ke 'success' DULU baru aktivasi dicoba. Kalau
  // aktivasi gagal, status di DB sudah kadung 'success' -- jadi retry Midtrans
  // berikutnya (yang seharusnya mencoba aktivasi lagi lewat mekanisme hapus
  // payment_events di bawah) malah dianggap "sudah success sebelumnya" dan
  // TIDAK mencoba aktivasi lagi. Self-healing-nya jadi tidak pernah jalan.
  // Diperbaiki: cek status LAMA dan coba aktivasi DULU, baru payments.status
  // diupdate setelah aktivasi terbukti berhasil (atau untuk status non-success
  // yang tidak punya masalah ini).
  const wasAlreadySuccess = payment.status === 'success';
  const newStatus = resolvePaymentStatus({ transactionStatus, fraudStatus });

  let activationCalled = false;
  if (newStatus === 'success' && !wasAlreadySuccess) {
    activationCalled = true;
    const { error: activateErr } = await deps.activateSubscription(payment.id);
    if (activateErr) {
      // Row payment_events dihapus lagi supaya retry Midtrans berikutnya tidak
      // short-circuit di unique constraint dan bisa coba aktivasi dari awal
      // (lihat komentar FIX 23 Agustus 2026 di index.ts). payments.status
      // SENGAJA belum diupdate sampai titik ini supaya retry berikutnya masih
      // melihat wasAlreadySuccess=false dan mencoba aktivasi lagi.
      await deps.deleteEvent(transactionId);
      return { status: 500, body: 'ACTIVATION_ERROR', activationCalled };
    }
  }

  if (newStatus) {
    await deps.updatePaymentStatus(payment.id, newStatus);
  }

  await deps.markEventProcessed(transactionId);
  return { status: 200, body: 'OK', activationCalled };
}
