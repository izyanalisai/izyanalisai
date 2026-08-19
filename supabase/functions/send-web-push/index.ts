import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
// Worker: kirim Web Push notification ke semua device (endpoint) yang
// disubscribe user tertentu. Dipanggil otomatis oleh trigger
// notify_push_on_new_notification() setiap ada baris baru masuk ke tabel
// `notifications` (lihat migration web_push_notifications).
// Auth: sama seperti worker lain, pakai header x-worker-secret dicocokkan
// ke internal_secrets.worker_shared_secret (bukan verify_jwt user biasa,
// karena yang manggil adalah trigger DB/pg_net, bukan browser user).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-worker-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const providedSecret = req.headers.get('x-worker-secret');
  const { data: secretRow } = await supabase.from('internal_secrets').select('value').eq('key', 'worker_shared_secret').maybeSingle();
  if (!providedSecret || !secretRow || providedSecret !== secretRow.value) {
    return new Response(JSON.stringify({
      error: 'unauthorized'
    }), {
      status: 401,
      headers: CORS_HEADERS
    });
  }
  try {
    const { data: secrets } = await supabase.from('internal_secrets').select('key, value').in('key', [
      'vapid_public_key',
      'vapid_private_key',
      'vapid_subject'
    ]);
    const vapidPublic = secrets?.find((s)=>s.key === 'vapid_public_key')?.value;
    const vapidPrivate = secrets?.find((s)=>s.key === 'vapid_private_key')?.value;
    const vapidSubject = secrets?.find((s)=>s.key === 'vapid_subject')?.value ?? 'mailto:support@izyanalisai.com';
    if (!vapidPublic || !vapidPrivate) {
      return new Response(JSON.stringify({
        error: 'VAPID key belum di-set di internal_secrets'
      }), {
        status: 500,
        headers: CORS_HEADERS
      });
    }
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    const { user_id, title, body, category, reference_id } = await req.json();
    if (!user_id || !title) {
      return new Response(JSON.stringify({
        error: 'user_id dan title wajib diisi'
      }), {
        status: 400,
        headers: CORS_HEADERS
      });
    }
    const { data: subs, error: subsErr } = await supabase.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', user_id);
    if (subsErr) {
      return new Response(JSON.stringify({
        error: subsErr.message
      }), {
        status: 500,
        headers: CORS_HEADERS
      });
    }
    const payload = JSON.stringify({
      title,
      body: body ?? '',
      category: category ?? null,
      reference_id: reference_id ?? null,
      url: '/notifikasi'
    });
    let sent = 0, failed = 0, removed = 0;
    for (const sub of subs ?? []){
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        }, payload);
        sent++;
      } catch (err) {
        failed++;
        const statusCode = err?.statusCode;
        // Endpoint kadaluarsa/dicabut browser -> bersihin dari tabel biar gak dicoba lagi.
        if (statusCode === 404 || statusCode === 410) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
          removed++;
        } else {
          console.error('[send-web-push] gagal kirim ke subscription', sub.id, String(err));
        }
      }
    }
    return new Response(JSON.stringify({
      sent,
      failed,
      removed,
      total: (subs ?? []).length
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...CORS_HEADERS
      }
    });
  } catch (err) {
    console.error('[send-web-push] unhandled error:', err);
    return new Response(JSON.stringify({
      error: String(err)
    }), {
      status: 500,
      headers: CORS_HEADERS
    });
  }
});
