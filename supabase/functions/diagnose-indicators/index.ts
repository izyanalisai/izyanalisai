import { createClient } from 'jsr:@supabase/supabase-js@2'

// Diagnostik: tes tiap indikator SENDIRI-SENDIRI (bukan digabung jadi 1 skor),
// biar ketauan mana yang beneran prediktif vs cuma nambah noise ke skor gabungan.
// Read-only, tidak menulis ke DB.

const ATR_PERIOD = 14
const MAX_HOLD_BARS = 20
const FEE_SLIPPAGE_PCT = 0.0025
const START_IDX = 60

const LQ45_TICKERS = [
  'AADI','ADMR','ADRO','AKRA','AMMN','AMRT','ANTM','ASII','BBCA','BBNI',
  'BBRI','BBTN','BMRI','BRPT','BUMI','CPIN','CUAN','DEWA','EMTK','ESSA',
  'EXCL','GOTO','HRTA','ICBP','INCO','INDF','INDY','INKP','ISAT','ITMG',
  'JPFA','KLBF','MAPI','MBMA','MDKA','MEDC','NCKL','PGAS','PGEO','PTBA',
  'SCMA','TLKM','UNTR','UNVR','WIFI',
]

type CandleRow = { ts: string; open: number; high: number; low: number; close: number; volume: number | null }
type Ind = {
  ema5: number | null; ema9: number | null; ema21: number | null; ema50: number | null
  rsi14: number | null; macd_line: number | null; macd_signal: number | null
  stoch_k: number | null; stoch_d: number | null; volume_avg20: number | null
}

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
    const gain = diff >= 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return result
}

function macd(closes: number[]): { line: (number | null)[]; signal: (number | null)[] } {
  const ema12 = ema(closes, 12)
  const ema26 = ema(closes, 26)
  const line = closes.map((_, i) => (ema12[i] != null && ema26[i] != null ? ema12[i]! - ema26[i]! : null))
  const lineValsOnly = line.filter((v): v is number => v != null)
  const signalRaw = ema(lineValsOnly, 9)
  const signal: (number | null)[] = new Array(closes.length).fill(null)
  const offset = line.findIndex((v) => v != null)
  if (offset >= 0) {
    for (let i = 0; i < signalRaw.length; i++) signal[offset + i] = signalRaw[i]
  }
  return { line, signal }
}

function stochastic(candles: CandleRow[], period = 14, smoothK = 3): { k: (number | null)[]; d: (number | null)[] } {
  const k: (number | null)[] = new Array(candles.length).fill(null)
  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1)
    const highest = Math.max(...window.map((c) => c.high))
    const lowest = Math.min(...window.map((c) => c.low))
    k[i] = highest === lowest ? 50 : ((candles[i].close - lowest) / (highest - lowest)) * 100
  }
  const kVals = k.filter((v): v is number => v != null)
  const dRaw = ema(kVals, smoothK)
  const d: (number | null)[] = new Array(candles.length).fill(null)
  const offset = k.findIndex((v) => v != null)
  if (offset >= 0) {
    for (let i = 0; i < dRaw.length; i++) d[offset + i] = dRaw[i]
  }
  return { k, d }
}

function computeATR(candles: CandleRow[], period = ATR_PERIOD): number | null {
  if (candles.length < period + 1) return null
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1]
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close))
    trs.push(tr)
  }
  const lastN = trs.slice(-period)
  return lastN.reduce((a, b) => a + b, 0) / lastN.length
}

type Bucket = { trades: number; wins: number; losses: number; timeouts: number; grossProfit: number; grossLoss: number }
function newBucket(): Bucket { return { trades: 0, wins: 0, losses: 0, timeouts: 0, grossProfit: 0, grossLoss: 0 } }

function simulate(direction: 'BUY' | 'SELL', entryIdx: number, candles: CandleRow[], entry: number, stopLoss: number, tp1: number): { outcome: 'WIN' | 'LOSS' | 'TIMEOUT'; pnl: number } {
  for (let i = entryIdx + 1; i <= Math.min(entryIdx + MAX_HOLD_BARS, candles.length - 1); i++) {
    const bar = candles[i]
    if (direction === 'BUY') {
      if (bar.low <= stopLoss) return { outcome: 'LOSS', pnl: (stopLoss - entry) / entry - FEE_SLIPPAGE_PCT }
      if (bar.high >= tp1) return { outcome: 'WIN', pnl: (tp1 - entry) / entry - FEE_SLIPPAGE_PCT }
    } else {
      if (bar.high >= stopLoss) return { outcome: 'LOSS', pnl: (entry - stopLoss) / entry - FEE_SLIPPAGE_PCT }
      if (bar.low <= tp1) return { outcome: 'WIN', pnl: (entry - tp1) / entry - FEE_SLIPPAGE_PCT }
    }
  }
  return { outcome: 'TIMEOUT', pnl: 0 }
}

