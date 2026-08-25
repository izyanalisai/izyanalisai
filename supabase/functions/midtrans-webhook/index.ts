import { createClient } from 'jsr:@supabase/supabase-js@2';
import { verifyMidtransSignature, resolvePaymentStatus } from './signature.ts';
// Webhook publik dari Midtrans. Auth-nya BUKAN dari JWT Supabase,
// tapi dari signature_key yang divalidasi manual di bawah.
// Logic signature & status resolution di-extract ke signature.ts (25 Agustus 2026,
// spec v6.1 section 4 prioritas #2 butir 2) supaya bisa dites otomatis lewat
// `deno test` tanpa perlu spin up server -- lihat signature.test.ts.
Deno.serve(async (req)=>{
  if (req.method !== 'POST') {
    return new Response('METHOD_NOT_ALLOWED', {
      status: 405
    });
  }
  let body;
  try {
    body = await req.json();
  } catch  {
    return new Response('INVALID_BODY', {
      status: 400
    });
  }
  const orderId = String(body.order_id ?? '');
  const statusCode = String(body.status_code ?? '');
  const grossAmount = String(body.gross_amount ?? '');
  const signatureKey = String(body.signature_key ?? '');
  const transactionStatus = String(body.transaction_status ?? '');
  const fraudStatus = String(body.fraud_status ?? '');
  const transactionId = String(body.transaction_id ?? '');
  if (!orderId || !signatureKey || !transactionId) {
    return new Response('MISSING_FIELDS', {
      status: 400
    });
  }
  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const { data: secretRow } = await admin.from('internal_secrets').select('value').eq('key', 'midtrans_server_key').maybeSingle();
  const serverKey = secretRow?.value;
  if (!serverKey) {
    console.error('midtrans_server_key belum diisi');
    return new Response('SERVER_MISCONFIGURED', {
      status: 500
    });
  }
  // Verifikasi signature: sha512(order_id + status_code + gross_amount + ServerKey)
  const signatureValid = await verifyMidtransSignature({
    orderId,
    statusCode,
    grossAmount,
    serverKey,
    signatureKey
  });
  if (!signatureValid) {
    console.error('signature mismatch untuk order_id', orderId);
    return new Response('INVALID_SIGNATURE', {
      status: 403
    });
  }
  // Idempotency: transaction_id Midtrans cuma diproses sekali
  const { error: eventInsertErr } = await admin.from('payment_events').insert({
    external_event_id: transactionId,
    payload: body
  });
  if (eventInsertErr) {
    // unique violation = sudah pernah diproses, aman untuk return 200 (idempotent)
    if (eventInsertErr.code === '23505') {
      return new Response('OK (already processed)', {
        status: 200
      });
    }
    console.error('gagal insert payment_events', eventInsertErr);
    return new Response('DB_ERROR', {
      status: 500
    });
  }
  const { data: payment } = await admin.from('payments').select('id, status').eq('external_payment_id', orderId).maybeSingle();
  if (!payment) {
    console.error('payment tidak ditemukan untuk order_id', orderId);
    return new Response('PAYMENT_NOT_FOUND', {
      status: 404
    });
  }
  const newStatus = resolvePaymentStatus({
    transactionStatus,
    fraudStatus
  });
  if (newStatus) {
    await admin.from('payments').update({
      status: newStatus
    }).eq('id', payment.id);
  }
  if (newStatus === 'success' && payment.status !== 'success') {
    const { error: activateErr } = await admin.rpc('activate_subscription_from_payment', {
      p_payment_id: payment.id
    });
    if (activateErr) {
      console.error('gagal aktivasi subscription', activateErr);
      // FIX 23 Agustus 2026 (celah desain dari audit 22 Agustus): payment_events
      // sudah terlanjur diinsert SEBELUM RPC ini dipanggil (untuk idempotency
      // terhadap request paralel). Kalau RPC gagal di sini dan row itu
      // dibiarkan, retry webhook berikutnya dari Midtrans akan short-circuit
      // di pengecekan unique constraint di atas dan TIDAK PERNAH mencoba lagi
      // aktivasi -- payment permanen sukses tapi subscription tidak pernah
      // aktif, tanpa recovery otomatis. Hapus lagi row payment_events supaya
      // retry Midtrans berikutnya bisa mencoba dari awal.
      await admin.from('payment_events').delete().eq('external_event_id', transactionId);
      return new Response('ACTIVATION_ERROR', {
        status: 500
      });
    }
  }
  await admin.from('payment_events').update({
    processed_at: new Date().toISOString()
  }).eq('external_event_id', transactionId);
  return new Response('OK', {
    status: 200
  });
});
