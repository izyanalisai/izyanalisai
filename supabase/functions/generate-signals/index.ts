import { createClient } from 'jsr:@supabase/supabase-js@2'

// Signal Engine -- Structural Confluence (dok "IzyAnalisAi Struktur v2", Agustus 2026)
// Win Rate / Confidence Score DIHAPUS TOTAL dari desain ini. Arah sinyal dibaca dari
// struktur harga (swing high-low + posisi terhadap EMA) di beberapa timeframe sekaligus,
// bukan dari skor gabungan indikator dengan threshold numerik / statistik backtest.
//
// Daily : H1 (entry & Stop Loss) -> H4 (confirm) -> D1 (bias & Target)
// Swing : D1 (entry & Stop Loss) -> W1 (bias & Target)
//
// Kalau timeframe-timeframe di satu tier TIDAK searah (atau salah satu strukturnya
// tidak jelas/data kurang), maka TIDAK ADA sinyal yang dibuat untuk saham & tier itu --
// bukan HOLD, bukan disimpan sebagai apapun.

const CONCURRENCY = 20
const FORMULA_VERSION = 'structural_v1'
const PIVOT_LEFT = 2
const PIVOT_RIGHT = 2
const CANDLE_LIMIT = 100
const MIN_CANDLES = 30
// Buffer kecil di luar level support/resistance struktural untuk SL, supaya tidak
// kena stop hunting persis di level. Ini BUKAN formula ATR generik -- levelnya tetap
// dari struktur harga, buffer cuma margin keamanan.
const SR_BUFFER_PCT = 0.003

type Candle = { ts: string; open: number; high: number; low: number; close: number; volume: number | null }
type Indicator = {
  ema5: number | null; ema9: number | null; ema21: number | null; ema50: number | null
  rsi14: number | null; macd_line: number | null; macd_signal: number | null
  stoch_k: number | null; stoch_d: number | null; volume_avg20: number | null
}
type Bias = 'bullish' | 'bearish'
type Tier = 'daily' | 'swing'

type TierConfig = { tier: Tier; entryTf: string; confirmTf: string | null; biasTf: string }
const TIERS: Record<Tier, TierConfig> = {
  daily: { tier: 'daily', entryTf: 'H1', confirmTf: 'H4', biasTf: 'D1' },
  swing: { tier: 'swing', entryTf: 'D1', confirmTf: null, biasTf: 'W1' },
}

type Structure = {
  bias: Bias | null
  lastClose: number
  nearestSupport: number
  nearestResistance: number
  nextSupportsDesc: number[] // urut dari yang terdekat di bawah harga -> makin jauh
  nextResistancesAsc: number[] // urut dari yang terdekat di atas harga -> makin jauh
}

function findPivots(candles: Candle[]) {
  const highs: { idx: number; price: number }[] = []
  const lows: { idx: number; price: number }[] = []
  for (let i = PIVOT_LEFT; i < candles.length - PIVOT_RIGHT; i++) {
    const windowH = candles.slice(i - PIVOT_LEFT, i + PIVOT_RIGHT + 1).map((c) => c.high)
    const windowL = candles.slice(i - PIVOT_LEFT, i + PIVOT_RIGHT + 1).map((c) => c.low)
    if (candles[i].high === Math.max(...windowH)) highs.push({ idx: i, price: candles[i].high })
    if (candles[i].low === Math.min(...windowL)) lows.push({ idx: i, price: candles[i].low })
  }
  return { highs, lows }
}

