import { createClient } from 'jsr:@supabase/supabase-js@2'

// Signal Engine baseline sesuai dokumen 9.3.1:
// Score EMA(±2) + RSI(±2) + MACD(±2) + Stochastic(±1) + Volume(±1) + Candlestick(±2), total -10..+10.
// Threshold: >=+5 BUY, <=-5 SELL, di antaranya HOLD (HOLD tidak disimpan sebagai signal baru).
const CONCURRENCY = 20
const SUPPORT_RESISTANCE_LOOKBACK = 20
const ATR_PERIOD = 14

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

function scoreSignal(ind: IndicatorRow, candles: CandleRow[]) {
  // v7: confluence RSI+MACD (v5) DITAMBAH 3 filter ketat baru, dirancang buat
  // naikin Win Rate dari v6 (33.5%, cuma breakeven di R:R 1:2) -- v6 lolos
  // masuk sinyal tiap kali RSI & MACD searah, TANPA peduli entry-nya udah
  // "telat"/exhausted atau trend-nya beneran nge-gas. v7 nolak 3 kondisi itu:
  //   1. RSI overbought (>70) -- biasanya udah mau retrace, bukan awal tren.
  //   2. EMA21 FLAT/TURUN -- confluence RSI+MACD bisa muncul di sideways/
  //      choppy market, bukan cuma di uptrend beneran. v6 cuma cek ema5>21
  //      (alignment sesaat), bukan slope (tren bergerak beberapa bar).
  //   3. Stochastic overbought (>80) -- entry di puncak jangka pendek, rawan
  //      kena stop out random sebelum sempat lanjut naik.
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
  const wibOffsetMs = 7 * 60 * 60 * 1000
  const wibNow = new Date(now.getTime() + wibOffsetMs)
  const expiryWib = new Date(Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate(), 15, 30, 0))
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

  const { data: stocks, error } = await supabase
    .from('stocks')
    .select('id, ticker')
    .eq('is_active', true)
    .order('ticker')
    .range(offset, offset + limit - 1)

  if (error || !stocks) {
    return new Response(JSON.stringify({ error: error?.message ?? 'no stocks' }), { status: 500 })
  }

  let totalBuy = 0, totalSell = 0, totalHold = 0, totalSkipped = 0, totalFailed = 0
  const debugSamples: Record<string, string> = {}

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = (stocks as StockRow[]).slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (s) => {
        const [{ data: candlesDesc, error: cErr }, { data: indRows, error: iErr }] = await Promise.all([
          // Ambil 60 candle TERBARU: order descending + limit, baru di-reverse jadi
          // ascending. Sebelumnya order ascending + limit(60) malah mengambil 60
          // candle TERLAMA sejak data pertama masuk, jadi sinyal tidak pernah
          // memakai harga terkini begitu histori > 60 hari.
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

      // Untuk D1/W1, candle terakhir bisa masih "live" (hari/minggu berjalan,
      // belum closed) dan closenya berubah tiap kali fetch-candles jalan ulang.
      // Basis entry harus dari candle yang sudah final, biar TP/SL yang sudah
      // di-generate tidak jadi basi begitu candle live ke-upsert dengan harga baru.
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
      // SELL dimatikan sementara (baseline_v3): diagnostik per-indikator
      // menunjukkan semua sinyal bearish konsisten PF < 1.
      // else if (score <= -5) direction = 'SELL'

      // Filter tren: BUY hanya kalau harga di atas EMA50 (uptrend).
      if (direction === 'BUY' && indicator.ema50 != null && lastCandle.close < indicator.ema50) direction = null

      if (!direction) { totalHold++; continue }

      const atr = computeATR(usableCandles)
      if (atr == null) { totalSkipped++; continue }

      const recent = usableCandles.slice(-SUPPORT_RESISTANCE_LOOKBACK)
      const support = Math.min(...recent.map((c) => c.low))
      const resistance = Math.max(...recent.map((c) => c.high))
      const entry = lastCandle.close

      let buyAreaLow: number, buyAreaHigh: number, stopLoss: number, tp1: number, tp2: number

      // SL/TP dilebarin (v6): SL 1.5xATR & TP1 1.5R konsisten breakeven ~40%
      // win rate di semua formula_version sebelumnya -- indikasi jarak SL/TP
      // kekecilan dibanding noise harian saham IDX, kena stop out random
      // sebelum tren "beneran" kebentuk.
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
          risk_reward: 1.5,
          confidence_score: confidence,
          status: 'ACTIVE',
          support_level: support,
          resistance_level: resistance,
          formula_version: 'baseline_v7',
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
      buy: totalBuy, sell: totalSell, hold_no_signal: totalHold,
      skipped_insufficient_data: totalSkipped, failed: totalFailed,
      debug_samples: debugSamples,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
