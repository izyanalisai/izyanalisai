import { createClient } from 'jsr:@supabase/supabase-js@2'

// Worker Chat - Asisten AI
// Fallback 3 model GRATIS OpenRouter (vision-capable, karena user bisa kirim gambar chart).
const FREE_MODELS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'google/gemma-4-26b-a4b-it:free',
]

const SYSTEM_PROMPT = 'Kamu adalah Asisten AI IzyAnalisAI untuk analisa saham IDX. Jawab santai tapi jelas. Kamu boleh menjelaskan evidence teknikal (RSI, MACD, EMA, support/resistance, pola candlestick) tapi JANGAN pernah menentukan sendiri angka Buy Area, Stop Loss, atau Take Profit -- itu wajib berasal dari data signal engine yang sudah dihitung, bukan dari asumsi kamu. Kamu juga TIDAK PERNAH membuat klaim statistik apa pun (win rate, probabilitas, confidence/tingkat keyakinan) -- sinyal di aplikasi ini murni bacaan struktur harga, bukan hasil statistik. Kalau user kirim gambar chart, jelaskan pola/level yang terlihat sebagai observasi, bukan rekomendasi angka pasti.'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface CallResult { text: string; modelUsed: string; usage: { input: number; output: number } }

async function callOpenRouter(messages: unknown[], apiKey: string): Promise<CallResult> {
  let lastError: unknown = null
  for (const model of FREE_MODELS) {
    try {
      const baseUrl = Deno.env.get('AI_BASE_URL') || 'https://openrouter.ai/api/v1'
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://izyanalisai.vercel.app',
          'X-Title': 'IzyAnalisAI Chat',
        },
        body: JSON.stringify({ model, messages, max_tokens: 800 }),
      })
      if (res.status === 429 || res.status === 402) {
        lastError = await res.text()
        console.error(`[chat-asisten-ai] model ${model} gagal (${res.status}): ${lastError}`)
        continue
      }
      if (!res.ok) {
        lastError = await res.text()
        console.error(`[chat-asisten-ai] model ${model} gagal (${res.status}): ${lastError}`)
        continue
      }
      const data = await res.json()
      const text = data?.choices?.[0]?.message?.content ?? ''
      if (!text) { lastError = 'response kosong'; console.error(`[chat-asisten-ai] model ${model} kasih response kosong`); continue }
      return {
        text,
        modelUsed: model,
        usage: { input: data?.usage?.prompt_tokens ?? 0, output: data?.usage?.completion_tokens ?? 0 },
      }
    } catch (err) {
      lastError = err
      console.error(`[chat-asisten-ai] model ${model} exception:`, err)
      continue
    }
  }
  throw new Error(`Semua model gratis gagal: ${JSON.stringify(lastError)}`)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  try {
    const apiKey = Deno.env.get('OPENROUTER_API_KEY')
    if (!apiKey) {
      console.error('[chat-asisten-ai] OPENROUTER_API_KEY belum di-set di Supabase Edge Function Secrets')
      return new Response(JSON.stringify({ error: 'OPENROUTER_API_KEY belum di-set di Supabase Secrets' }), { status: 500, headers: CORS_HEADERS })
    }

    const authHeader = req.headers.get('Authorization')
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader ?? '' } } },
    )

    const { data: userData, error: userErr } = await supabase.auth.getUser()
    if (userErr || !userData?.user) {
      console.error('[chat-asisten-ai] unauthorized:', userErr?.message)
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS_HEADERS })
    }

    const { thread_id, message, image_url, idempotency_key } = await req.json()
    if (!message) {
      return new Response(JSON.stringify({ error: "field 'message' wajib diisi" }), { status: 400, headers: CORS_HEADERS })
    }

    let threadId = thread_id
    if (!threadId) {
      const { data: newThread, error: threadErr } = await supabase
        .from('ai_threads')
        .insert({ user_id: userData.user.id, title: message.slice(0, 60) })
        .select('id')
        .single()
      if (threadErr || !newThread) {
        console.error('[chat-asisten-ai] gagal buat thread:', threadErr?.message)
        return new Response(JSON.stringify({ error: threadErr?.message ?? 'gagal buat thread' }), { status: 500, headers: CORS_HEADERS })
      }
      threadId = newThread.id
    }

    // FIX (audit 15 Agustus 2026): idempotency key SEBELUMNYA di-generate di
    // server (crypto.randomUUID()) setiap kali fungsi ini dipanggil -- artinya
    // kalau frontend retry request yang gagal/timeout (network issue), key-nya
    // beda tiap kali, deduct_token() jadi memotong token 2x untuk 1 pertanyaan
    // yang sama (melanggar dokumen 5.3 "Retry request gagal tidak memotong
    // token dua kali" & 12.6 "Idempotency key mencegah double charge").
    // Sekarang terima idempotency_key dari client (WAJIB di-generate sekali di
    // frontend per percobaan kirim pesan, dikirim ulang persis sama kalau
    // retry). Fallback ke random UUID kalau frontend lama belum kirim field
    // ini supaya tidak breaking change, TAPI retry dari frontend lama tetap
    // belum idempotent sampai frontend diupdate untuk mengirim field ini.
    const turnId = (typeof idempotency_key === 'string' && idempotency_key.length > 0)
      ? idempotency_key
      : crypto.randomUUID()

    const { data: deductData, error: deductErr } = await supabase.rpc('deduct_token', {
      p_type: '-AI_CHAT',
      p_reference_id: turnId,
    })
    if (deductErr) {
      const msg = deductErr.message ?? String(deductErr)
      console.error('[chat-asisten-ai] deduct_token error:', msg)
      if (msg.includes('INSUFFICIENT_TOKENS')) {
        return new Response(JSON.stringify({ error: 'INSUFFICIENT_TOKENS' }), { status: 402, headers: CORS_HEADERS })
      }
      return new Response(JSON.stringify({ error: msg }), { status: 500, headers: CORS_HEADERS })
    }

    const { error: insertUserMsgErr } = await supabase.from('ai_messages').insert({
      thread_id: threadId, role: 'user', content: message, image_url: image_url ?? null,
    })
    if (insertUserMsgErr) {
      console.error('[chat-asisten-ai] gagal insert pesan user:', insertUserMsgErr.message)
    }

    const { data: history } = await supabase
      .from('ai_messages')
      .select('role, content, image_url')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })
      .limit(20)

    const chatMessages: unknown[] = [{ role: 'system', content: SYSTEM_PROMPT }]
    for (const m of history ?? []) {
      if (m.image_url) {
        chatMessages.push({
          role: m.role,
          content: [
            { type: 'text', text: m.content ?? '' },
            { type: 'image_url', image_url: { url: m.image_url } },
          ],
        })
      } else {
        chatMessages.push({ role: m.role, content: m.content ?? '' })
      }
    }

    let callResult: CallResult
    try {
      callResult = await callOpenRouter(chatMessages, apiKey)
    } catch (err) {
      console.error('[chat-asisten-ai] semua model AI gagal, refund token:', err)
      const { data: refundData, error: refundErr } = await supabase.rpc('refund_token', {
        p_type: '-AI_CHAT',
        p_reference_id: turnId,
      })
      if (refundErr) console.error('[chat-asisten-ai] refund_token gagal:', refundErr.message)
      return new Response(JSON.stringify({
        error: 'AI_TEMPORARILY_UNAVAILABLE',
        detail: String(err),
        token_refunded: !!refundData?.[0]?.refunded,
        token_balance: refundData?.[0]?.balance ?? null,
      }), { status: 502, headers: CORS_HEADERS })
    }
    const { text, modelUsed, usage } = callResult

    const { error: insertAssistantMsgErr } = await supabase.from('ai_messages').insert({ thread_id: threadId, role: 'assistant', content: text })
    if (insertAssistantMsgErr) {
      console.error('[chat-asisten-ai] gagal insert pesan assistant:', insertAssistantMsgErr.message)
    }

    await supabase.from('ai_usage').insert({
      user_id: userData.user.id, thread_id: threadId, worker: 'chat-asisten-ai', model: modelUsed,
      tokens_input: usage.input, tokens_output: usage.output,
    })

    return new Response(JSON.stringify({
      thread_id: threadId, reply: text, model: modelUsed, token_balance: deductData?.[0]?.balance ?? null,
    }), {
      status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })
  } catch (err) {
    console.error('[chat-asisten-ai] unhandled error:', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS_HEADERS })
  }
})
