import { createClient } from 'jsr:@supabase/supabase-js@2';
// NOTE: Harga placeholder, WAJIB disesuaikan tim sebelum go-live.
const PREMIUM_MONTHLY_PRICE_IDR = 49000;
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
  const method = body.method ?? '';
  if (!METHOD_TO_MIDTRANS[method]) {
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
  const snapRes = await fetch(snapBase, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${authB64}`
    },
    body: JSON.stringify({
      transaction_details: {
        order_id: orderId,
        gross_amount: PREMIUM_MONTHLY_PRICE_IDR
      },
      enabled_payments: METHOD_TO_MIDTRANS[method],
      customer_details: {
        email: user.email
      }
    })
  });
  const snapJson = await snapRes.json();
  if (!snapRes.ok) {
    await admin.from('payments').update({
      status: 'failed'
    }).eq('id', payment.id);
    return new Response(JSON.stringify({
      error: 'MIDTRANS_ERROR',
      detail: snapJson
    }), {
      status: 502
    });
  }
  return new Response(JSON.stringify({
    payment_id: payment.id,
    order_id: orderId,
    amount: PREMIUM_MONTHLY_PRICE_IDR,
    snap_token: snapJson.token,
    redirect_url: snapJson.redirect_url
  }), {
    headers: {
      'Content-Type': 'application/json'
    }
  });
});
