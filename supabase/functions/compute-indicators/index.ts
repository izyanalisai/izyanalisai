import { createClient } from 'jsr:@supabase/supabase-js@2'

// Hitung indicator teknikal dari candle yang sudah tersimpan di DB (bukan fetch ke Yahoo lagi).
// Butuh minimum 60 bar candle supaya EMA50/MACD/Stochastic valid.
const MIN_BARS = 60
const CONCURRENCY = 25

type StockRow = { id: string; ticker: string }
type CandleRow = { ts: string; high: number; low: number; close: number; volume: number | null }

function ema(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null)
  if (values.length < period) return result
  const k = 2 / (period + 1)
  let sma = 0
  for (let i = 0; i < period; i++) sma += values[i]
  sma /= period
  result[period - 1] = sma
  let prev = sma
  for (let i = period; i < values.length; i++) {
    const val = values[i] * k + prev * (1 - k)
    result[i] = val
    prev = val
  }
  return result
}

function rsi(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null)
  if (closes.length < period + 1) return result
  let gains = 0, losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gains += diff; else losses += -diff
  }
  let avgGain = gains / period
  let avgLoss = losses / period
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return result
}

function macd(closes: number[]) {
  const ema12 = ema(closes, 12)
  const ema26 = ema(closes, 26)
  const macdLine: (number | null)[] = closes.map((_, i) =>
    ema12[i] != null && ema26[i] != null ? ema12[i]! - ema26[i]! : null
  )
  const validIdx: number[] = []
  const validVals: number[] = []
  macdLine.forEach((v, i) => { if (v != null) { validIdx.push(i); validVals.push(v) } })
  const signalOnValid = ema(validVals, 9)
  const signalLine: (number | null)[] = new Array(closes.length).fill(null)
  signalOnValid.forEach((v, idx) => { if (v != null) signalLine[validIdx[idx]] = v })
  const hist: (number | null)[] = closes.map((_, i) =>
    macdLine[i] != null && signalLine[i] != null ? macdLine[i]! - signalLine[i]! : null
  )
  return { macdLine, signalLine, hist }
}

function stochastic(highs: number[], lows: number[], closes: number[], period = 14, smoothK = 3, smoothD = 3) {
  const rawK: (number | null)[] = new Array(closes.length).fill(null)
  for (let i = period - 1; i < closes.length; i++) {
    const sliceHigh = highs.slice(i - period + 1, i + 1)
    const sliceLow = lows.slice(i - period + 1, i + 1)
    const hh = Math.max(...sliceHigh)
    const ll = Math.min(...sliceLow)
    rawK[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100
  }
  const kSmoothed: (number | null)[] = new Array(closes.length).fill(null)
  for (let i = 0; i < closes.length; i++) {
    const window = rawK.slice(Math.max(0, i - smoothK + 1), i + 1).filter((v) => v != null) as number[]
    if (window.length === smoothK) kSmoothed[i] = window.reduce((a, b) => a + b, 0) / smoothK
  }
  const dSmoothed: (number | null)[] = new Array(closes.length).fill(null)
  for (let i = 0; i < closes.length; i++) {
    const window = kSmoothed.slice(Math.max(0, i - smoothD + 1), i + 1).filter((v) => v != null) as number[]
    if (window.length === smoothD) dSmoothed[i] = window.reduce((a, b) => a + b, 0) / smoothD
  }
  return { k: kSmoothed, d: dSmoothed }
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const url = new URL(req.url)
  const timeframe = (url.searchParams.get('timeframe') ?? 'D1').toUpperCase()
  const offset = Number(url.searchParams.get('offset') ?? '0')
  const limit = Number(url.searchParams.get('limit') ?? '300')

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

  let totalOk = 0, totalSkipped = 0, totalFailed = 0
  const debugSamples: Record<string, string> = {}

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = (stocks as StockRow[]).slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (s) => {
        const { data: candles, error: cErr } = await supabase
          .from('candles')
          .select('ts, high, low, close, volume')
          .eq('stock_id', s.id)
          .eq('timeframe', timeframe)
          .order('ts', { ascending: true })
        if (cErr) throw cErr
        return { stock: s, candles: (candles ?? []) as CandleRow[] }
      }),
    )

    const rowsToUpsert: Record<string, unknown>[] = []

    for (const r of results) {
      if (r.status !== 'fulfilled') {
        totalFailed++
        debugSamples[`error-${totalFailed}`] = String(r.reason)
        continue
      }
      const { stock, candles } = r.value
      if (candles.length < MIN_BARS) {
        totalSkipped++
        continue
      }
      const closes = candles.map((c) => c.close)
      const highs = candles.map((c) => c.high)
      const lows = candles.map((c) => c.low)
      const volumes = candles.map((c) => c.volume)

      const ema5 = ema(closes, 5)
      const ema9 = ema(closes, 9)
      const ema21 = ema(closes, 21)
      const ema50 = ema(closes, 50)
      const rsi14 = rsi(closes, 14)
      const { macdLine, signalLine, hist } = macd(closes)
      const { k, d } = stochastic(highs, lows, closes)
      const last20Vol = volumes.slice(-20).filter((v): v is number => v != null)
      const volAvg20 = last20Vol.length === 20 ? last20Vol.reduce((a, b) => a + b, 0) / 20 : null

      const lastIdx = closes.length - 1
      rowsToUpsert.push({
        stock_id: stock.id,
        timeframe,
        ts: candles[lastIdx].ts,
        ema5: ema5[lastIdx],
        ema9: ema9[lastIdx],
        ema21: ema21[lastIdx],
        ema50: ema50[lastIdx],
        rsi14: rsi14[lastIdx],
        macd_line: macdLine[lastIdx],
        macd_signal: signalLine[lastIdx],
        macd_hist: hist[lastIdx],
        stoch_k: k[lastIdx],
        stoch_d: d[lastIdx],
        volume_avg20: volAvg20,
        updated_at: new Date().toISOString(),
      })
      totalOk++
    }

    if (rowsToUpsert.length > 0) {
      const { error: upsertErr } = await supabase
        .from('indicators')
        .upsert(rowsToUpsert, { onConflict: 'stock_id,timeframe' })
      if (upsertErr) {
        debugSamples['upsert-error'] = upsertErr.message
      }
    }
  }

  return new Response(
    JSON.stringify({
      timeframe, offset, limit, total: stocks.length,
      ok: totalOk, skipped_insufficient_data: totalSkipped, failed: totalFailed,
      debug_samples: debugSamples,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
