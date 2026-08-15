import { createClient } from 'jsr:@supabase/supabase-js@2'

// Signal Engine baseline sesuai dokumen 9.3.1:
// Score EMA(±2) + RSI(±2) + MACD(±2) + Stochastic(±1) + Volume(±1) + Candlestick(±2), total -10..+10.
// Threshold: >=+5 BUY, <=-5 SELL, di antaranya HOLD (HOLD tidak disimpan sebagai signal baru).
const CONCURRENCY = 20
const SUPPORT_RESISTANCE_LOOKBACK = 20
const ATR_PERIOD = 14
const FORMULA_VERSION = 'baseline_v8'

type StockRow = { id: string; ticker: string }
type CandleRow = { ts: string; open: number; high: number; low: number; close: number; volume: number | null }
type IndicatorRow = {
  ema5: number | null; ema9: number | null; ema21: number | null; ema50: number | null
  rsi14: number | null; macd_line: number | null; macd_signal: number | null
  stoch_k: number | null; stoch_d: number | null; volume_avg20: number | null
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

// EMA sederhana dari array close -- dipakai untuk cek SLOPE ema21 (naik/turun
// beberapa bar terakhir). Tabel `indicators` di produksi cuma nyimpen 1 baris
// snapshot terbaru per stock+timeframe (unique constraint), jadi slope tidak
// bisa didapat dari situ -- harus dihitung ulang dari 60 candle mentah yang
// sudah di-fetch. WAJIB identik dengan backtest-signals/index.ts.
function emaSeries(values: number[], period: number): (number | null)[] {
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

// Candlestick Pattern Scoring (dok 9.3.1: Candlestick ±2) -- sebelumnya TIDAK
// ADA di formula v7. Dipakai berdasarkan 3 candle terakhir yang sudah di-fetch
// (bukan permintaan tambahan ke provider). WAJIB identik dengan
// backtest-signals/index.ts supaya hasil backtest valid untuk formula ini.
function candlestickScore(candles: CandleRow[]): { score: number; label: string } {
  const n = candles.length
  if (n < 3) return { score: 0, label: 'data tidak cukup untuk pola candle' }
  const c0 = candles[n - 3], c1 = candles[n - 2], c2 = candles[n - 1]
  const body = (c: CandleRow) => Math.abs(c.close - c.open)
  const range = (c: CandleRow) => c.high - c.low
  const isBull = (c: CandleRow) => c.close > c.open
  const isBear = (c: CandleRow) => c.close < c.open
  const lowerShadow = (c: CandleRow) => Math.min(c.open, c.close) - c.low
  const upperShadow = (c: CandleRow) => c.high - Math.max(c.open, c.close)

  // Bullish Engulfing
  if (isBear(c1) && isBull(c2) && c2.open <= c1.close && c2.close >= c1.open && body(c2) > body(c1)) {
    return { score: 2, label: 'bullish engulfing' }
  }
  // Bearish Engulfing
  if (isBull(c1) && isBear(c2) && c2.open >= c1.close && c2.close <= c1.open && body(c2) > body(c1)) {
    return { score: -2, label: 'bearish engulfing' }
  }
  // Hammer (reversal bullish): shadow bawah >= 2x body, shadow atas kecil, muncul setelah turun
  if (range(c2) > 0 && lowerShadow(c2) >= 2 * body(c2) && upperShadow(c2) <= body(c2) * 0.5 && c1.close < c0.close) {
    return { score: 2, label: 'hammer' }
  }
  // Shooting Star (reversal bearish)
  if (range(c2) > 0 && upperShadow(c2) >= 2 * body(c2) && lowerShadow(c2) <= body(c2) * 0.5 && c1.close > c0.close) {
    return { score: -2, label: 'shooting star' }
  }
  // Morning Star (3 candle, reversal bullish)
  if (isBear(c0) && body(c0) > 0 && body(c1) < body(c0) * 0.5 && isBull(c2) && c2.close > (c0.open + c0.close) / 2) {
    return { score: 2, label: 'morning star' }
  }
  // Evening Star (3 candle, reversal bearish)
  if (isBull(c0) && body(c0) > 0 && body(c1) < body(c0) * 0.5 && isBear(c2) && c2.close < (c0.open + c0.close) / 2) {
    return { score: -2, label: 'evening star' }
  }
  return { score: 0, label: 'tidak ada pola signifikan' }
}

function scoreSignal(ind: IndicatorRow, candles: CandleRow[]) {
  // v8: sama seperti v7 (confluence RSI+MACD+trend EMA21 slope+Stochastic,
  // filter RSI/Stochastic overbought-oversold) DITAMBAH Candlestick Pattern
  // Scoring (±2) sesuai dok 9.3.1 yang sebelumnya belum diimplementasikan.
  //
  // CATATAN: v7 tidak lolos backtest gate (WR 32.2%, PF 0.96, MaxDD 38.5% --
  // audit 15 Agustus 2026). v8 WAJIB dibacktest ulang sebelum diaktifkan live
  // (lihat kolom is_approved di signal_engine_versions + gate check di bawah).
  let score = 0
  const evidence: Record<string, string> = {}
  const lastCandle = candles[candles.length - 1]
  const prevClose = candles[candles.length - 2].close

  const rsiBullish = ind.rsi14 != null && ind.rsi14 > 55 && ind.rsi14 < 70
  const rsiOverbought = ind.rsi14 != null && ind.rsi14 >= 70
  const rsiBearish = ind.rsi14 != null && ind.rsi14 < 45
  const macdBullish = ind.macd_line != null && ind.macd_signal != null && ind.macd_line > ind.macd_signal
  const macdBearish = ind.macd_line != null && ind.macd_signal != null && ind.macd_line < ind.macd_signal

  const closes = candles.map((c) => c.close)
  const ema21Series = emaSeries(closes, 21)
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

  if (rsiOverbought) evidence.rsi_filter = `ditolak -- RSI overbought (${ind.rsi14!.toFixed(1)})`
  if (!confluenceBuy && !confluenceSell) {
    evidence.confluence = 'tidak ada -- RSI/MACD/trend EMA21/Stochastic tidak semua searah'
    return { score: 0, evidence }
  }

  if (confluenceBuy) {
    score += 5
    evidence.rsi = `bullish (${ind.rsi14!.toFixed(1)})`
    evidence.macd = 'bullish crossover'
    evidence.trend = 'EMA21 naik (slope 5 bar positif)'
    evidence.stochastic = `tidak overbought (${ind.stoch_k?.toFixed(1) ?? 'N/A'})`
  } else {
    score -= 5
    evidence.rsi = `bearish (${ind.rsi14!.toFixed(1)})`
    evidence.macd = 'bearish crossover'
    evidence.trend = 'EMA21 turun (slope 5 bar negatif)'
    evidence.stochastic = `tidak oversold (${ind.stoch_k?.toFixed(1) ?? 'N/A'})`
  }

  if (ind.ema5 != null && ind.ema21 != null && ind.ema9 != null && ind.ema50 != null) {
    if (confluenceBuy && ind.ema5 > ind.ema21 && ind.ema9 > ind.ema50) { score += 2; evidence.ema = 'bullish alignment' }
    else if (confluenceSell && ind.ema5 < ind.ema21 && ind.ema9 < ind.ema50) { score -= 2; evidence.ema = 'bearish alignment' }
    else evidence.ema = 'neutral/tidak konfirmasi'
  }

  const priceUp = lastCandle.close > prevClose
  if (ind.volume_avg20 != null && lastCandle.volume != null && lastCandle.volume > ind.volume_avg20 * 1.5) {
    if (confluenceBuy && priceUp) { score += 1; evidence.volume = 'spike + naik' }
    else if (confluenceSell && !priceUp) { score -= 1; evidence.volume = 'spike + turun' }
    else evidence.volume = 'spike tidak konfirmasi arah'
  } else evidence.volume = 'normal'

  const candle = candlestickScore(candles)
  if (confluenceBuy && candle.score > 0) { score += candle.score; evidence.candlestick = candle.label }
  else if (confluenceSell && candle.score < 0) { score += candle.score; evidence.candlestick = candle.label }
  else evidence.candlestick = candle.label === 'tidak ada pola signifikan' ? candle.label : `${candle.label} (arah berlawanan, diabaikan)`

  return { score, evidence }
}

function isSameWibDay(tsIso: string, now: Date): boolean {
  const wibOffsetMs = 7 * 60 * 60 * 1000
  const a = new Date(new Date(tsIso).getTime() + wibOffsetMs)
  const b = new Date(now.getTime() + wibOffsetMs)
  return a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
}

function getExpiry(timeframe: string, now: Date): string {
  // Jam bursa BEI 2026 (SK Direksi II-A Kep-00003/BEI/04-2025):
  // Sesi 2 s.d. 15:49, pre-closing 15:50-16:00, post-closing 16:00-16:15.
  // Harga closing resmi baru final ~16:15 WIB.
  const wibOffsetMs = 7 * 60 * 60 * 1000
  const wibNow = new Date(now.getTime() + wibOffsetMs)
  const expiryWib = new Date(Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate(), 16, 15, 0))
  if (timeframe === 'D1' || timeframe === 'W1') {
    expiryWib.setUTCDate(expiryWib.getUTCDate() + 1)
  }
  return new Date(expiryWib.getTime() - wibOffsetMs).toISOString()
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

  // GATE CHECK (dok 1.6 / 9.3.1 / 20.6 / 20.10): formula_version hanya boleh
  // menghasilkan signal ACTIVE yang tampil ke user kalau sudah tercatat
  // is_approved=true di signal_engine_versions untuk timeframe ini. Kalau
  // belum pernah lolos backtest gate, signal TETAP dihitung (untuk keperluan
  // audit/evidence) tapi TIDAK di-insert sebagai ACTIVE -- mencegah kejadian
  // v7 yang lolos ke produksi tanpa pernah divalidasi.
  const { data: gateRow } = await supabase
    .from('signal_engine_versions')
    .select('id')
    .eq('formula_version', FORMULA_VERSION)
    .eq('timeframe', timeframe)
    .eq('is_approved', true)
    .maybeSingle()
  const gateApproved = !!gateRow

  const { data: stocks, error } = await supabase
    .from('stocks')
    .select('id, ticker')
    .eq('is_active', true)
    .order('ticker')
    .range(offset, offset + limit - 1)

  if (error || !stocks) {
    return new Response(JSON.stringify({ error: error?.message ?? 'no stocks' }), { status: 500 })
  }

  let totalBuy = 0, totalSell = 0, totalHold = 0, totalSkipped = 0, totalFailed = 0, totalBlockedUnapproved = 0
  const debugSamples: Record<string, string> = {}

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = (stocks as StockRow[]).slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (s) => {
        const [{ data: candlesDesc, error: cErr }, { data: indRows, error: iErr }] = await Promise.all([
          supabase.from('candles').select('ts, open, high, low, close, volume')
            .eq('stock_id', s.id).eq('timeframe', timeframe)
            .order('ts', { ascending: false }).limit(60),
          supabase.from('indicators').select('ema5, ema9, ema21, ema50, rsi14, macd_line, macd_signal, stoch_k, stoch_d, volume_avg20')
            .eq('stock_id', s.id).eq('timeframe', timeframe).maybeSingle(),
        ])
        if (cErr) throw cErr
        if (iErr) throw iErr
        const candles = ((candlesDesc ?? []) as CandleRow[]).slice().reverse()
        return { stock: s, candles, indicator: indRows as IndicatorRow | null }
      }),
    )

    for (const r of results) {
      if (r.status !== 'fulfilled') {
        totalFailed++
        debugSamples[`error-${totalFailed}`] = String(r.reason)
        continue
      }
      const { stock, candles, indicator } = r.value

      let usableCandles = candles
      if ((timeframe === 'D1' || timeframe === 'W1') && usableCandles.length > 0) {
        const last = usableCandles[usableCandles.length - 1]
        if (isSameWibDay(last.ts, new Date())) {
          usableCandles = usableCandles.slice(0, -1)
        }
      }

      // Minimal 26 candle: EMA21 butuh 21 candle + 5 bar lookback buat slope.
      if (!indicator || usableCandles.length < Math.max(ATR_PERIOD + 1, 26)) {
        totalSkipped++
        continue
      }

      const lastCandle = usableCandles[usableCandles.length - 1]
      const { score, evidence } = scoreSignal(indicator, usableCandles)

      let direction: 'BUY' | 'SELL' | null = null
      if (score >= 5) direction = 'BUY'

      if (direction === 'BUY' && indicator.ema50 != null && lastCandle.close < indicator.ema50) direction = null

      if (!direction) { totalHold++; continue }

      if (!gateApproved) { totalBlockedUnapproved++; continue }

      const atr = computeATR(usableCandles)
      if (atr == null) { totalSkipped++; continue }

      const recent = usableCandles.slice(-SUPPORT_RESISTANCE_LOOKBACK)
      const support = Math.min(...recent.map((c) => c.low))
      const resistance = Math.max(...recent.map((c) => c.high))
      const entry = lastCandle.close

      let buyAreaLow: number, buyAreaHigh: number, stopLoss: number, tp1: number, tp2: number

      if (direction === 'BUY') {
        buyAreaLow = support
        buyAreaHigh = entry
        stopLoss = entry - 2 * atr
        const risk = entry - stopLoss
        tp1 = entry + 2 * risk
        tp2 = entry + 4 * risk
      } else {
        buyAreaLow = entry
        buyAreaHigh = resistance
        stopLoss = entry + 2 * atr
        const risk = stopLoss - entry
        tp1 = entry - 2 * risk
        tp2 = entry - 4 * risk
      }

      const confidence = Math.min(95, 50 + Math.abs(score) * 5)

      const { data: oldActive } = await supabase
        .from('signals')
        .select('id')
        .eq('stock_id', stock.id)
        .eq('timeframe', timeframe)
        .eq('status', 'ACTIVE')
        .is('superseded_by', null)

      const { data: inserted, error: insErr } = await supabase
        .from('signals')
        .insert({
          stock_id: stock.id,
          timeframe,
          direction,
          entry_price: entry,
          buy_area_low: buyAreaLow,
          buy_area_high: buyAreaHigh,
          tp1, tp2,
          stop_loss: stopLoss,
          risk_reward: 2,
          confidence_score: confidence,
          status: 'ACTIVE',
          support_level: support,
          resistance_level: resistance,
          formula_version: FORMULA_VERSION,
          engine_version: 'v1',
          evidence: { score, ...evidence },
          triggered_at: new Date().toISOString(),
          expires_at: getExpiry(timeframe, new Date()),
        })
        .select('id')
        .single()

      if (insErr || !inserted) {
        totalFailed++
        debugSamples[stock.ticker] = String(insErr?.message)
        continue
      }

      if (oldActive && oldActive.length > 0) {
        await supabase
          .from('signals')
          .update({ status: 'INVALIDATED', superseded_by: inserted.id })
          .in('id', oldActive.map((o) => o.id))
      }

      if (direction === 'BUY') totalBuy++
      else totalSell++
    }
  }

  return new Response(
    JSON.stringify({
      timeframe, offset, limit, total: stocks.length,
      formula_version: FORMULA_VERSION,
      gate_approved: gateApproved,
      buy: totalBuy, sell: totalSell, hold_no_signal: totalHold,
      skipped_insufficient_data: totalSkipped, failed: totalFailed,
      blocked_unapproved_formula: totalBlockedUnapproved,
      debug_samples: debugSamples,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