function record(buckets: Record<string, Bucket>, key: string, res: { outcome: 'WIN' | 'LOSS' | 'TIMEOUT'; pnl: number }) {
  if (!buckets[key]) buckets[key] = newBucket()
  const b = buckets[key]
  b.trades++
  if (res.outcome === 'WIN') { b.wins++; b.grossProfit += res.pnl }
  else if (res.outcome === 'LOSS') { b.losses++; b.grossLoss += Math.abs(res.pnl) }
  else b.timeouts++
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: stocks, error: stErr } = await supabase
    .from('stocks')
    .select('id, ticker')
    .in('ticker', LQ45_TICKERS)

  if (stErr || !stocks || stocks.length === 0) {
    return new Response(JSON.stringify({ error: stErr?.message ?? 'saham LQ45 tidak ditemukan' }), { status: 500 })
  }

  const buckets: Record<string, Bucket> = {}
  const missingTickers: string[] = []

  for (const stock of stocks as { id: string; ticker: string }[]) {
    const { data: candleRows, error: cErr } = await supabase
      .from('candles')
      .select('ts, open, high, low, close, volume')
      .eq('stock_id', stock.id)
      .eq('timeframe', 'D1')
      .order('ts', { ascending: true })

    if (cErr || !candleRows || candleRows.length < 80) {
      missingTickers.push(stock.ticker)
      continue
    }
    const candles = candleRows as CandleRow[]
    const closes = candles.map((c) => c.close)

    const ema5 = ema(closes, 5), ema9 = ema(closes, 9), ema21 = ema(closes, 21), ema50 = ema(closes, 50)
    const rsi14 = rsi(closes, 14)
    const { line: macdLine, signal: macdSignal } = macd(closes)
    const { k: stochK, d: stochD } = stochastic(candles)
    const volAvg20: (number | null)[] = new Array(candles.length).fill(null)
    for (let i = 19; i < candles.length; i++) {
      const window = candles.slice(i - 19, i + 1).map((c) => c.volume ?? 0)
      volAvg20[i] = window.reduce((a, b) => a + b, 0) / 20
    }

    const endIdx = candles.length - 1
    for (let i = START_IDX; i < endIdx; i++) {
      const ind: Ind = {
        ema5: ema5[i], ema9: ema9[i], ema21: ema21[i], ema50: ema50[i],
        rsi14: rsi14[i], macd_line: macdLine[i], macd_signal: macdSignal[i],
        stoch_k: stochK[i], stoch_d: stochD[i], volume_avg20: volAvg20[i],
      }
      const lastCandle = candles[i]
      const prevClose = candles[i - 1].close
      const atr = computeATR(candles.slice(0, i + 1))
      if (atr == null) continue
      const entry = lastCandle.close

      // Untuk tiap sinyal individual bullish/bearish, simulasikan seolah entry
      // sendiri (SL 1.5xATR, TP1 1.5R) -- biar terukur "kalau CUMA indikator ini
      // doang yang dipakai, hasilnya gimana", terlepas dari skor gabungan.
      function tryDirection(key: string, direction: 'BUY' | 'SELL') {
        const stopLoss = direction === 'BUY' ? entry - 1.5 * atr! : entry + 1.5 * atr!
        const risk = Math.abs(entry - stopLoss)
        const tp1 = direction === 'BUY' ? entry + 1.5 * risk : entry - 1.5 * risk
        const res = simulate(direction, i, candles, entry, stopLoss, tp1)
        record(buckets, key, res)
      }

      // EMA
      if (ind.ema5 != null && ind.ema21 != null && ind.ema9 != null && ind.ema50 != null) {
        if (ind.ema5 > ind.ema21 && ind.ema9 > ind.ema50) tryDirection('ema_bullish', 'BUY')
        else if (ind.ema5 < ind.ema21 && ind.ema9 < ind.ema50) tryDirection('ema_bearish', 'SELL')
      }
      // RSI
      if (ind.rsi14 != null) {
        if (ind.rsi14 > 55) tryDirection('rsi_bullish', 'BUY')
        else if (ind.rsi14 < 45) tryDirection('rsi_bearish', 'SELL')
      }
      // MACD
      if (ind.macd_line != null && ind.macd_signal != null) {
        if (ind.macd_line > ind.macd_signal) tryDirection('macd_bullish', 'BUY')
        else tryDirection('macd_bearish', 'SELL')
      }
      // Stochastic
      if (ind.stoch_k != null && ind.stoch_d != null) {
        if (ind.stoch_k > ind.stoch_d && ind.stoch_k < 80) tryDirection('stoch_bullish', 'BUY')
        else if (ind.stoch_k < ind.stoch_d && ind.stoch_k > 20) tryDirection('stoch_bearish', 'SELL')
      }
      // Volume spike + arah harga
      const priceUp = lastCandle.close > prevClose
      if (ind.volume_avg20 != null && lastCandle.volume != null && lastCandle.volume > ind.volume_avg20 * 1.5) {
        if (priceUp) tryDirection('volume_spike_bullish', 'BUY')
        else tryDirection('volume_spike_bearish', 'SELL')
      }
      // Candlestick kuat
      const body = Math.abs(lastCandle.close - lastCandle.open)
      const range = lastCandle.high - lastCandle.low
      if (range > 0 && body / range > 0.6) {
        if (lastCandle.close > lastCandle.open) tryDirection('candle_bullish', 'BUY')
        else tryDirection('candle_bearish', 'SELL')
      }
    }
  }

  const result: Record<string, unknown> = {}
  for (const [key, b] of Object.entries(buckets)) {
    const closed = b.wins + b.losses
    result[key] = {
      trades: b.trades,
      wins: b.wins,
      losses: b.losses,
      timeouts: b.timeouts,
      win_rate_pct: closed > 0 ? Number(((b.wins / closed) * 100).toFixed(1)) : null,
      profit_factor: b.grossLoss > 0 ? Number((b.grossProfit / b.grossLoss).toFixed(2)) : null,
    }
  }

  return new Response(
    JSON.stringify({ universe: 'LQ45', total_stocks_tested: stocks.length - missingTickers.length, missing_tickers: missingTickers, per_indicator: result }, null, 2),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
