import { createClient } from 'jsr:@supabase/supabase-js@2';
import { verifyAdMobSignature } from './verification.ts';

// Google AdMob rewarded-ad server-side callback. Nothing is credited until
// Google's DER signature is verified over the original signed query bytes.
// Reference: https://developers.google.com/admob/android/ssv
const VERIFIER_KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method !== 'GET') return new Response('METHOD_NOT_ALLOWED', { status: 405 });
  if (req.url.length > 8192) return new Response('INVALID_CALLBACK', { status: 400 });

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return new Response('INVALID_CALLBACK', { status: 400 });
  }

  let keys;
  try {
    const result = await fetch(VERIFIER_KEYS_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) throw new Error('VERIFIER_KEYS_UNAVAILABLE');
    keys = await result.json();
  } catch {
    return new Response('VERIFIER_KEYS_UNAVAILABLE', { status: 503 });
  }

  // This also checks exact signature/key_id positions and handles SPKI + DER.
  if (!await verifyAdMobSignature(req.url, keys)) {
    return new Response('INVALID_SIGNATURE', { status: 403 });
  }

  const params = url.searchParams;
  const customData = params.get('custom_data') ?? params.get('user_id') ?? '';
  const parts = customData.split(':');
  const transactionId = params.get('transaction_id');
  const rewardAmount = params.get('reward_amount');
  const amount = rewardAmount === null ? null : Number(rewardAmount);

  if (parts.length !== 2 || !UUID.test(parts[0]) || !UUID.test(parts[1]) ||
      !transactionId || !/^[0-9a-f]{16,128}$/i.test(transactionId) ||
      (amount !== null && (!Number.isFinite(amount) || amount < 0))) {
    return new Response('INVALID_REWARD_FIELDS', { status: 400 });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const { data, error } = await admin.rpc('credit_ad_unlock_verified', {
    p_user_id: parts[0],
    p_stock_id: parts[1],
    p_transaction_id: transactionId,
    p_reward_item: params.get('reward_item'),
    p_reward_amount: amount,
  });
  if (error) {
    console.error('admob_ssv_credit_failed', { code: error.code });
    return new Response('CREDIT_ERROR', { status: 500 });
  }
  // A verified callback may legitimately exceed the user's daily limit.
  // Acknowledge delivery without falsely claiming that tokens were granted.
  if (data?.status === 'error') return new Response('REWARD_NOT_GRANTED', { status: 200 });
  return new Response('OK', { status: 200 });
});
