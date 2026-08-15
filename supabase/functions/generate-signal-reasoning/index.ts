import { createClient } from 'jsr:@supabase/supabase-js@2'

// Worker Sinyal AI - generate penjelasan/reasoning teks untuk kartu sinyal.
// PENTING: worker ini HANYA menjelaskan evidence yang sudah dihitung engine deterministik
// (generate-signals). Tidak pernah menentukan ulang angka Buy Area/SL/TP/RR/Confidence.
// Fallback 3 model GRATIS OpenRouter.
const FREE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
]

const SYSTEM_PROMPT = 'Kamu menjelaskan alasan sinyal saham berdasarkan evidence teknikal yang diberikan. JANGAN pernah menyebut/mengubah angka Buy Area, SL, TP, RR, atau Confidence -- itu sudah fix dari engine. Tulis 2-4 kalimat bahasa Indonesia santai, jelasin kenapa indikator2 itu mendukung arah sinyalnya.'

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
    try {
      const baseUrl = Deno.env.get('AI_BASE_URL') || 'https://openrouter.ai/api/v1'
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://izyanalisai.vercel.app',
          'X-Title': 'IzyAnalisAI Signal Reasoning',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          max_tokens: 300,
        }),
      })
      if (res.status === 429 || res.status === 402 || !res.ok) { lastError = await res.text(); continue }
      const data = await res.json()
      const rawText = data?.choices?.[0]?.message?.content ?? ''
      const text = sanitizeReply(rawText)
      if (!text) { lastError = 'response kosong setelah sanitize'; continue }
      return { text, modelUsed: model, usage: { input: data?.usage?.prompt_tokens ?? 0, output: data?.usage?.completion_tokens ?? 0 } }
    } catch (err) { lastError = err; continue }
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
  const limit = Number(url.searchParams.get('limit') ?? '8')
  const offset = Number(url.searchParams.get('offset') ?? '0')

  const { data: signals, error } = await supabase
    .from('signals')
    .select('id, direction, entry_price, buy_area_low, buy_area_high, tp1, tp2, stop_loss, risk_reward, confidence_score, evidence, timeframe, stock_id, stocks(ticker, name)')
    .eq('status', 'ACTIVE')
    .is('ai_reasoning', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  let success = 0, failed = 0
  const debugSamples: Record<string, string> = {}

  for (const s of signals ?? []) {
    try {
      const ticker = (s as any).stocks?.ticker ?? s.stock_id
      const prompt = `Ticker: ${ticker}\nTimeframe: ${s.timeframe}\nArah: ${s.direction}\nEntry: ${s.entry_price}\nBuy Area: ${s.buy_area_low} - ${s.buy_area_high}\nTP1: ${s.tp1}, TP2: ${s.tp2}\nStop Loss: ${s.stop_loss}\nRisk/Reward: ${s.risk_reward}\nConfidence: ${s.confidence_score}\nEvidence teknikal: ${JSON.stringify(s.evidence)}`

      const { text, modelUsed, usage } = await callOpenRouter(prompt, apiKey)

      await supabase.from('signals').update({ ai_reasoning: { text, model: modelUsed, generated_at: new Date().toISOString() } }).eq('id', s.id)
      await supabase.from('ai_usage').insert({ worker: 'generate-signal-reasoning', model: modelUsed, tokens_input: usage.input, tokens_output: usage.output, reference_id: s.id } as never)

      success++
    } catch (err) {
      failed++
      debugSamples[String(s.id)] = String(err)
    }
  }

  return new Response(JSON.stringify({ offset, limit, processed: (signals ?? []).length, success, failed, debug_samples: debugSamples }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
})
