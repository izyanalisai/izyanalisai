import { createClient } from 'jsr:@supabase/supabase-js@2'

// Fetch historical OHLCV dari Yahoo Finance chart API.
// H4 tidak ada di Yahoo, jadi diagregasi dari candle H1 yang sudah tersimpan.
const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart'
const CONCURRENCY = 10
const BATCH_DELAY_MS = 300

type StockRow = { id: string; ticker: string }
type Candle = { ts: string; open: number; high: number; low: number; close: number; volume: number | null }

const TIMEFRAME_CONFIG: Record<string, { interval: string; range: string }> = {
  D1: { interval: '1d', range: '2y' },
  W1: { interval: '1wk', range: '5y' },
  H1: { interval: '60m', range: '60d' },
}

async function fetchCandles(ticker: string, timeframe: string): Promise<Candle[]> {
  const cfg = TIMEFRAME_CONFIG[timeframe]
  const res = await fetch(
    `${YAHOO_CHART_BASE}/${ticker}.JK?interval=${cfg.interval}&range=${cfg.range}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } },
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result) throw new Error('no chart result')

  const timestamps: number[] = result.timestamp ?? []
  const quote = result.indicators?.quote?.[0] ?? {}
  const { open = [], high = [], low = [], close = [], volume = [] } = quote

  const rows: Candle[] = []
  for (let i = 0; i < timestamps.length; i++) {
    if (open[i] == null || high[i] == null || low[i] == null || close[i] == null) continue
    rows.push({
      ts: new Date(timestamps[i] * 1000).toISOString(),
      open: open[i], high: high[i], low: low[i], close: close[i],
      volume: volume[i] ?? null,
    })
  }
  return rows
}

function aggregateToH4(h1: Candle[]): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < h1.length; i += 4) {
    const b = h1.slice(i, i + 4)
    if (b.length === 0) continue
    out.push({
      ts: b[0].ts,
      open: b[0].open,
      high: Math.max(...b.map((c) => c.high)),
      low: Math.min(...b.map((c) => c.low)),
      close: b[b.length - 1].close,
      volume: b.reduce((sum, c) => sum + (c.volume ?? 0), 0),
    })
  }
  return out
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const url = new URL(req.url)
  const timeframe = (url.searchParams.get('timeframe') ?? 'D1').toUpperCase()
  const offset = Number(url.searchParams.get('offset') ?? '0')
  const limit = Number(url.searchParams.get('limit') ?? '50')

  if (!['D1', 'W1', 'H1', 'H4'].includes(timeframe)) {
    return new Response(JSON.stringify({ error: `timeframe tidak didukung: ${timeframe}` }), { status: 400 })
  }

  const { data: stocks, error } = await supabase
    .from('stocks')
    .select('id, ticker')
    .eq('is_active', true)
    .order('ticker')
    .range(offset, offset + limit - 1)

  if (error || !stocks) {
    return new Response(JSON.stringify({ error: error?.message ?? 'no stocks' }), { status: 500 })
  }

  let totalOk = 0, totalFailed = 0, totalCandles = 0
  const debugSamples: Record<string, string> = {}

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = (stocks as StockRow[]).slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (s) => {
        let candles: Candle[]
        if (timeframe === 'H4') {
          const { data: h1rows, error: h1err } = await supabase
            .from('candles')
            .select('ts, open, high, low, close, volume')
            .eq('stock_id', s.id)
            .eq('timeframe', 'H1')
            .order('ts', { ascending: true })
          if (h1err) throw h1err
          candles = aggregateToH4((h1rows ?? []) as Candle[])
        } else {
          candles = await fetchCandles(s.ticker, timeframe)
        }
        return { stock: s, candles }
      }),
    )

    for (const r of results) {
      if (r.status !== 'fulfilled') {
        totalFailed++
        debugSamples[`error-${totalFailed}`] = String(r.reason)
        continue
      }
      const { stock, candles } = r.value
      if (candles.length === 0) {
        totalFailed++
        debugSamples[stock.ticker] = 'no candle data'
        continue
      }
      const rows = candles.map((c) => ({ stock_id: stock.id, timeframe, ...c }))
      const { error: upsertErr } = await supabase
        .from('candles')
        .upsert(rows, { onConflict: 'stock_id,timeframe,ts' })
      if (upsertErr) {
        totalFailed++
        debugSamples[stock.ticker] = String(upsertErr.message)
        continue
      }
      totalOk++
      totalCandles += rows.length
    }

    if (i + CONCURRENCY < stocks.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
    }
  }

  return new Response(
    JSON.stringify({
      timeframe, offset, limit, total: stocks.length,
      ok: totalOk, failed: totalFailed, candles_upserted: totalCandles,
      debug_samples: debugSamples,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
