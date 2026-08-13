import { createClient } from 'jsr:@supabase/supabase-js@2'

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/'
const CONCURRENCY = 15
const BATCH_DELAY_MS = 300

type StockRow = { id: string; ticker: string }

async function fetchQuote(ticker: string) {
  const res = await fetch(`${YAHOO_BASE}${ticker}.JK`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`)
  const json = await res.json()
  const meta = json?.chart?.result?.[0]?.meta
  if (!meta) throw new Error(`${ticker}: no meta`)
  return {
    price: meta.regularMarketPrice ?? null,
    previous_close: meta.previousClose ?? null,
    day_high: meta.regularMarketDayHigh ?? null,
    day_low: meta.regularMarketDayLow ?? null,
    volume: meta.regularMarketVolume ?? null,
    market_time: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : null,
  }
}

async function processBatch(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  stocks: StockRow[],
) {
  const results = await Promise.allSettled(
    stocks.map(async (s) => {
      const q = await fetchQuote(s.ticker)
      return {
        stock_id: s.id,
        ...q,
        quality: 'FRESH',
        updated_at: new Date().toISOString(),
      }
    }),
  )

  const rows = results
    .filter((r): r is PromiseFulfilledResult<Record<string, unknown>> =>
      r.status === 'fulfilled'
    )
    .map((r) => r.value)
  const failed = results.length - rows.length

  if (rows.length > 0) {
    const { error } = await supabase
      .from('quotes')
      .upsert(rows, { onConflict: 'stock_id' })
    if (error) console.error('upsert error', error)
  }

  return { ok: rows.length, failed }
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

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = stocks.slice(i, i + CONCURRENCY)
    const { ok, failed } = await processBatch(supabase, batch)
    totalOk += ok
    totalFailed += failed
    if (i + CONCURRENCY < stocks.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
    }
  }

  return new Response(
    JSON.stringify({ total: stocks.length, ok: totalOk, failed: totalFailed }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
