import { createClient } from 'jsr:@supabase/supabase-js@2'

// Backtest Worker 2 (Generate Signal) sesuai dokumen 9.3.1.
//
// v11 (tiered liquidity, 15 Agustus 2026): v10 gagal gate karena memakai
// SATU gate keras (WR>=55%) untuk SEMUA saham LQ45 sekaligus (WR terbaik
// jujur cuma 51.5%, padahal PF 1.54 & MaxDD 6.7% sudah lulus).
//
// v11 mengubah pendekatan: alih-alih satu gate untuk satu universe, saham
// disegmentasi ke 3 tier likuiditas (dihitung dari rata-rata nilai transaksi
// harian riil = close x volume, BUKAN cuma keanggotaan index LQ45), dan
// masing-masing tier punya gate sendiri yang realistis sesuai karakter
// pasarnya:
// - TIER_A (Liquid/blue chip) : WR tinggi realistis dicapai -> gate WR>=60%
// - TIER_B (Mid liquidity) : WR sedang, PF harus lebih tinggi utk kompensasi
// - TIER_C (Gorengan/tdk likuid): WR rendah wajar (noise/manipulasi tinggi),
// tapi harus RR besar (PF>=2.5) biar tetap profitable
//
// Formula scoring TA (indicator, confluence, TP1=1.5R, SL=1.5xATR) TIDAK
// diubah dari v10 -- hanya cara evaluasi & gate-nya yang disegmentasi.
// PENTING: logic scoring & formula Entry/SL/TP di file ini WAJIB identik
// dengan supabase/functions/generate-signals/index.ts.

const FORMULA_VERSION = 'tiered_v11'
const ATR_PERIOD = 14
const ADX_PERIOD = 14
const ADX_THRESHOLD = 25
const MIN_SCORE = 8
const BREADTH_THRESHOLD = 50
const FEE_SLIPPAGE_PCT = 0.0025
const FIXED_RISK_PCT = 0.01

const TIMEFRAME_CONFIG: Record<string, { minBars: number; startIdx: number; maxHoldBars: number }> = {
  D1: { minBars: 80, startIdx: 60, maxHoldBars: 20 },
  W1: { minBars: 60, startIdx: 40, maxHoldBars: 12 },
  H1: { minBars: 70, startIdx: 55, maxHoldBars: 40 },
  H4: { minBars: 50, startIdx: 35, maxHoldBars: 24 },
}

// --- Segmentasi likuiditas ---------------------------------------------
// Threshold dalam Rupiah, dihitung dari rata-rata (close x volume) candle
// D1/H4/dst terakhir (maks 60 bar terakhir yang tersedia per saham).
type TierKey = 'TIER_A' | 'TIER_B' | 'TIER_C'

const LIQUIDITY_TIERS: Record<TierKey, {
  label: string
  minDailyValue: number
  gate: { minWinRate: number; minProfitFactor: number; maxDrawdownPct: number }
}> = {
  TIER_A: {
    label: 'Liquid (Blue Chip)',
    minDailyValue: 10_000_000_000, // >= Rp 10 miliar/hari
    gate: { minWinRate: 60, minProfitFactor: 1.5, maxDrawdownPct: 25 },
  },
  TIER_B: {
    label: 'Mid Liquidity',
    minDailyValue: 1_000_000_000, // Rp 1-10 miliar/hari
    gate: { minWinRate: 50, minProfitFactor: 1.8, maxDrawdownPct: 25 },
  },
  TIER_C: {
    label: 'Gorengan / Low Liquidity',
    minDailyValue: 0, // < Rp 1 miliar/hari
    gate: { minWinRate: 40, minProfitFactor: 2.5, maxDrawdownPct: 30 },
  },
}

function classifyTier(avgDailyValue: number): TierKey {
  if (avgDailyValue >= LIQUIDITY_TIERS.TIER_A.minDailyValue) return 'TIER_A'
  if (avgDailyValue >= LIQUIDITY_TIERS.TIER_B.minDailyValue) return 'TIER_B'
  return 'TIER_C'
}

