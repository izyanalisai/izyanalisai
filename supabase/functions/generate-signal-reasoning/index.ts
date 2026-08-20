import { createClient } from 'jsr:@supabase/supabase-js@2'

// Worker Sinyal AI - generate penjelasan/reasoning teks untuk kartu sinyal.
// PENTING: worker ini HANYA menjelaskan evidence yang sudah dihitung engine deterministik
// (generate-signals). Tidak pernah menentukan ulang angka Buy Area/SL/TP/RR/Confidence.
// Tier 1: 9Router (self-hosted di Railway, OpenAI-compatible) -- provider utama.
// Tier 2: OpenRouter, 3 model gratis -- fallback kalau 9Router gagal total.
const NINEROUTER_MODELS = [
  Deno.env.get('NINEROUTER_MODEL') || 'auto',
]

const FREE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
]

const SYSTEM_PROMPT = `Kamu menjelaskan alasan sinyal saham berdasarkan evidence struktur harga (support/resistance, struktur swing, EMA) yang diberikan.

ATURAN YANG HARUS DIPATUHI:
- JANGAN pernah menyebut/mengubah angka Buy Area, SL, TP, atau membuat klaim statistik apapun (win rate, probabilitas, confidence) -- angka sudah fix dari engine.
- Jika ada "Katalis Berita" di evidence, sebutkan secara singkat sebagai pendukung, tapi tetap tekankan bahwa keputusan utama berdasarkan struktur harga.
- Tulis 2-4 kalimat bahasa Indonesia santai, jelasin kenapa struktur harga di timeframe-timeframe terkait mendukung arah sinyalnya.
- JANGAN pernah menulis "Berdasarkan analisis saya" atau "Menurut saya" — tulis seolah-olah ini adalah kesimpulan dari engine.`

function sanitizeReply(raw: string): string {
  let text = raw.trim()
  const marker = SYSTEM_PROMPT.slice(0, 25)
  const idx = text.indexOf(marker)
  if (idx !== -1) text = text.slice(0, idx).trim()
  text = text.replace(/^["']|["']$/g, '').trim()
  return text
}

// FIX (19 Agustus 2026): 9Router kadang balas format SSE walau stream tidak
// diminta -- res.json() gagal parse. Sama seperti fix di chat-asisten-ai/
// analyze-chart: minta stream:false eksplisit + fallback parse manual.
function parseSSEToContent(raw: string): string {
  let content = ''
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const chunk = JSON.parse(payload)
      const delta = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content
      if (delta) content += delta
    } catch { continue }
  }
  return content
}

async function callProvider(providerLabel: string, baseUrl: string, apiKey: string, models: string[], prompt: string, extraHeaders: Record<string, string> = {}) {
  let lastError: unknown = null
  for (const model of models) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          max_tokens: 300,
          stream: false,
        }),
      })
      if (res.status === 429 || res.status === 402 || !res.ok) {
        lastError = await res.text()
        continue
      }
      const rawBody = await res.text()
      let rawText = ''
      let usageIn = 0, usageOut = 0
      try {
        const data = JSON.parse(rawBody)
        rawText = data?.choices?.[0]?.message?.content ?? ''
        usageIn = data?.usage?.prompt_tokens ?? 0
        usageOut = data?.usage?.completion_tokens ?? 0
      } catch {
        console.error(`[generate-signal-reasoning] [${providerLabel}] model ${model} balas non-JSON (kemungkinan SSE), coba parse manual`)
        rawText = parseSSEToContent(rawBody)
      }
      const text = sanitizeReply(rawText)
      if (!text) {
        lastError = 'response kosong setelah sanitize'
        continue
      }
      return {
        text,
        modelUsed: `${providerLabel}:${model}`,
        usage: { input: usageIn, output: usageOut },
      }
    } catch (err) {
      lastError = err
      continue
    }
  }
  throw new Error(`[${providerLabel}] semua model gagal: ${JSON.stringify(lastError)}`)
}

