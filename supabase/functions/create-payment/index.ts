import { createClient } from 'jsr:@supabase/supabase-js@2';
import { decidePaymentRateLimit } from './rate-limit-guard.ts';
import { requestSnap } from './snap-request.ts';
import { isAllowedPaymentMethod } from './payment-method.ts';
// FIX (audit 18 Agustus 2026): harga disesuaikan ke Rp59.000 sesuai Section 10.3 &
// 26.1 poin 22 di spec v4.2 (grandfathered) -- sebelumnya masih placeholder 49.000
// (komentar lama: "NOTE: Harga placeholder, WAJIB disesuaikan tim sebelum go-live").
const PREMIUM_MONTHLY_PRICE_IDR = 59000;
const METHOD_TO_MIDTRANS = {
  QRIS: [
    'qris'
  ],
  VA_BANK: [
    'bca_va',
    'bni_va',
    'bri_va',
    'permata_va',
    'other_va'
  ],
  DANA: [
    'dana'
  ],
  OVO: [
    'ovo'
  ],
  GOPAY: [
    'gopay'
  ],
  SHOPEEPAY: [
    'shopeepay'
  ]
};
Deno.serve(async (req)=>{
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({
      error: 'METHOD_NOT_ALLOWED'
    }), {
      status: 405
    });
  }
  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({
      error: 'NOT_AUTHENTICATED'
    }), {
      status: 401
    });
  }
  const user = userData.user;
  // Rate limit: cegah spam order/snap-token ke Midtrans (tiap panggilan yang
  // lolos ke sini adalah 1 API call ke Midtrans + 1 row 'pending' baru di
  // tabel payments -- gap dari audit 21 Agustus 2026, sebelumnya endpoint ini
  // sama sekali tidak dibatasi selain oleh auth).
  const { data: rateOk, error: rateErr } = await supabase.rpc('check_rate_limit', {
    p_scope: 'create_payment',
    p_identity: user.id,
    p_max_hits: 5,
    p_window_seconds: 60
  });
  const limitFailure = decidePaymentRateLimit(rateOk, rateErr);
  if (limitFailure) {
    if (limitFailure.status === 503) {
      console.error('[create-payment] rate limiter unavailable');
    }
    return new Response(JSON.stringify({ error: limitFailure.error }), {
      status: limitFailure.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  let body;
  try {
    body = await req.json();
  } catch  {
    return new Response(JSON.stringify({
      error: 'INVALID_BODY'
    }), {
      status: 400
    });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return new Response(JSON.stringify({ error: 'INVALID_BODY' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  const method = body.method ?? '';
  if (!isAllowedPaymentMethod(METHOD_TO_MIDTRANS, method)) {
    return new Response(JSON.stringify({
      error: 'INVALID_METHOD',
      allowed: Object.keys(METHOD_TO_MIDTRANS)
    }), {
      status: 400
    });
  }
  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const { data: secretRows } = await admin.from('internal_secrets').select('key, value').in('key', [
    'midtrans_server_key',
    'midtrans_is_production'
  ]);
  const serverKey = secretRows?.find((r)=>r.key === 'midtrans_server_key')?.value;
  const isProduction = secretRows?.find((r)=>r.key === 'midtrans_is_production')?.value === 'true';
  if (!serverKey) {
    return new Response(JSON.stringify({
      error: 'MIDTRANS_NOT_CONFIGURED',
      detail: 'midtrans_server_key belum diisi di tabel internal_secrets'
    }), {
      status: 500
    });
  }
  const orderId = `IZY-${crypto.randomUUID()}`;
  const { data: payment, error: payErr } = await admin.from('payments').insert({
    user_id: user.id,
    amount: PREMIUM_MONTHLY_PRICE_IDR,
    method,
    status: 'pending',
    external_payment_id: orderId
  }).select().single();
  if (payErr || !payment) {
    return new Response(JSON.stringify({
      error: 'FAILED_TO_CREATE_PAYMENT',
      detail: payErr?.message
    }), {
      status: 500
    });
  }
  const snapBase = isProduction ? 'https://app.midtrans.com/snap/v1/transactions' : 'https://app.sandbox.midtrans.com/snap/v1/transactions';
  const authB64 = btoa(`${serverKey}:`);
  const outcome = await requestSnap(
    snapBase, authB64, orderId, PREMIUM_MONTHLY_PRICE_IDR,
    METHOD_TO_MIDTRANS[method], user.email,
  );
  if (outcome.kind === 'rejected') {
    const { error: failureWriteError } = await admin.from('payments')
      .update({ status: 'failed' }).eq('id', payment.id);
    if (failureWriteError) {
      console.error('[create-payment] failed to record rejected provider order');
      return new Response(JSON.stringify({ error: 'PAYMENT_STATE_UNAVAILABLE', order_id: orderId }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'MIDTRANS_REJECTED', order_id: orderId }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (outcome.kind === 'unknown') {
    // The provider might have created this order before a timeout or 5xx.
    // Keep its ID and pending state for provider reconciliation. Do not
    // prematurely mark it failed, or silently make another charge.
    console.error('[create-payment] provider outcome unknown; order requires reconciliation');
    return new Response(JSON.stringify({
      error: 'PAYMENT_STATUS_UNKNOWN',
      payment_id: payment.id,
      order_id: orderId,
      retry_instruction: 'Check the existing order status before creating another payment',
    }), { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } });
  }
  return new Response(JSON.stringify({
    payment_id: payment.id,
    order_id: orderId,
    amount: PREMIUM_MONTHLY_PRICE_IDR,
    snap_token: outcome.token,
    redirect_url: outcome.redirect_url,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