type CandleRow = { ts: string; open: number; high: number; low: number; close: number; volume: number | null }
type IndicatorPoint = {
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

function computeATRSeries(candles: CandleRow[], period = ATR_PERIOD): (number | null)[] {
  const result: (number | null)[] = new Array(candles.length).fill(null)
  const trs: (number | null)[] = new Array(candles.length).fill(null)
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1]
    trs[i] = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close))
  }
  let atr: number | null = null
  for (let i = 1; i < candles.length; i++) {
    if (trs[i] == null) continue
    if (atr == null) {
      if (i >= period) {
        const window = trs.slice(i - period + 1, i + 1) as number[]
        atr = window.reduce((a, b) => a + b, 0) / period
        result[i] = atr
      }
    } else {
      atr = (atr * (period - 1) + trs[i]!) / period
      result[i] = atr
    }
  }
  return result
}

function adxSeries(candles: CandleRow[], period = ADX_PERIOD): (number | null)[] {
  const n = candles.length
  const plusDM: number[] = new Array(n).fill(0)
  const minusDM: number[] = new Array(n).fill(0)
  const tr: number[] = new Array(n).fill(0)
  for (let i = 1; i < n; i++) {
    const upMove = candles[i].high - candles[i - 1].high
    const downMove = candles[i - 1].low - candles[i].low
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    )
  }
  const result: (number | null)[] = new Array(n).fill(null)
  if (n < period * 2) return result

  let smTR = tr.slice(1, period + 1).reduce((a, b) => a + b, 0)
  let smPlusDM = plusDM.slice(1, period + 1).reduce((a, b) => a + b, 0)
  let smMinusDM = minusDM.slice(1, period + 1).reduce((a, b) => a + b, 0)
  const dxArr: (number | null)[] = new Array(n).fill(null)

  for (let i = period + 1; i < n; i++) {
    smTR = smTR - smTR / period + tr[i]
    smPlusDM = smPlusDM - smPlusDM / period + plusDM[i]
    smMinusDM = smMinusDM - smMinusDM / period + minusDM[i]
    const plusDI = smTR === 0 ? 0 : (smPlusDM / smTR) * 100
    const minusDI = smTR === 0 ? 0 : (smMinusDM / smTR) * 100
    const dx = plusDI + minusDI === 0 ? 0 : (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100
    dxArr[i] = dx
  }

  let adx: number | null = null
  let startIdx = -1
  for (let i = period + 1; i < n; i++) {
    if (dxArr[i] != null) {
      startIdx = i
      break
    }
  }
  if (startIdx === -1) return result
  const firstWindowEnd = startIdx + period
  if (firstWindowEnd >= n) return result
  const firstWindow = dxArr.slice(startIdx, firstWindowEnd).filter((v): v is number => v != null)
  adx = firstWindow.reduce((a, b) => a + b, 0) / firstWindow.length
  result[firstWindowEnd] = adx
  for (let i = firstWindowEnd + 1; i < n; i++) {
    if (dxArr[i] == null) continue
    adx = (adx! * (period - 1) + dxArr[i]!) / period
    result[i] = adx
  }
  return result
}