// Baca struktur satu timeframe: arah bias (bullish/bearish/null kalau tidak jelas)
// + level support/resistance terdekat dari harga sekarang di timeframe itu.
function readStructure(candles: Candle[], indicator: Indicator | null): Structure | null {
  if (candles.length < MIN_CANDLES || !indicator) return null
  const { highs, lows } = findPivots(candles)
  const lastClose = candles[candles.length - 1].close

  // Struktur swing: Higher-High & Higher-Low = bullish. Lower-High & Lower-Low = bearish.
  let swingBias: Bias | null = null
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price
    const lh = highs[highs.length - 1].price < highs[highs.length - 2].price
    const ll = lows[lows.length - 1].price < lows[lows.length - 2].price
    if (hh && hl) swingBias = 'bullish'
    else if (lh && ll) swingBias = 'bearish'
  }

  // Posisi harga terhadap EMA + urutan EMA21 vs EMA50.
  let emaBias: Bias | null = null
  if (indicator.ema21 != null && indicator.ema50 != null) {
    if (lastClose > indicator.ema21 && indicator.ema21 > indicator.ema50) emaBias = 'bullish'
    else if (lastClose < indicator.ema21 && indicator.ema21 < indicator.ema50) emaBias = 'bearish'
  }

  // Bias timeframe ini sendiri cuma valid kalau struktur swing DAN EMA sepakat.
  const bias: Bias | null = swingBias && emaBias && swingBias === emaBias ? swingBias : null

  const nextSupportsDesc = lows.map((l) => l.price).filter((p) => p < lastClose).sort((a, b) => b - a)
  const nextResistancesAsc = highs.map((h) => h.price).filter((p) => p > lastClose).sort((a, b) => a - b)
  const lookback = candles.slice(-20)

  return {
    bias,
    lastClose,
    nearestSupport: nextSupportsDesc[0] ?? Math.min(...lookback.map((c) => c.low)),
    nearestResistance: nextResistancesAsc[0] ?? Math.max(...lookback.map((c) => c.high)),
    nextSupportsDesc,
    nextResistancesAsc,
  }
}

function isSameWibDay(tsIso: string, now: Date): boolean {
  const wibOffsetMs = 7 * 60 * 60 * 1000
  const a = new Date(new Date(tsIso).getTime() + wibOffsetMs)
  const b = new Date(now.getTime() + wibOffsetMs)
  return a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
}

// Sinyal Daily expired 15:30 WIB di hari yang sama. Sinyal Swing expired 15:30 WIB
// keesokan harinya. Kalau generate dijalankan setelah 15:30 WIB, expiry Daily maju
// ke slot berikutnya supaya tidak langsung expired begitu dibuat.
function getExpiry(tier: Tier, now: Date): string {
  const wibOffsetMs = 7 * 60 * 60 * 1000
  const wibNow = new Date(now.getTime() + wibOffsetMs)
  const expiryWib = new Date(Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate(), 15, 30, 0))
  if (tier === 'swing') {
    expiryWib.setUTCDate(expiryWib.getUTCDate() + 1)
  } else if (wibNow.getUTCHours() > 15 || (wibNow.getUTCHours() === 15 && wibNow.getUTCMinutes() >= 30)) {
    expiryWib.setUTCDate(expiryWib.getUTCDate() + 1)
  }
  return new Date(expiryWib.getTime() - wibOffsetMs).toISOString()
}

async function fetchTf(supabase: ReturnType<typeof createClient>, stockId: string, tf: string, now: Date) {
  const [{ data: candlesDesc, error: cErr }, { data: indRow, error: iErr }] = await Promise.all([
    supabase.from('candles').select('ts, open, high, low, close, volume')
      .eq('stock_id', stockId).eq('timeframe', tf)
      .order('ts', { ascending: false }).limit(CANDLE_LIMIT),
    supabase.from('indicators').select('ema5, ema9, ema21, ema50, rsi14, macd_line, macd_signal, stoch_k, stoch_d, volume_avg20')
      .eq('stock_id', stockId).eq('timeframe', tf).maybeSingle(),
  ])
  if (cErr) throw cErr
  if (iErr) throw iErr
  let candles = ((candlesDesc ?? []) as Candle[]).slice().reverse()
  if ((tf === 'D1' || tf === 'W1') && candles.length > 0 && isSameWibDay(candles[candles.length - 1].ts, now)) {
    candles = candles.slice(0, -1)
  }
  return { candles, indicator: (indRow as Indicator | null) }
}

