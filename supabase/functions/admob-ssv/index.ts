import { createClient } from 'jsr:@supabase/supabase-js@2';
// AdMob Server-Side Verification (SSV) callback.
// Google memanggil endpoint ini via GET dengan query params + signature ECDSA.
// Dokumentasi: https://developers.google.com/admob/android/rewarded-server-side-verification
//
// KONTRAK custom_data (WAJIB diset di app saat load rewarded ad):
//   custom_data = "<user_id_uuid>:<stock_id_uuid>"
// Google akan mengirim balik ini sebagai query param `custom_data` atau `user_id`
// tergantung SDK/config. Kita coba baca dari `custom_data` dulu, fallback `user_id`.
const VERIFIER_KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
async function getPublicKey(keyId) {
  const res = await fetch(VERIFIER_KEYS_URL);
  if (!res.ok) return null;
  const json = await res.json();
  const keyEntry = json.keys?.find((k)=>String(k.keyId) === keyId);
  if (!keyEntry) return null;
  // base64url x,y -> raw EC point (uncompressed, 0x04 prefix) -> import sebagai raw key
  const b64urlToBytes = (b64url)=>{
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '='));
    return Uint8Array.from(bin, (c)=>c.charCodeAt(0));
  };
  const x = b64urlToBytes(keyEntry.x);
  const y = b64urlToBytes(keyEntry.y);
  const rawKey = new Uint8Array(1 + x.length + y.length);
  rawKey[0] = 0x04;
  rawKey.set(x, 1);
  rawKey.set(y, 1 + x.length);
  return crypto.subtle.importKey('raw', rawKey, {
    name: 'ECDSA',
    namedCurve: 'P-256'
  }, false, [
    'verify'
  ]);
}
Deno.serve(async (req)=>{
  const url = new URL(req.url);
  const params = url.searchParams;
  const keyId = params.get('key_id');
  const signatureB64url = params.get('signature');
  if (!keyId || !signatureB64url) {
    return new Response('MISSING_SIGNATURE', {
      status: 400
    });
  }
  const publicKey = await getPublicKey(keyId);
  if (!publicKey) {
    console.error('AdMob public key tidak ditemukan untuk key_id', keyId);
    return new Response('UNKNOWN_KEY', {
      status: 400
    });
  }
  // Signature dihitung atas seluruh query string SEBELUM param signature & key_id
  const contentToVerify = url.search.substring(1).split('&signature=')[0];
  const b64urlToBytes = (b64url)=>{
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '='));
    return Uint8Array.from(bin, (c)=>c.charCodeAt(0));
  };
  const sigBytes = b64urlToBytes(signatureB64url);
  const isValid = await crypto.subtle.verify({
    name: 'ECDSA',
    hash: 'SHA-256'
  }, publicKey, sigBytes, new TextEncoder().encode(contentToVerify));
  if (!isValid) {
    console.error('AdMob SSV signature tidak valid');
    return new Response('INVALID_SIGNATURE', {
      status: 403
    });
  }
  const transactionId = params.get('transaction_id');
  const customData = params.get('custom_data') ?? params.get('user_id') ?? '';
  const rewardItem = params.get('reward_item');
  const rewardAmount = params.get('reward_amount');
  const [userId, stockId] = customData.split(':');
  if (!transactionId || !userId || !stockId) {
    return new Response('MISSING_CUSTOM_DATA', {
      status: 400
    });
  }
  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const { error } = await admin.rpc('credit_ad_unlock_verified', {
    p_user_id: userId,
    p_stock_id: stockId,
    p_transaction_id: transactionId,
    p_reward_item: rewardItem,
    p_reward_amount: rewardAmount ? Number(rewardAmount) : null
  });
  if (error) {
    console.error('gagal credit_ad_unlock_verified', error);
    return new Response('CREDIT_ERROR', {
      status: 500
    });
  }
  return new Response('OK', {
    status: 200
  });
});