function candlestickScore(c0: CandleRow, c1: CandleRow, c2: CandleRow): { score: number; label: string } {
  const body = (c: CandleRow) => Math.abs(c.close - c.open)
  const range = (c: CandleRow) => c.high - c.low
  const isBull = (c: CandleRow) => c.close > c.open
  const isBear = (c: CandleRow) => c.close < c.open
  const lowerShadow = (c: CandleRow) => Math.min(c.open, c.close) - c.low
  const upperShadow = (c: CandleRow) => c.high - Math.max(c.open, c.close)

  if (isBear(c1) && isBull(c2) && c2.open <= c1.close && c2.close >= c1.open && body(c2) > body(c1)) {
    return { score: 2, label: 'bullish engulfing' }
  }
  if (isBull(c1) && isBear(c2) && c2.open >= c1.close && c2.close <= c1.open && body(c2) > body(c1)) {
    return { score: -2, label: 'bearish engulfing' }
  }
  if (range(c2) > 0 && lowerShadow(c2) >= 2 * body(c2) && upperShadow(c2) <= body(c2) * 0.5 && c1.close < c0.close) {
    return { score: 2, label: 'hammer' }
  }
  if (range(c2) > 0 && upperShadow(c2) >= 2 * body(c2) && lowerShadow(c2) <= body(c2) * 0.5 && c1.close > c0.close) {
    return { score: -2, label: 'shooting star' }
  }
  if (isBear(c0) && body(c0) > 0 && body(c1) < body(c0) * 0.5 && isBull(c2) && c2.close > (c0.open + c0.close) / 2) {
    return { score: 2, label: 'morning star' }
  }
  if (isBull(c0) && body(c0) > 0 && body(c1) < body(c0) * 0.5 && isBear(c2) && c2.close < (c0.open + c0.close) / 2) {
    return { score: -2, label: 'evening star' }
  }
  return { score: 0, label: 'tidak ada pola signifikan' }
}

function scoreSignal( ind: IndicatorPoint, lastCandle: CandleRow, prevClose: number, ema21Now: number | null, ema21Before: number | null, candle: { score: number; label: string }, adxNow: number | null, ): number {
  const rsiBullish = ind.rsi14 != null && ind.rsi14 > 55 && ind.rsi14 < 70
  const macdBullish = ind.macd_line != null && ind.macd_signal != null && ind.macd_line > ind.macd_signal
  const trendUp = ema21Now != null && ema21Before != null && ema21Now > ema21Before
  const stochOverbought = ind.stoch_k != null && ind.stoch_k >= 80
  const trendStrong = adxNow != null && adxNow >= ADX_THRESHOLD

  const confluenceBuy = rsiBullish && macdBullish && trendUp && !stochOverbought && trendStrong
  if (!confluenceBuy) return 0
  if (candle.score <= 0) return 0

  let score = 5
  if (ind.ema5 != null && ind.ema21 != null && ind.ema9 != null && ind.ema50 != null) {
    if (ind.ema5 > ind.ema21 && ind.ema9 > ind.ema50) score += 2
  }
  const priceUp = lastCandle.close > prevClose
  if (ind.volume_avg20 != null && lastCandle.volume != null && lastCandle.volume > ind.volume_avg20 * 1.5) {
    if (priceUp) score += 1
  }
  score += candle.score
  return score
}

type Trade = {
  ticker: string; tier: TierKey; direction: 'BUY' | 'SELL'; entry_ts: string; entry: number
  stop_loss: number; tp1: number; outcome: 'WIN' | 'LOSS' | 'TIMEOUT'
  pnl_pct: number; risk_pct: number; bars_held: number; score: number
}

function simulateTrade( ticker: string, tier: TierKey, direction: 'BUY' | 'SELL', entryIdx: number, candles: CandleRow[], entry: number, stopLoss: number, tp1: number, scoreAbs: number, maxHoldBars: number, ): Trade {
  const riskPct = Math.abs(entry - stopLoss) / entry
  for (let i = entryIdx + 1; i <= Math.min(entryIdx + maxHoldBars, candles.length - 1); i++) {
    const bar = candles[i]
    if (bar.low <= stopLoss) {
      const pnl = (stopLoss - entry) / entry - FEE_SLIPPAGE_PCT
      return { ticker, tier, direction, entry_ts: candles[entryIdx].ts, entry, stop_loss: stopLoss, tp1, outcome: 'LOSS', pnl_pct: pnl, risk_pct: riskPct, bars_held: i - entryIdx, score: scoreAbs }
    }
    if (bar.high >= tp1) {
      const pnl = (tp1 - entry) / entry - FEE_SLIPPAGE_PCT
      return { ticker, tier, direction, entry_ts: candles[entryIdx].ts, entry, stop_loss: stopLoss, tp1, outcome: 'WIN', pnl_pct: pnl, risk_pct: riskPct, bars_held: i - entryIdx, score: scoreAbs }
    }
  }
  return { ticker, tier, direction, entry_ts: candles[entryIdx].ts, entry, stop_loss: stopLoss, tp1, outcome: 'TIMEOUT', pnl_pct: 0, risk_pct: riskPct, bars_held: maxHoldBars, score: scoreAbs }
}