type StockRow = { id: string; ticker: string }

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const url = new URL(req.url)
  const tierParam = (url.searchParams.get('tier') ?? 'daily').toLowerCase()
  const offset = Number(url.searchParams.get('offset') ?? '0')
  const limit = Number(url.searchParams.get('limit') ?? '300')

  if (tierParam !== 'daily' && tierParam !== 'swing') {
    return new Response(JSON.stringify({ error: `tier tidak didukung: ${tierParam} (pakai daily atau swing)` }), { status: 400 })
  }
  const cfg = TIERS[tierParam as Tier]
  const now = new Date()

  const { data: stocks, error } = await supabase
    .from('stocks')
    .select('id, ticker')
    .eq('is_active', true)
    .order('ticker')
    .range(offset, offset + limit - 1)

  if (error || !stocks) {
    return new Response(JSON.stringify({ error: error?.message ?? 'no stocks' }), { status: 500 })
  }

  let totalBuy = 0, totalSell = 0, totalNoConfluence = 0, totalSkipped = 0, totalFailed = 0
  const debugSamples: Record<string, string> = {}

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = (stocks as StockRow[]).slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (s) => {
        const entry = await fetchTf(supabase, s.id, cfg.entryTf, now)
        const confirm = cfg.confirmTf ? await fetchTf(supabase, s.id, cfg.confirmTf, now) : null
        const bias = await fetchTf(supabase, s.id, cfg.biasTf, now)
        return { stock: s, entry, confirm, bias }
      }),
    )

    for (const r of results) {
      if (r.status !== 'fulfilled') {
        totalFailed++
        debugSamples[`error-${totalFailed}`] = String(r.reason)
        continue
      }
      const { stock, entry, confirm, bias } = r.value

      const structEntry = readStructure(entry.candles, entry.indicator)
      const structConfirm = confirm ? readStructure(confirm.candles, confirm.indicator) : null
      const structBias = readStructure(bias.candles, bias.indicator)

      if (!structEntry || !structBias || (cfg.confirmTf && !structConfirm)) {
        totalSkipped++
        continue
      }

      const biases = [structEntry.bias, structBias.bias, ...(structConfirm ? [structConfirm.bias] : [])]
      const allBullish = biases.every((b) => b === 'bullish')
      const allBearish = biases.every((b) => b === 'bearish')

      if (!allBullish && !allBearish) {
        totalNoConfluence++
        continue
      }

      // ============================================
      // [TAMBAHAN] CEK BERITA KATALIS DALAM 24 JAM
      // ============================================

      // Cari berita positif untuk saham ini dalam 24 jam terakhir
      const { data: catalystNews, error: newsErr } = await supabase
        .from('news')
        .select('summary, sentiment, source, published_at')
        .contains('mapped_tickers', [stock.ticker])
        .eq('sentiment', 'positive')
        .gte('published_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order('published_at', { ascending: false })
        .limit(1)

      let catalystEvidence = null
      if (catalystNews && catalystNews.length > 0) {
        catalystEvidence = {
          has_catalyst: true,
          summary: catalystNews[0].summary || catalystNews[0].title || '',
          source: catalystNews[0].source,
          published_at: catalystNews[0].published_at,
        }
      }

      // ============================================

      const direction: 'BUY' | 'SELL' = allBullish ? 'BUY' : 'SELL'
      const entryPrice = structEntry.lastClose

      let buyAreaLow: number, buyAreaHigh: number, stopLoss: number, tp1: number, tp2: number
      let tpSource: 'structural' | 'fallback_rr' = 'structural'

      if (direction === 'BUY') {
        buyAreaLow = structEntry.nearestSupport
        buyAreaHigh = entryPrice
        stopLoss = structEntry.nearestSupport * (1 - SR_BUFFER_PCT)
        const risk = entryPrice - stopLoss
        if (structBias.nextResistancesAsc.length >= 2) {
          tp1 = structBias.nextResistancesAsc[0]
          tp2 = structBias.nextResistancesAsc[1]
        } else if (structBias.nextResistancesAsc.length === 1) {
          tp1 = structBias.nextResistancesAsc[0]
          tp2 = entryPrice + 3 * risk
          tpSource = 'fallback_rr'
        } else {
          tp1 = entryPrice + 1.5 * risk
          tp2 = entryPrice + 3 * risk
          tpSource = 'fallback_rr'
        }
      } else {
        buyAreaLow = entryPrice
        buyAreaHigh = structEntry.nearestResistance
        stopLoss = structEntry.nearestResistance * (1 + SR_BUFFER_PCT)
        const risk = stopLoss - entryPrice
        if (structBias.nextSupportsDesc.length >= 2) {
          tp1 = structBias.nextSupportsDesc[0]
          tp2 = structBias.nextSupportsDesc[1]
        } else if (structBias.nextSupportsDesc.length === 1) {
          tp1 = structBias.nextSupportsDesc[0]
          tp2 = entryPrice - 3 * risk
          tpSource = 'fallback_rr'
        } else {
          tp1 = entryPrice - 1.5 * risk
          tp2 = entryPrice - 3 * risk
          tpSource = 'fallback_rr'
        }
      }

      const risk = Math.abs(entryPrice - stopLoss)
      const riskReward = risk > 0 ? Math.abs(tp1 - entryPrice) / risk : null

      const { data: oldActive } = await supabase
        .from('signals')
        .select('id')
        .eq('stock_id', stock.id)
        .eq('signal_tier', cfg.tier)
        .eq('status', 'ACTIVE')
        .is('superseded_by', null)

      const { data: inserted, error: insErr } = await supabase
        .from('signals')
        .insert({
          stock_id: stock.id,
          timeframe: cfg.entryTf,
          signal_tier: cfg.tier,
          entry_timeframe: cfg.entryTf,
          confirm_timeframe: cfg.confirmTf,
          bias_timeframe: cfg.biasTf,
          direction,
          entry_price: entryPrice,
          buy_area_low: buyAreaLow,
          buy_area_high: buyAreaHigh,
          tp1, tp2,
          stop_loss: stopLoss,
          initial_stop_loss: stopLoss,
          risk_reward: riskReward,
          support_level: structEntry.nearestSupport,
          resistance_level: structEntry.nearestResistance,
          status: 'ACTIVE',
          formula_version: FORMULA_VERSION,
          engine_version: 'v1',
          evidence: {
            model: 'structural_confluence',
            entry_timeframe: cfg.entryTf,
            confirm_timeframe: cfg.confirmTf,
            bias_timeframe: cfg.biasTf,
            direction_basis: 'swing_structure(HH-HL/LH-LL) + EMA21_vs_EMA50',
            tp_source: tpSource,
            catalyst: catalystEvidence, // <-- TAMBAHKAN INI
          },
          triggered_at: now.toISOString(),
          expires_at: getExpiry(cfg.tier, now),
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
          .in('id', oldActive.map((o: { id: string }) => o.id))
      }

      if (direction === 'BUY') totalBuy++
      else totalSell++
    }
  }

  return new Response(
    JSON.stringify({
      tier: cfg.tier,
      entry_timeframe: cfg.entryTf,
      confirm_timeframe: cfg.confirmTf,
      bias_timeframe: cfg.biasTf,
      offset, limit, total: stocks.length,
      formula_version: FORMULA_VERSION,
      buy: totalBuy, sell: totalSell,
      no_confluence: totalNoConfluence,
      skipped_insufficient_data: totalSkipped,
      failed: totalFailed,
      debug_samples: debugSamples,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
