import { createClient } from 'jsr:@supabase/supabase-js@2'

// v7 quote endpoint mendukung banyak simbol sekaligus (batch) dan sudah
// menyertakan marketCap langsung, jadi lebih efisien daripada v8/chart per ticker.
const YAHOO_QUOTE_BASE = 'https://query1.finance.yahoo.com/v7/finance/quote'
const BATCH_SIZE = 40
const BATCH_DELAY_MS = 300

type StockRow = { id: string; ticker: string }

async function fetchQuoteBatch(tickers: string[]) {
  const symbols = tickers.map((t) => `${t}.JK`).join(',')
  const res = await fetch(`${YAHOO_QUOTE_BASE}?symbols=${symbols}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  if (!res.ok) throw new Error(`batch HTTP ${res.status}`)
  const json = await res.json()
  const results = json?.quoteResponse?.result ?? []
  const bySymbol = new Map<string, Record<string, unknown>>()
  for (const r of results) {
    bySymbol.set(String(r.symbol).replace('.JK', ''), r)
  }
  return bySymbol
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

  for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
    const batch = (stocks as StockRow[]).slice(i, i + BATCH_SIZE)
    try {
      const quoteMap = await fetchQuoteBatch(batch.map((s) => s.ticker))
      const rows = batch
        .map((s) => {
          const q = quoteMap.get(s.ticker)
          if (!q) return null
          return {
            stock_id: s.id,
            price: q.regularMarketPrice ?? null,
            previous_close: q.regularMarketPreviousClose ?? null,
            day_high: q.regularMarketDayHigh ?? null,
            day_low: q.regularMarketDayLow ?? null,
            volume: q.regularMarketVolume ?? null,
            market_cap: q.marketCap ?? null,
            market_time: q.regularMarketTime
              ? new Date(Number(q.regularMarketTime) * 1000).toISOString()
              : null,
            quality: 'FRESH',
            updated_at: new Date().toISOString(),
          }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)

      if (rows.length > 0) {
        const { error: upsertError } = await supabase
          .from('quotes')
          .upsert(rows, { onConflict: 'stock_id' })
        if (upsertError) console.error('upsert error', upsertError)
      }

      totalOk += rows.length
      totalFailed += batch.length - rows.length
    } catch (e) {
      console.error('batch failed', e)
      totalFailed += batch.length
    }

    if (i + BATCH_SIZE < stocks.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
    }
  }

  return new Response(
    JSON.stringify({ total: stocks.length, ok: totalOk, failed: totalFailed }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
