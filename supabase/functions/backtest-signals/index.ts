import { createClient } from 'jsr:@supabase/supabase-js@2'

// Backtest Worker 2 (Generate Signal) sesuai dokumen 9.3.1:
// "threshold +5/-5 wajib divalidasi backtest 50 saham LQ45 periode 2024-2026;
//  lulus jika Win Rate >=55% (setelah fee&slippage), Profit Factor >=1.5,
//  Max Drawdown <=25% dalam 1 bulan."
//
// PENTING: logic scoring & formula Entry/SL/TP di file ini WAJIB identik
// dengan supabase/functions/generate-signals/index.ts.

const FORMULA_VERSION = 'baseline_v7'
const ATR_PERIOD = 14
const SUPPORT_RESISTANCE_LOOKBACK = 20
const MAX_HOLD_BARS = 20
const FEE_SLIPPAGE_PCT = 0.0025
const FIXED_RISK_PCT = 0.01

const LQ45_TICKERS = [
  'AADI','ADMR','ADRO','AKRA','AMMN','AMRT','ANTM','ASII','BBCA','BBNI',
  'BBRI','BBTN','BMRI','BRPT','BUMI','CPIN','CUAN','DEWA','EMTK','ESSA',
  'EXCL','GOTO','HRTA','ICBP','INCO','INDF','INDY','INKP','ISAT','ITMG',
  'JPFA','KLBF','MAPI','MBMA','MDKA','MEDC','NCKL','PGAS','PGEO','PTBA',
  'SCMA','TLKM','UNTR','UNVR','WIFI',
]

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

function scoreSignal(ind: IndicatorPoint, candles: CandleRow[], barIdx: number) {
  const lastCandle = candles[barIdx]
  const prevClose = candles[barIdx - 1].close

  const rsiBullish = ind.rsi14 != null && ind.rsi14 > 55 && ind.rsi14 < 70
  const rsiBearish = ind.rsi14 != null && ind.rsi14 < 45
  const macdBullish = ind.macd_line != null && ind.macd_signal != null && ind.macd_line > ind.macd_signal
  const macdBearish = ind.macd_line != null && ind.macd_signal != null && ind.macd_line < ind.macd_signal

  const closesUpToBar = candles.slice(0, barIdx + 1).map((c) => c.close)
  const ema21Series = ema(closesUpToBar, 21)
  const lastIdx = ema21Series.length - 1
  const slopeLookback = 5
  const ema21Now = ema21Series[lastIdx]
  const ema21Before = lastIdx - slopeLookback >= 0 ? ema21Series[lastIdx - slopeLookback] : null
  const trendUp = ema21Now != null && ema21Before != null && ema21Now > ema21Before
  const trendDown = ema21Now != null && ema21Before != null && ema21Now < ema21Before

  const stochOverbought = ind.stoch_k != null && ind.stoch_k >= 80
  const stochOversold = ind.stoch_k != null && ind.stoch_k <= 20

  const confluenceBuy = rsiBullish && macdBullish && trendUp && !stochOverbought
  const confluenceSell = rsiBearish && macdBearish && trendDown && !stochOversold
  if (!confluenceBuy && !confluenceSell) return 0

  let score = confluenceBuy ? 5 : -5

  if (ind.ema5 != null && ind.ema21 != null && ind.ema9 != null && ind.ema50 != null) {
    if (confluenceBuy && ind.ema5 > ind.ema21 && ind.ema9 > ind.ema50) score += 2
    else if (confluenceSell && ind.ema5 < ind.ema21 && ind.ema9 < ind.ema50) score -= 2
  }

  const priceUp = lastCandle.close > prevClose
  if (ind.volume_avg20 != null && lastCandle.volume != null && lastCandle.volume > ind.volume_avg20 * 1.5) {
    if (confluenceBuy && priceUp) score += 1
    else if (confluenceSell && !priceUp) score -= 1
  }

  return score
}

type Trade = {
  ticker: string
  direction: 'BUY' | 'SELL'
  entry_ts: string
  entry: number
  stop_loss: number
  tp1: number
  outcome: 'WIN' | 'LOSS' | 'TIMEOUT'
  pnl_pct: number
  risk_pct: number
  bars_held: number
  score: number
}

