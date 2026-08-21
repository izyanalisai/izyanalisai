import { createClient } from 'jsr:@supabase/supabase-js@2';
// Worker: kirim notifikasi ke Telegram (spec v5.0 section 19 - channel kedua selain Web Push).
// Dipanggil otomatis oleh trigger notify_push_on_new_notification() setiap ada baris baru
// masuk ke tabel `notifications`, untuk user yang punya telegram_subscriptions aktif.
// Auth: sama seperti send-web-push, pakai header x-worker-secret dicocokkan ke
// internal_secrets.worker_shared_secret (yang manggil adalah trigger DB/pg_net, bukan browser user).
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
    const { data: tokenRow } = await supabase.from('internal_secrets').select('value').eq('key', 'telegram_bot_token').maybeSingle();
    const botToken = tokenRow?.value;
    if (!botToken) {
      // Belum ada bot token di internal_secrets. Jangan error keras (biar trigger DB gak dianggap failing job) -
      // cukup log & return 200 no-op, supaya Web Push (channel lain) tetap jalan normal.
      console.warn('[send-telegram-notification] telegram_bot_token belum di-set di internal_secrets, skip.');
      return new Response(JSON.stringify({
        skipped: true,
        reason: 'telegram_bot_token belum diset'
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS
        }
      });
    }
    const { user_id, title, body, category, reference_id } = await req.json();
    if (!user_id || !title) {
      return new Response(JSON.stringify({
        error: 'user_id dan title wajib diisi'
      }), {
        status: 400,
        headers: CORS_HEADERS
      });
    }
    const { data: subs, error: subsErr } = await supabase.from('telegram_subscriptions').select('id, chat_id').eq('user_id', user_id).eq('is_active', true);
    if (subsErr) {
      return new Response(JSON.stringify({
        error: subsErr.message
      }), {
        status: 500,
        headers: CORS_HEADERS
      });
    }
    // Format pesan sederhana, plain text (aman dari Markdown/HTML parse error kalau title/body ada karakter khusus)
    const lines = [
      title
    ];
    if (body) lines.push(body);
    if (category) lines.push(`Kategori: ${category}`);
    lines.push('', 'Buka IzyAnalisAi untuk detail lengkap.');
    const text = lines.join('\n');
    let sent = 0, failed = 0, deactivated = 0;
    for (const sub of subs ?? []){
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            chat_id: sub.chat_id,
            text
          })
        });
        const json = await res.json();
        if (json.ok) {
          sent++;
          await supabase.from('telegram_subscriptions').update({
            last_sent_at: new Date().toISOString(),
            last_error: null
          }).eq('id', sub.id);
        } else {
          failed++;
          const errDesc = String(json.description ?? 'unknown error');
          await supabase.from('telegram_subscriptions').update({
            last_error: errDesc
          }).eq('id', sub.id);
          // 403 = user blokir bot / chat gak valid lagi -> nonaktifin biar gak dicoba terus
          if (res.status === 403) {
            await supabase.from('telegram_subscriptions').update({
              is_active: false
            }).eq('id', sub.id);
            deactivated++;
          }
        }
      } catch (err) {
        failed++;
        console.error('[send-telegram-notification] gagal kirim ke chat', sub.chat_id, String(err));
      }
    }
    return new Response(JSON.stringify({
      sent,
      failed,
      deactivated,
      total: (subs ?? []).length,
      reference_id: reference_id ?? null
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...CORS_HEADERS
      }
    });
  } catch (err) {
    console.error('[send-telegram-notification] unhandled error:', err);
    return new Response(JSON.stringify({
      error: String(err)
    }), {
      status: 500,
      headers: CORS_HEADERS
    });
  }
});
