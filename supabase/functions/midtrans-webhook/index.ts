import { createClient } from 'jsr:@supabase/supabase-js@2';
// Webhook publik dari Midtrans. Auth-nya BUKAN dari JWT Supabase,
// tapi dari signature_key yang divalidasi manual di bawah.
async function sha512Hex(input) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-512', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b)=>b.toString(16).padStart(2, '0')).join('');
}
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
  const expectedSignature = await sha512Hex(orderId + statusCode + grossAmount + serverKey);
  if (expectedSignature !== signatureKey) {
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
  let newStatus = null;
  if (transactionStatus === 'capture' && fraudStatus === 'accept' || transactionStatus === 'settlement') {
    newStatus = 'success';
  } else if (transactionStatus === 'pending') {
    newStatus = 'pending';
  } else if ([
    'deny',
    'cancel',
    'expire',
    'failure'
  ].includes(transactionStatus)) {
    newStatus = transactionStatus === 'expire' ? 'expired' : 'failed';
  }
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