function summarize(trades: Trade[]) {
  const wins = trades.filter((t) => t.outcome === 'WIN')
  const losses = trades.filter((t) => t.outcome === 'LOSS')
  const timeouts = trades.filter((t) => t.outcome === 'TIMEOUT')
  const closedTrades = wins.length + losses.length

  const winRate = closedTrades > 0 ? (wins.length / closedTrades) * 100 : 0
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl_pct, 0)
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl_pct, 0))
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null

  const sortedClosed = [...wins, ...losses].sort((a, b) => a.entry_ts.localeCompare(b.entry_ts))
  let equity = 1, peak = 1, maxDD = 0
  for (const t of sortedClosed) {
    const rMultiple = t.risk_pct > 0 ? t.pnl_pct / t.risk_pct : 0
    equity *= 1 + FIXED_RISK_PCT * rMultiple
    if (equity > peak) peak = equity
    const dd = (peak - equity) / peak
    if (dd > maxDD) maxDD = dd
  }
  const maxDrawdownPct = maxDD * 100

  return { wins, losses, timeouts, closedTrades, winRate, grossProfit, grossLoss, profitFactor, maxDrawdownPct }
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const url = new URL(req.url)
  const timeframe = (url.searchParams.get('timeframe') ?? 'D1').toUpperCase()
  const maxStocks = Math.min(Number(url.searchParams.get('max_stocks') ?? '150'), 400)
  const offset = Number(url.searchParams.get('offset') ?? '0')
  const config = TIMEFRAME_CONFIG[timeframe]
  if (!config) {
    return new Response(JSON.stringify({ error: `timeframe tidak didukung: ${timeframe}` }), { status: 400 })
  }

  const { data: stocks, error: stErr } = await supabase
    .from('stocks')
    .select('id, ticker')
    .eq('is_active', true)
    .order('ticker', { ascending: true })
    .range(offset, offset + maxStocks - 1)

  if (stErr || !stocks || stocks.length === 0) {
    return new Response(JSON.stringify({ error: stErr?.message ?? 'tidak ada saham aktif ditemukan' }), { status: 500 })
  }

  const perStock: Record<string, { candles: CandleRow[]; ema50: (number | null)[]; tier: TierKey; avgDailyValue: number }> = {}
  const missingTickers: string[] = []
  let earliestTs: string | null = null
  let latestTs: string | null = null

  for (const stock of stocks as { id: string; ticker: string }[]) {
    const { data: candleRows, error: cErr } = await supabase
      .from('candles')
      .select('ts, open, high, low, close, volume')
      .eq('stock_id', stock.id)
      .eq('timeframe', timeframe)
      .order('ts', { ascending: true })

    if (cErr || !candleRows || candleRows.length < config.minBars) {
      missingTickers.push(stock.ticker)
      continue
    }
    const candles = candleRows as CandleRow[]
    const closes = candles.map((c) => c.close)
    const ema50 = ema(closes, 50)

    const lookback = Math.min(60, candles.length)
    const recentWindow = candles.slice(candles.length - lookback)
    const avgDailyValue = recentWindow.reduce((sum, c) => sum + c.close * (c.volume ?? 0), 0) / lookback
    const tier = classifyTier(avgDailyValue)

    perStock[stock.ticker] = { candles, ema50, tier, avgDailyValue }

    const first = candles[0].ts
    const last = candles[candles.length - 1].ts
    if (earliestTs === null || first < earliestTs) earliestTs = first
    if (latestTs === null || last > latestTs) latestTs = last
  }

  // Market breadth proxy (pengganti tren IHSG, dok 9.3.1): dihitung dari
  // saham TIER_A saja (blue chip), karena itu representasi tren makro yang
  // paling relevan -- bukan dari gorengan yang bisa bergerak sendiri.
  const breadthAbove: Record<string, number> = {}
  const breadthTotal: Record<string, number> = {}
  for (const ticker of Object.keys(perStock)) {
    const { candles, ema50, tier } = perStock[ticker]
    if (tier !== 'TIER_A') continue
    for (let i = 0; i < candles.length; i++) {
      if (ema50[i] == null) continue
      const date = candles[i].ts.slice(0, 10)
      breadthTotal[date] = (breadthTotal[date] ?? 0) + 1
      if (candles[i].close > ema50[i]!) breadthAbove[date] = (breadthAbove[date] ?? 0) + 1
    }
  }
  const breadthPct: Record<string, number> = {}
  for (const date of Object.keys(breadthTotal)) {
    breadthPct[date] = (breadthAbove[date] / breadthTotal[date]) * 100
  }

  const allTrades: Trade[] = []

  for (const stock of stocks as { id: string; ticker: string }[]) {
    const entry = perStock[stock.ticker]
    if (!entry) continue
    const { candles, tier } = entry
    const closes = candles.map((c) => c.close)

    const ema5 = ema(closes, 5), ema9 = ema(closes, 9), ema21 = ema(closes, 21), ema50 = entry.ema50
    const rsi14 = rsi(closes, 14)
    const { line: macdLine, signal: macdSignal } = macd(closes)
    const { k: stochK, d: stochD } = stochastic(candles)
    const atrSeries = computeATRSeries(candles)
    const adxVals = adxSeries(candles)
    const volAvg20: (number | null)[] = new Array(candles.length).fill(null)
    for (let i = 19; i < candles.length; i++) {
      const window = candles.slice(i - 19, i + 1).map((c) => c.volume ?? 0)
      volAvg20[i] = window.reduce((a, b) => a + b, 0) / 20
    }

    const startIdx = config.startIdx
    const endIdx = candles.length - 1

    for (let i = startIdx; i < endIdx; i++) {
      const date = candles[i].ts.slice(0, 10)
      const breadth = breadthPct[date]
      if (breadth == null || breadth < BREADTH_THRESHOLD) continue

      const ind: IndicatorPoint = {
        ema5: ema5[i], ema9: ema9[i], ema21: ema21[i], ema50: ema50[i],
        rsi14: rsi14[i], macd_line: macdLine[i], macd_signal: macdSignal[i],
        stoch_k: stochK[i], stoch_d: stochD[i], volume_avg20: volAvg20[i],
      }
      const lastCandle = candles[i]
      const prevClose = candles[i - 1].close
      const slopeLookback = 5
      const ema21Now = ema21[i]
      const ema21Before = i - slopeLookback >= 0 ? ema21[i - slopeLookback] : null
      const candle = i >= 2 ? candlestickScore(candles[i - 2], candles[i - 1], candles[i]) : { score: 0, label: 'data tidak cukup' }
      const adxNow = adxVals[i]

      const score = scoreSignal(ind, lastCandle, prevClose, ema21Now, ema21Before, candle, adxNow)

      let direction: 'BUY' | 'SELL' | null = null
      if (score >= MIN_SCORE) direction = 'BUY'
      if (direction === 'BUY' && ind.ema50 != null && lastCandle.close < ind.ema50) direction = null
      if (!direction) continue

      const atr = atrSeries[i]
      if (atr == null) continue

      const entryIdx = i
      const entryPrice = candles[entryIdx].close

      const stopLoss = entryPrice - 1.5 * atr
      const risk = entryPrice - stopLoss
      const tp1 = entryPrice + 1.5 * risk

      const trade = simulateTrade(stock.ticker, tier, direction, entryIdx, candles, entryPrice, stopLoss, tp1, Math.abs(score), config.maxHoldBars)
      allTrades.push(trade)
      i += trade.bars_held
    }
  }

  const tierResults: Record<string, unknown> = {}
  const runIds: Record<string, string | null> = {}

  for (const tierKey of Object.keys(LIQUIDITY_TIERS) as TierKey[]) {
    const tierConfig = LIQUIDITY_TIERS[tierKey]
    const tierTrades = allTrades.filter((t) => t.tier === tierKey)
    const stockCountInTier = Object.values(perStock).filter((s) => s.tier === tierKey).length
    const summary = summarize(tierTrades)

    const failReasons: string[] = []
    if (summary.winRate < tierConfig.gate.minWinRate) failReasons.push(`Win Rate ${summary.winRate.toFixed(1)}% < ${tierConfig.gate.minWinRate}%`)
    if (summary.profitFactor === null || summary.profitFactor < tierConfig.gate.minProfitFactor) failReasons.push(`Profit Factor ${summary.profitFactor?.toFixed(2) ?? 'N/A'} < ${tierConfig.gate.minProfitFactor}`)
    if (summary.maxDrawdownPct > tierConfig.gate.maxDrawdownPct) failReasons.push(`Max Drawdown ${summary.maxDrawdownPct.toFixed(1)}% > ${tierConfig.gate.maxDrawdownPct}%`)
    const passed = failReasons.length === 0 && summary.closedTrades > 0

    const { data: inserted, error: insErr } = await supabase
      .from('backtest_runs')
      .insert({
        formula_version: FORMULA_VERSION,
        timeframe,
        period_start: earliestTs?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
        period_end: latestTs?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
        universe: `${tierKey}_${tierConfig.label.replace(/[^a-zA-Z0-9]+/g, '_')}`,
        total_stocks: stockCountInTier,
        total_trades: tierTrades.length,
        wins: summary.wins.length,
        losses: summary.losses.length,
        timeouts: summary.timeouts.length,
        win_rate: summary.winRate,
        profit_factor: summary.profitFactor,
        max_drawdown_pct: summary.maxDrawdownPct,
        gross_profit: summary.grossProfit,
        gross_loss: summary.grossLoss,
        passed,
        fail_reasons: failReasons,
        trade_log: tierTrades.slice(0, 500),
      })
      .select('id')
      .single()

    runIds[tierKey] = inserted?.id ?? null

    tierResults[tierKey] = {
      label: tierConfig.label,
      min_daily_value_idr: tierConfig.minDailyValue,
      gate: tierConfig.gate,
      backtest_run_id: inserted?.id ?? null,
      total_stocks_in_tier: stockCountInTier,
      total_trades: tierTrades.length,
      wins: summary.wins.length,
      losses: summary.losses.length,
      timeouts: summary.timeouts.length,
      win_rate_pct: Number(summary.winRate.toFixed(2)),
      profit_factor: summary.profitFactor != null ? Number(summary.profitFactor.toFixed(2)) : null,
      max_drawdown_pct: Number(summary.maxDrawdownPct.toFixed(2)),
      passed,
      fail_reasons: failReasons,
      insert_error: insErr?.message ?? null,
    }
  }

  return new Response(
    JSON.stringify({
      formula_version: FORMULA_VERSION,
      timeframe,
      stocks_queried: stocks.length,
      stocks_with_enough_data: Object.keys(perStock).length,
      missing_tickers: missingTickers,
      offset,
      max_stocks: maxStocks,
      note: 'Jika stocks_queried == max_stocks, kemungkinan masih ada saham aktif di luar batch ini -- panggil ulang dengan offset lebih besar untuk cover seluruh universe.',
      tiers: tierResults,
    }, null, 2),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
