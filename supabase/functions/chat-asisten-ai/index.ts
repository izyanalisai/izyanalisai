import { createClient } from 'jsr:@supabase/supabase-js@2'

// Worker Chat - Asisten AI
// Fallback 3 model GRATIS OpenRouter (vision-capable, karena user bisa kirim gambar chart).
const FREE_MODELS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'google/gemma-4-26b-a4b-it:free',
]

const SYSTEM_PROMPT = 'Kamu adalah Asisten AI IzyAnalisAI untuk analisa saham IDX. Jawab santai tapi jelas. Kamu boleh menjelaskan evidence teknikal (RSI, MACD, EMA, support/resistance, pola candlestick) tapi JANGAN pernah menentukan sendiri angka Buy Area, Stop Loss, Take Profit, Risk/Reward, atau Confidence Score -- itu wajib berasal dari data signal engine yang sudah dihitung, bukan dari asumsi kamu. Kalau user kirim gambar chart, jelaskan pola/level yang terlihat sebagai observasi, bukan rekomendasi angka pasti.'

interface CallResult { text: string; modelUsed: string; usage: { input: number; output: number } }

async function callOpenRouter(messages: unknown[], apiKey: string): Promise<CallResult> {
  let lastError: unknown = null
  for (const model of FREE_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://izyanalisai.vercel.app',
          'X-Title': 'IzyAnalisAI Chat',
        },
        body: JSON.stringify({ model, messages, max_tokens: 800 }),
      })
      if (res.status === 429 || res.status === 402) { lastError = await res.text(); continue }
      if (!res.ok) { lastError = await res.text(); continue }
      const data = await res.json()
      const text = data?.choices?.[0]?.message?.content ?? ''
      if (!text) { lastError = 'response kosong'; continue }
      return {
        text,
        modelUsed: model,
        usage: { input: data?.usage?.prompt_tokens ?? 0, output: data?.usage?.completion_tokens ?? 0 },
      }
    } catch (err) {
      lastError = err
      continue
    }
  }
  throw new Error(`Semua model gratis gagal: ${JSON.stringify(lastError)}`)
}

Deno.serve(async (req: Request) => {
  try {
    const apiKey = Deno.env.get('OPENROUTER_API_KEY')
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'OPENROUTER_API_KEY belum di-set di Supabase Secrets' }), { status: 500 })
    }

    const authHeader = req.headers.get('Authorization')
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader ?? '' } } },
    )

    const { data: userData, error: userErr } = await supabase.auth.getUser()
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    }

    const { thread_id, message, image_url } = await req.json()
    if (!message) {
      return new Response(JSON.stringify({ error: "field 'message' wajib diisi" }), { status: 400 })
    }

    let threadId = thread_id
    if (!threadId) {
      const { data: newThread, error: threadErr } = await supabase
        .from('ai_threads')
        .insert({ user_id: userData.user.id, title: message.slice(0, 60) })
        .select('id')
        .single()
      if (threadErr || !newThread) {
        return new Response(JSON.stringify({ error: threadErr?.message ?? 'gagal buat thread' }), { status: 500 })
      }
      threadId = newThread.id
    }

    const { data: deductData, error: deductErr } = await supabase.rpc('deduct_token', {
      p_type: '-AI_CHAT',
      p_reference_id: null,
    })
    if (deductErr) {
      const msg = deductErr.message ?? String(deductErr)
      if (msg.includes('INSUFFICIENT_TOKENS')) {
        return new Response(JSON.stringify({ error: 'INSUFFICIENT_TOKENS' }), { status: 402 })
      }
      return new Response(JSON.stringify({ error: msg }), { status: 500 })
    }

    await supabase.from('ai_messages').insert({
      thread_id: threadId, role: 'user', content: message, image_url: image_url ?? null,
    })

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

    const { text, modelUsed, usage } = await callOpenRouter(chatMessages, apiKey)

    await supabase.from('ai_messages').insert({ thread_id: threadId, role: 'assistant', content: text })

    await supabase.from('ai_usage').insert({
      user_id: userData.user.id, thread_id: threadId, worker: 'chat-asisten-ai', model: modelUsed,
      tokens_input: usage.input, tokens_output: usage.output,
    })

    return new Response(JSON.stringify({
      thread_id: threadId, reply: text, model: modelUsed, token_balance: deductData?.[0]?.balance ?? null,
    }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
