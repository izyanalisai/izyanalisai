import { createClient } from 'jsr:@supabase/supabase-js@2';
import { verifyMidtransSignature } from './signature.ts';
import { processMidtransEvent, type WebhookDeps } from './webhook-logic.ts';
// Webhook publik dari Midtrans. Auth-nya BUKAN dari JWT Supabase,
// tapi dari signature_key yang divalidasi manual di bawah.
// Logic signature & status resolution di-extract ke signature.ts, dan logic
// idempotency/orkestrasi payment_events+payments ke webhook-logic.ts (25 Agustus
// 2026, spec v6.1 section 4 prioritas #2 butir 2) supaya bisa dites otomatis
// lewat `deno test` tanpa perlu spin up server -- lihat signature.test.ts dan
// webhook-logic.test.ts.
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
  const signatureKey = String(body.signature_key ?? '');
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
  const statusCode = String(body.status_code ?? '');
  const grossAmount = String(body.gross_amount ?? '');
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

  const deps: WebhookDeps = {
    async insertEvent(txId, payload) {
      const { error } = await admin.from('payment_events').insert({
        external_event_id: txId,
        payload
      });
      return { error: error ? { code: error.code } : null };
    },
    async findPaymentByOrderId(oid) {
      const { data } = await admin.from('payments').select('id, status').eq('external_payment_id', oid).maybeSingle();
      return data ?? null;
    },
    async updatePaymentStatus(paymentId, status) {
      await admin.from('payments').update({ status }).eq('id', paymentId);
    },
    async activateSubscription(paymentId) {
      const { error } = await admin.rpc('activate_subscription_from_payment', { p_payment_id: paymentId });
      return { error };
    },
    async markEventProcessed(txId) {
      await admin.from('payment_events').update({ processed_at: new Date().toISOString() }).eq('external_event_id', txId);
    },
    async deleteEvent(txId) {
      await admin.from('payment_events').delete().eq('external_event_id', txId);
    }
  };

  const outcome = await processMidtransEvent(body, deps);
  if (outcome.body === 'ACTIVATION_ERROR') {
    console.error('gagal aktivasi subscription untuk order_id', orderId);
  }
  return new Response(outcome.body, { status: outcome.status });
});
