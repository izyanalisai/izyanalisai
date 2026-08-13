import { createClient } from 'jsr:@supabase/supabase-js@2'

// Worker Trending Score - generate 1-2 kalimat alasan kenapa saham lagi trending.
// Fallback 3 model GRATIS OpenRouter. Diproses SATU-SATU (bukan paralel).
// RESUMABLE OTOMATIS: selalu ambil saham yang trending_reason-nya masih NULL.
const FREE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
]

const SYSTEM_PROMPT = 'Kamu menulis 1-2 kalimat singkat bahasa Indonesia yang menjelaskan kenapa sebuah saham sedang trending, berdasarkan skor & label yang diberikan. Jangan menyebut angka harga baru, jangan kasih rekomendasi buy/sell.'

const REQUEST_TIMEOUT_MS = 20000

function sanitizeReply(raw: string): string {
  let text = raw.trim()
  const marker = SYSTEM_PROMPT.slice(0, 25)
  const idx = text.indexOf(marker)
  if (idx !== -1) text = text.slice(0, idx).trim()
  text = text.replace(/^["']|["']$/g, '').trim()
  return text
}

async function callOpenRouter(prompt: string, apiKey: string) {
  let lastError: unknown = null
  for (const model of FREE_MODELS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://izyanalisai.vercel.app',
          'X-Title': 'IzyAnalisAI Trending Reason',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          max_tokens: 150,
        }),
      })
      clearTimeout(timer)
      if (res.status === 429 || res.status === 402 || !res.ok) { lastError = await res.text(); continue }
      const data = await res.json()
      const rawText = data?.choices?.[0]?.message?.content ?? ''
      const text = sanitizeReply(rawText)
      if (!text) { lastError = 'response kosong setelah sanitize'; continue }
      return { text, modelUsed: model, usage: { input: data?.usage?.prompt_tokens ?? 0, output: data?.usage?.completion_tokens ?? 0 } }
    } catch (err) {
      clearTimeout(timer)
      lastError = err
      continue
    }
  }
  throw new Error(`Semua model gratis gagal: ${JSON.stringify(lastError)}`)
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const providedSecret = req.headers.get('x-worker-secret')
  const { data: secretRow } = await supabase.from('internal_secrets').select('value').eq('key', 'worker_shared_secret').maybeSingle()
  if (!providedSecret || !secretRow || providedSecret !== secretRow.value) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  const apiKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'OPENROUTER_API_KEY belum di-set di Supabase Secrets' }), { status: 500 })
  }

  const url = new URL(req.url)
  const limit = Number(url.searchParams.get('limit') ?? '5')

  const { data: stocks, error } = await supabase
    .from('stocks')
    .select('id, ticker, name, trending_score, trending_label')
    .not('trending_score', 'is', null)
    .is('trending_reason', null)
    .order('trending_score', { ascending: false })
    .limit(limit)

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  let success = 0, failed = 0
  const debugSamples: Record<string, string> = {}

  for (const s of stocks ?? []) {
    try {
      const prompt = `Ticker: ${s.ticker} (${s.name})\nTrending Score: ${s.trending_score}\nTrending Label: ${s.trending_label}`
      const { text, modelUsed, usage } = await callOpenRouter(prompt, apiKey)

      await supabase.from('stocks').update({ trending_reason: text }).eq('id', s.id)
      await supabase.from('ai_usage').insert({ worker: 'generate-trending-reason', model: modelUsed, tokens_input: usage.input, tokens_output: usage.output, reference_id: s.id } as never)

      success++
    } catch (err) {
      failed++
      debugSamples[String(s.id)] = String(err)
    }
  }

  return new Response(JSON.stringify({ limit, processed: (stocks ?? []).length, success, failed, debug_samples: debugSamples }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
})