// Coba 9Router (tier 1) dulu, fallback ke OpenRouter (tier 2) kalau gagal total
// atau OPENROUTER_API_KEY belum di-set (fallback jadi opsional).
async function callAIChain(prompt: string, nineRouterKey: string, nineRouterBaseUrl: string) {
  try {
    return await callProvider('9router', nineRouterBaseUrl, nineRouterKey, NINEROUTER_MODELS, prompt)
  } catch (nineRouterErr) {
    const openRouterKey = Deno.env.get('OPENROUTER_API_KEY')
    if (!openRouterKey) throw nineRouterErr
    try {
      const baseUrl = Deno.env.get('AI_BASE_URL') || 'https://openrouter.ai/api/v1'
      return await callProvider('openrouter', baseUrl, openRouterKey, FREE_MODELS, prompt, {
        'HTTP-Referer': 'https://izyanalisai.vercel.app',
        'X-Title': 'IzyAnalisAI Signal Reasoning',
      })
    } catch (openRouterErr) {
      throw new Error(`Semua provider AI gagal. 9router: ${String(nineRouterErr)} | openrouter: ${String(openRouterErr)}`)
    }
  }
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const providedSecret = req.headers.get('x-worker-secret')
  const { data: secretRow } = await supabase
    .from('internal_secrets')
    .select('value')
    .eq('key', 'worker_shared_secret')
    .maybeSingle()

  if (!providedSecret || !secretRow || providedSecret !== secretRow.value) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  // FIX: baca 9Router dari internal_secrets (DB) — bukan env var yang tidak pernah diset.
  // Kedua sumber dicoba: env var diutamakan kalau ada (untuk fleksibilitas override),
  // fallback ke internal_secrets jika tidak ada.
  let nineRouterKey = Deno.env.get('NINEROUTER_API_KEY')
  let nineRouterBaseUrl = Deno.env.get('NINEROUTER_BASE_URL')
  if (!nineRouterKey || !nineRouterBaseUrl) {
    const { data: nrRows } = await supabase
      .from('internal_secrets')
      .select('key,value')
      .in('key', ['nineRouter_api_key', 'nineRouter_base_url'])
    const nrMap = Object.fromEntries((nrRows ?? []).map((r: any) => [r.key, r.value]))
    nineRouterKey = nineRouterKey || nrMap['nineRouter_api_key']
    nineRouterBaseUrl = nineRouterBaseUrl || (nrMap['nineRouter_base_url'] ? nrMap['nineRouter_base_url'] + '/v1' : undefined)
  }
  if (!nineRouterKey || !nineRouterBaseUrl) {
    return new Response(
      JSON.stringify({ error: 'NINEROUTER_API_KEY/NINEROUTER_BASE_URL belum di-set (env atau internal_secrets)' }),
      { status: 500 }
    )
  }

  const url = new URL(req.url)
  const limit = Number(url.searchParams.get('limit') ?? '8')
  const offset = Number(url.searchParams.get('offset') ?? '0')

  const { data: signals, error } = await supabase
    .from('signals')
    .select(
      `id, direction, entry_price, buy_area_low, buy_area_high, tp1, tp2, stop_loss, 
       support_level, resistance_level, evidence, signal_tier, entry_timeframe, 
       confirm_timeframe, bias_timeframe, stock_id, stocks(ticker, name)`
    )
    .eq('status', 'ACTIVE')
    .is('ai_reasoning', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  let success = 0,
    failed = 0
  const debugSamples: Record<string, string> = {}

  for (const s of signals ?? []) {
    try {
      const ticker = (s as any).stocks?.ticker ?? s.stock_id
      const tierLabel = s.signal_tier === 'swing' ? 'Swing' : 'Daily'
      const tfChain = s.confirm_timeframe
        ? `${s.entry_timeframe} -> ${s.confirm_timeframe} -> ${s.bias_timeframe}`
        : `${s.entry_timeframe} -> ${s.bias_timeframe}`

      // 👇 [TAMBAHAN] Ambil catalyst dari evidence
      const ev = s.evidence as any
      let catalystText = ''
      if (ev?.catalyst && ev.catalyst.has_catalyst) {
        catalystText = `\n\n📰 KATALIS BERITA POSITIF:\n- ${ev.catalyst.summary}\n- Sumber: ${ev.catalyst.source}\n- Waktu: ${new Date(ev.catalyst.published_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`
      }

      const prompt = `Ticker: ${ticker}
Tier: ${tierLabel} (confluence ${tfChain})
Arah: ${s.direction}
Entry: ${s.entry_price}
Buy Area: ${s.buy_area_low} - ${s.buy_area_high}
Support: ${s.support_level}, Resistance: ${s.resistance_level}
TP1: ${s.tp1}, TP2: ${s.tp2}
Stop Loss: ${s.stop_loss}
Evidence struktur: ${JSON.stringify(s.evidence)}${catalystText}`

      const { text, modelUsed, usage } = await callAIChain(prompt, nineRouterKey, nineRouterBaseUrl)

      await supabase
        .from('signals')
        .update({
          ai_reasoning: {
            text,
            model: modelUsed,
            generated_at: new Date().toISOString(),
          },
        })
        .eq('id', s.id)

      await supabase.from('ai_usage').insert({
        worker: 'generate-signal-reasoning',
        model: modelUsed,
        tokens_input: usage.input,
        tokens_output: usage.output,
        reference_id: s.id,
      } as never)

      success++
    } catch (err) {
      failed++
      debugSamples[String(s.id)] = String(err)
      console.error(`[generate-signal-reasoning] gagal untuk signal ${s.id} (${(s as any).stocks?.ticker ?? s.stock_id}):`, err)
    }
  }

  return new Response(
    JSON.stringify({
      offset,
      limit,
      processed: (signals ?? []).length,
      success,
      failed,
      debug_samples: debugSamples,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  )
})
