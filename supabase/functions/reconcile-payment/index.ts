import { createClient } from 'jsr:@supabase/supabase-js@2';
import { verifyProviderStatus } from './provider-status.ts';

const json = (payload: unknown, status: number, extra: Record<string,string> = {}) =>
  new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  const authHeader = request.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'NOT_AUTHENTICATED' }, 401);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return json({ error: 'SERVICE_UNAVAILABLE' }, 503);

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData?.user) return json({ error: 'NOT_AUTHENTICATED' }, 401);
  const userId = authData.user.id;

  const { data: allowed, error: limitError } = await userClient.rpc('check_rate_limit', {
    p_scope: 'reconcile_payment',
    p_identity: userId,
    p_max_hits: 4,
    p_window_seconds: 60,
  });
  if (limitError) return json({ error: 'RATE_LIMIT_UNAVAILABLE' }, 503);
  if (allowed !== true) return json({ error: 'RATE_LIMITED' }, 429, { 'Retry-After': '60' });

  let body: unknown;
  try { body = await request.json(); }
  catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return json({ error: 'INVALID_BODY' }, 400);

  const paymentId = (body as Record<string, unknown>).payment_id;
  if (typeof paymentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(paymentId))
    return json({ error: 'INVALID_PAYMENT_ID' }, 400);

  const admin = createClient(url, serviceKey);
  const { data: payment, error: lookupError } = await admin.from('payments')
    .select('id,user_id,status,amount,external_payment_id,subscription_id')
    .eq('id', paymentId).eq('user_id', userId).maybeSingle();
  if (lookupError) return json({ error: 'PAYMENT_LOOKUP_UNAVAILABLE' }, 503);
  if (!payment) return json({ error: 'PAYMENT_NOT_FOUND' }, 404);
  if (payment.status !== 'pending')
    return json({ payment_id: payment.id, status: payment.status }, 200);
  if (!payment.external_payment_id)
    return json({ error: 'MISSING_PROVIDER_ORDER_ID' }, 503);

  const { data: secrets, error: secretsError } = await admin.from('internal_secrets')
    .select('key,value').in('key', ['midtrans_server_key','midtrans_is_production']);
  if (secretsError) return json({ error: 'PAYMENT_PROVIDER_UNAVAILABLE' }, 503);
  const serverKey = secrets?.find((r) => r.key === 'midtrans_server_key')?.value;
  if (!serverKey) return json({ error: 'PAYMENT_PROVIDER_NOT_CONFIGURED' }, 503);
  const isProduction = secrets?.find((r) => r.key === 'midtrans_is_production')?.value === 'true';
  const host = isProduction ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
  let providerBody: unknown;
  try {
    const response = await fetch(
      `${host}/v2/${encodeURIComponent(payment.external_payment_id)}/status`,
      {
        method: 'GET',
        headers: { Authorization: `Basic ${btoa(`${serverKey}:`)}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!response.ok) {
      // A 404, 5xx or timeout does not prove the provider order is unpaid.
      return json({ error: 'PAYMENT_PROVIDER_STATUS_UNAVAILABLE', order_id: payment.external_payment_id }, 503,
        { 'Retry-After': '30' });
    }
    providerBody = await response.json();
  } catch {
    return json({ error: 'PAYMENT_PROVIDER_STATUS_UNAVAILABLE', order_id: payment.external_payment_id }, 503,
      { 'Retry-After': '30' });
  }
  const status = verifyProviderStatus(providerBody, payment.external_payment_id, payment.amount);
  if (status === 'mismatch') {
    console.error('[reconcile-payment] provider identity or amount mismatch');
    return json({ error: 'PAYMENT_PROVIDER_MISMATCH' }, 502);
  }
  if (status === 'unknown') return json({ error: 'PAYMENT_REQUIRES_MANUAL_REVIEW' }, 409);
  if (status === 'pending')
    return json({ payment_id: payment.id, order_id: payment.external_payment_id, status: 'pending' },
      200, { 'Retry-After': '30' });

  if (status === 'success') {
    const { error: activationError } = await admin.rpc('activate_subscription_from_payment', {
      p_payment_id: payment.id,
    });
    if (activationError) {
      console.error('[reconcile-payment] confirmed settlement could not activate subscription');
      return json({ error: 'SUBSCRIPTION_ACTIVATION_UNAVAILABLE' }, 503);
    }
  }
  const { data: changed, error: updateError } = await admin.from('payments')
    .update({ status }).eq('id', payment.id).eq('status', 'pending')
    .select('id,status');
  if (updateError) return json({ error: 'PAYMENT_STATUS_WRITE_UNAVAILABLE' }, 503);
  if (!changed?.length) {
    // A webhook may have updated the same row while we contacted Midtrans.
    const { data: refreshed, error: refreshError } = await admin.from('payments')
      .select('status').eq('id', payment.id).eq('user_id', userId).maybeSingle();
    if (refreshError || !refreshed) return json({ error: 'PAYMENT_STATUS_WRITE_UNAVAILABLE' }, 503);
    return json({ payment_id: payment.id, status: refreshed.status }, 200);
  }
  return json({ payment_id: payment.id, status: changed[0].status }, 200);
});
