import { createClient } from 'jsr:@supabase/supabase-js@2'

// Webhook publik yang dipanggil Telegram tiap ada update ke bot IzyAnalisAi (spec v5.0 section 19).
// Alur linking akun:
//   1. User buka app -> Profil -> "Hubungkan Telegram" -> app panggil RPC generate_telegram_link_code()
//      -> dapat kode 6 digit, berlaku 15 menit.
//   2. User buka bot Telegram, kirim: /start <kode>  (atau /link <kode> kalau sudah pernah /start sebelumnya)
//   3. Telegram POST update ke endpoint ini -> kita cocokkan kode ke telegram_link_codes -> kalau valid,
//      upsert ke telegram_subscriptions(user_id, chat_id) dan tandai kode used_at.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

async function sendReply(botToken: string, chatId: number | string, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
  } catch (err) {
    console.error('[telegram-webhook] gagal balas pesan', String(err))
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: CORS_HEADERS })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const { data: tokenRow } = await supabase.from('internal_secrets').select('value').eq('key', 'telegram_bot_token').maybeSingle()
    const botToken = tokenRow?.value
    if (!botToken) {
      console.warn('[telegram-webhook] telegram_bot_token belum diset, drop update.')
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS })
    }

    const { data: whSecretRow } = await supabase.from('internal_secrets').select('value').eq('key', 'telegram_webhook_secret').maybeSingle()
    if (whSecretRow?.value) {
      const headerSecret = req.headers.get('x-telegram-bot-api-secret-token')
      if (headerSecret !== whSecretRow.value) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS_HEADERS })
      }
    }

    const update = await req.json()
    const message = update?.message
    const text: string | undefined = message?.text
    const chatId = message?.chat?.id

    if (!message || !text || chatId === undefined) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS })
    }

    const parts = text.trim().split(/\s+/)
    const command = parts[0]?.toLowerCase()
    const codeArg = parts[1]

    if (command === '/start' || command === '/link') {
      if (!codeArg) {
        await sendReply(botToken, chatId,
          'Halo! Untuk menghubungkan akun IzyAnalisAi kamu, buka app -> Profil -> Hubungkan Telegram, lalu kirim kode 6 digit yang muncul ke sini dengan format:\n/link 123456')
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS })
      }

      const { data: linkRow, error: linkErr } = await supabase
        .from('telegram_link_codes')
        .select('code, user_id, expires_at, used_at')
        .eq('code', codeArg)
        .maybeSingle()

      if (linkErr || !linkRow) {
        await sendReply(botToken, chatId, 'Kode tidak ditemukan. Generate kode baru dari app ya (Profil -> Hubungkan Telegram).')
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS })
      }
      if (linkRow.used_at) {
        await sendReply(botToken, chatId, 'Kode ini sudah pernah dipakai. Generate kode baru dari app kalau mau menghubungkan ulang.')
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS })
      }
      if (new Date(linkRow.expires_at).getTime() < Date.now()) {
        await sendReply(botToken, chatId, 'Kode sudah kadaluarsa (berlaku 15 menit). Generate kode baru dari app ya.')
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS })
      }

      const { error: upsertErr } = await supabase
        .from('telegram_subscriptions')
        .upsert({ user_id: linkRow.user_id, chat_id: String(chatId), is_active: true, linked_at: new Date().toISOString() }, { onConflict: 'user_id,chat_id' })

      if (upsertErr) {
        console.error('[telegram-webhook] gagal upsert subscription', upsertErr.message)
        await sendReply(botToken, chatId, 'Ada gangguan saat menghubungkan akun. Coba lagi sebentar ya.')
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS })
      }

      await supabase.from('telegram_link_codes').update({ used_at: new Date().toISOString() }).eq('code', codeArg)
      await sendReply(botToken, chatId, 'Berhasil! Akun IzyAnalisAi kamu sekarang terhubung ke Telegram. Notifikasi sinyal & alert bakal masuk ke sini juga.')
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS })
    }

    if (command === '/stop' || command === '/unlink') {
      await supabase.from('telegram_subscriptions').update({ is_active: false }).eq('chat_id', String(chatId))
      await sendReply(botToken, chatId, 'Oke, notifikasi Telegram dimatikan. Kirim /link <kode> lagi kapan aja kalau mau diaktifkan ulang.')
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS })
    }

    await sendReply(botToken, chatId, 'Perintah tidak dikenali. Pakai /link <kode> buat menghubungkan akun, atau /stop buat berhenti.')
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS })
  } catch (err) {
    console.error('[telegram-webhook] unhandled error:', err)
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS })
  }
})