function simulateTrade(
  ticker: string,
  direction: 'BUY' | 'SELL',
  entryIdx: number,
  candles: CandleRow[],
  entry: number,
  stopLoss: number,
  tp1: number,
  scoreAbs: number,
): Trade {
  const riskPct = Math.abs(entry - stopLoss) / entry
  for (let i = entryIdx + 1; i <= Math.min(entryIdx + MAX_HOLD_BARS, candles.length - 1); i++) {
    const bar = candles[i]
    if (direction === 'BUY') {
      if (bar.low <= stopLoss) {
        const pnl = (stopLoss - entry) / entry - FEE_SLIPPAGE_PCT
        return { ticker, direction, entry_ts: candles[entryIdx].ts, entry, stop_loss: stopLoss, tp1, outcome: 'LOSS', pnl_pct: pnl, risk_pct: riskPct, bars_held: i - entryIdx, score: scoreAbs }
      }
      if (bar.high >= tp1) {
        const pnl = (tp1 - entry) / entry - FEE_SLIPPAGE_PCT
        return { ticker, direction, entry_ts: candles[entryIdx].ts, entry, stop_loss: stopLoss, tp1, outcome: 'WIN', pnl_pct: pnl, risk_pct: riskPct, bars_held: i - entryIdx, score: scoreAbs }
      }
    } else {
      if (bar.high >= stopLoss) {
        const pnl = (entry - stopLoss) / entry - FEE_SLIPPAGE_PCT
        return { ticker, direction, entry_ts: candles[entryIdx].ts, entry, stop_loss: stopLoss, tp1, outcome: 'LOSS', pnl_pct: pnl, risk_pct: riskPct, bars_held: i - entryIdx, score: scoreAbs }
      }
      if (bar.low <= tp1) {
        const pnl = (entry - tp1) / entry - FEE_SLIPPAGE_PCT
        return { ticker, direction, entry_ts: candles[entryIdx].ts, entry, stop_loss: stopLoss, tp1, outcome: 'WIN', pnl_pct: pnl, risk_pct: riskPct, bars_held: i - entryIdx, score: scoreAbs }
      }
    }
  }
  return { ticker, direction, entry_ts: candles[entryIdx].ts, entry, stop_loss: stopLoss, tp1, outcome: 'TIMEOUT', pnl_pct: 0, risk_pct: riskPct, bars_held: MAX_HOLD_BARS, score: scoreAbs }
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const url = new URL(req.url)
  const timeframe = (url.searchParams.get('timeframe') ?? 'D1').toUpperCase()
  if (timeframe !== 'D1') {
    return new Response(JSON.stringify({ error: 'backtest saat ini hanya mendukung D1' }), { status: 400 })
  }

  const { data: stocks, error: stErr } = await supabase
    .from('stocks')
    .select('id, ticker')
    .in('ticker', LQ45_TICKERS)

  if (stErr || !stocks || stocks.length === 0) {
    return new Response(JSON.stringify({ error: stErr?.message ?? 'saham LQ45 tidak ditemukan di tabel stocks' }), { status: 500 })
  }

  const allTrades: Trade[] = []
  const missingTickers: string[] = []
  let earliestTs: string | null = null
  let latestTs: string | null = null

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

    const first = candles[0].ts
    const last = candles[candles.length - 1].ts
    if (earliestTs === null || first < earliestTs) earliestTs = first
    if (latestTs === null || last > latestTs) latestTs = last

    const ema5 = ema(closes, 5), ema9 = ema(closes, 9), ema21 = ema(closes, 21), ema50 = ema(closes, 50)
    const rsi14 = rsi(closes, 14)
    const { line: macdLine, signal: macdSignal } = macd(closes)
    const { k: stochK, d: stochD } = stochastic(candles)
    const volAvg20: (number | null)[] = new Array(candles.length).fill(null)
    for (let i = 19; i < candles.length; i++) {
      const window = candles.slice(i - 19, i + 1).map((c) => c.volume ?? 0)
      volAvg20[i] = window.reduce((a, b) => a + b, 0) / 20
    }

    const startIdx = 60
    const endIdx = candles.length - 1

    for (let i = startIdx; i < endIdx; i++) {
      const ind: IndicatorPoint = {
        ema5: ema5[i], ema9: ema9[i], ema21: ema21[i], ema50: ema50[i],
        rsi14: rsi14[i], macd_line: macdLine[i], macd_signal: macdSignal[i],
        stoch_k: stochK[i], stoch_d: stochD[i], volume_avg20: volAvg20[i],
      }
      const lastCandle = candles[i]
      const score = scoreSignal(ind, candles, i)

      let direction: 'BUY' | 'SELL' | null = null
      if (score >= 5) direction = 'BUY'

      if (direction === 'BUY' && ind.ema50 != null && lastCandle.close < ind.ema50) direction = null

      if (!direction) continue

      const atrWindow = candles.slice(0, i + 1)
      const atr = computeATR(atrWindow)
      if (atr == null) continue

      const entryIdx = i
      const entry = candles[entryIdx].close

      let stopLoss: number, tp1: number
      if (direction === 'BUY') {
        stopLoss = entry - 2 * atr
        const risk = entry - stopLoss
        tp1 = entry + 2 * risk
      } else {
        stopLoss = entry + 2 * atr
        const risk = stopLoss - entry
        tp1 = entry - 2 * risk
      }

      const trade = simulateTrade(stock.ticker, direction, entryIdx, candles, entry, stopLoss, tp1, Math.abs(score))
      allTrades.push(trade)

      i += trade.bars_held
    }
  }

  const wins = allTrades.filter((t) => t.outcome === 'WIN')
  const losses = allTrades.filter((t) => t.outcome === 'LOSS')
  const timeouts = allTrades.filter((t) => t.outcome === 'TIMEOUT')
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

  const scoreBreakdown: Record<string, { trades: number; wins: number; losses: number; win_rate_pct: number }> = {}
  for (const t of [...wins, ...losses]) {
    const key = String(t.score)
    if (!scoreBreakdown[key]) scoreBreakdown[key] = { trades: 0, wins: 0, losses: 0, win_rate_pct: 0 }
    scoreBreakdown[key].trades++
    if (t.outcome === 'WIN') scoreBreakdown[key].wins++
    else scoreBreakdown[key].losses++
  }
  for (const key of Object.keys(scoreBreakdown)) {
    const b = scoreBreakdown[key]
    b.win_rate_pct = Number(((b.wins / b.trades) * 100).toFixed(1))
  }

  const failReasons: string[] = []
  if (winRate < 55) failReasons.push(`Win Rate ${winRate.toFixed(1)}% < 55%`)
  if (profitFactor === null || profitFactor < 1.5) failReasons.push(`Profit Factor ${profitFactor?.toFixed(2) ?? 'N/A'} < 1.5`)
  if (maxDrawdownPct > 25) failReasons.push(`Max Drawdown ${maxDrawdownPct.toFixed(1)}% > 25%`)
  const passed = failReasons.length === 0 && closedTrades > 0

  const { data: inserted, error: insErr } = await supabase
    .from('backtest_runs')
    .insert({
      formula_version: FORMULA_VERSION,
      timeframe: 'D1',
      period_start: earliestTs?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
      period_end: latestTs?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
      universe: 'LQ45',
      total_stocks: stocks.length - missingTickers.length,
      total_trades: allTrades.length,
      wins: wins.length,
      losses: losses.length,
      timeouts: timeouts.length,
      win_rate: winRate,
      profit_factor: profitFactor,
      max_drawdown_pct: maxDrawdownPct,
      gross_profit: grossProfit,
      gross_loss: grossLoss,
      passed,
      fail_reasons: failReasons,
      trade_log: allTrades.slice(0, 500),
    })
    .select('id')
    .single()

  if (insErr) {
    return new Response(JSON.stringify({ error: `gagal simpan backtest_runs: ${insErr.message}` }), { status: 500 })
  }

  return new Response(
    JSON.stringify({
      backtest_run_id: inserted.id,
      formula_version: FORMULA_VERSION,
      universe: 'LQ45',
      total_stocks_tested: stocks.length - missingTickers.length,
      missing_tickers: missingTickers,
      total_trades: allTrades.length,
      wins: wins.length,
      losses: losses.length,
      timeouts: timeouts.length,
      win_rate_pct: Number(winRate.toFixed(2)),
      profit_factor: profitFactor != null ? Number(profitFactor.toFixed(2)) : null,
      max_drawdown_pct: Number(maxDrawdownPct.toFixed(2)),
      passed,
      fail_reasons: failReasons,
      score_breakdown: scoreBreakdown,
    }, null, 2),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
