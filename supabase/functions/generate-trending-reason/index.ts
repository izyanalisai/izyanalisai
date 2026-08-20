import { createClient } from 'jsr:@supabase/supabase-js@2'
import { callAI, simplePrompt, sanitizeShortReply, AllProvidersFailedError } from '../_shared/callAI.ts'

// Worker Trending Score - generate 1-2 kalimat alasan kenapa saham lagi trending.
// REFACTORED (20 Agustus 2026): sekarang pakai callAI('FAST', ...) dari _shared/callAI.ts
// alih-alih callAIChain lokal. Behavior sama persis (9Router tier 1, OpenRouter tier 2,
// SSE fallback parse), cuma sumber logic-nya sekarang satu tempat.
// Diproses SATU-SATU (bukan paralel). RESUMABLE OTOMATIS: selalu ambil saham
// yang trending_reason-nya masih NULL.

const SYSTEM_PROMPT =
  'Kamu menulis 1-2 kalimat singkat bahasa Indonesia yang menjelaskan kenapa sebuah saham sedang trending, berdasarkan skor & label yang diberikan. Jangan menyebut angka harga baru, jangan kasih rekomendasi buy/sell.'

Deno.serve(async (req: Request) => {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const providedSecret = req.headers.get('x-worker-secret')
  const { data: secretRow } = await supabase.from('internal_secrets').select('value').eq('key', 'worker_shared_secret').maybeSingle()
  if (!providedSecret || !secretRow || providedSecret !== secretRow.value) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
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

      // Satu-satunya perbedaan dari worker lama: panggil callAI('FAST', ...)
      // bukan callAIChain lokal. Task type 'FAST' otomatis pakai
      // NINEROUTER_MODEL_FAST (atau fallback NINEROUTER_MODEL lama).
      const { text: rawText, modelUsed, usage } = await callAI('FAST', simplePrompt(SYSTEM_PROMPT, prompt))
      const text = sanitizeShortReply(rawText, SYSTEM_PROMPT)

      if (!text) throw new Error('response kosong setelah sanitize')

      await supabase.from('stocks').update({ trending_reason: text }).eq('id', s.id)
      await supabase.from('ai_usage').insert({ worker: 'generate-trending-reason', model: modelUsed, tokens_input: usage.input, tokens_output: usage.output, reference_id: s.id } as never)

      success++
    } catch (err) {
      failed++
      debugSamples[String(s.id)] = String(err)
      console.error(`[generate-trending-reason] gagal untuk stock ${s.id} (${s.ticker}):`, err)
    }
  }

  return new Response(JSON.stringify({ limit, processed: (stocks ?? []).length, success, failed, debug_samples: debugSamples }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
})
