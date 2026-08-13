import { createClient } from 'jsr:@supabase/supabase-js@2'

// v7/finance/quote sekarang butuh autentikasi (401), jadi pakai v8/finance/chart
// yang sudah terbukti jalan di fetch-candles. Field quote terkini ada di result.meta.
const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart'
const CONCURRENCY = 10
const BATCH_DELAY_MS = 300

type StockRow = { id: string; ticker: string }

async function fetchQuoteMeta(ticker: string) {
  const res = await fetch(
    `${YAHOO_CHART_BASE}/${ticker}.JK?interval=1d&range=5d`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } },
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result?.meta) throw new Error('no chart meta')
  return result.meta
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: stocks, error } = await supabase
    .from('stocks')
    .select('id, ticker')
    .eq('is_active', true)

  if (error || !stocks) {
    return new Response(
      JSON.stringify({ error: error?.message ?? 'no stocks' }),
      { status: 500 },
    )
  }

  let totalOk = 0
  let totalFailed = 0
  const errorSamples: Record<string, string> = {}

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = (stocks as StockRow[]).slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (s) => ({ stock: s, meta: await fetchQuoteMeta(s.ticker) })),
    )

    const rows = []
    for (const r of results) {
      if (r.status !== 'fulfilled') {
        totalFailed++
        errorSamples[r.reason?.stock?.ticker ?? `idx-${totalFailed}`] = String(r.reason)
        continue
      }
      const { stock, meta } = r.value
      rows.push({
        stock_id: stock.id,
        price: meta.regularMarketPrice ?? null,
        previous_close: meta.chartPreviousClose ?? meta.previousClose ?? null,
        day_high: meta.regularMarketDayHigh ?? null,
        day_low: meta.regularMarketDayLow ?? null,
        volume: meta.regularMarketVolume ?? null,
        market_time: meta.regularMarketTime
          ? new Date(Number(meta.regularMarketTime) * 1000).toISOString()
          : null,
        quality: 'FRESH',
        updated_at: new Date().toISOString(),
      })
    }

    if (rows.length > 0) {
      const { error: upsertError } = await supabase
        .from('quotes')
        .upsert(rows, { onConflict: 'stock_id' })
      if (upsertError) {
        console.error('upsert error', upsertError)
        errorSamples['upsert'] = upsertError.message
        totalFailed += rows.length
      } else {
        totalOk += rows.length
      }
    }

    if (i + CONCURRENCY < stocks.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
    }
  }

  return new Response(
    JSON.stringify({ total: stocks.length, ok: totalOk, failed: totalFailed, error_samples: errorSamples }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
