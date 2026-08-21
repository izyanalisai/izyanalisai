import { createClient } from 'jsr:@supabase/supabase-js@2';
// Walk-forward historical backtest -- replicates generate-signals-mtf (structural_v2)
// bar-by-bar: pivot 2/2, zone cluster 1.2%, EMA21/50 bias, overextension gate.
// No look-ahead: EMA/pivots/zones recomputed from a rolling window ending at bar i only.
// Adds level_mode (SCALP/STANDARD/SWING) breakdown to match production classification
// (spec v5.0 7.4) since there is no separate scalp signal tier in production.

const PIVOT_LEFT = 2;
const PIVOT_RIGHT = 2;
const MIN_CANDLES = 30;
const SR_BUFFER_PCT = 0.003;
const ZONE_MERGE_TOLERANCE_PCT = 0.012;
const WINDOW_BARS = 100;
const OVEREXTENSION_MAX_PCT = { daily: 0.07, swing: 0.12 };
const MAX_HOLDING_BARS = { daily: 20, swing: 60 };

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = values[0];
  const out = [prev];
  for (let i = 1; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}
function findPivots(candles) {
  const highs = [], lows = [];
  for (let i = PIVOT_LEFT; i < candles.length - PIVOT_RIGHT; i++) {
    const wH = candles.slice(i - PIVOT_LEFT, i + PIVOT_RIGHT + 1).map((c) => c.high);
    const wL = candles.slice(i - PIVOT_LEFT, i + PIVOT_RIGHT + 1).map((c) => c.low);
    if (candles[i].high === Math.max(...wH)) highs.push({ idx: i, price: candles[i].high });
    if (candles[i].low === Math.min(...wL)) lows.push({ idx: i, price: candles[i].low });
  }
  return { highs, lows };
}
function buildZones(pivots, totalBars) {
  if (pivots.length === 0) return [];
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const mean = current.reduce((s, p) => s + p.price, 0) / current.length;
    if (Math.abs(sorted[i].price - mean) / mean <= ZONE_MERGE_TOLERANCE_PCT) current.push(sorted[i]);
    else { clusters.push(current); current = [sorted[i]]; }
  }
  clusters.push(current);
  return clusters.map((cluster) => {
    const prices = cluster.map((p) => p.price);
    const rawLow = Math.min(...prices), rawHigh = Math.max(...prices);
    const buffer = Math.max(rawHigh - rawLow, rawHigh * SR_BUFFER_PCT) / 2;
    const priceLow = rawLow - buffer, priceHigh = rawHigh + buffer;
    return { price_low: priceLow, price_high: priceHigh, mid_price: (priceLow + priceHigh) / 2, touch_count: cluster.length };
  });
}
function readStructure(windowCandles) {
  if (windowCandles.length < MIN_CANDLES) return null;
  const closes = windowCandles.map((c) => c.close);
  const ema21 = ema(closes, 21).at(-1);
  const ema50 = ema(closes, 50).at(-1);
  const { highs, lows } = findPivots(windowCandles);
  const lastClose = closes.at(-1);
  let swingBias = null;
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs.at(-1).price > highs.at(-2).price;
    const hl = lows.at(-1).price > lows.at(-2).price;
    const lh = highs.at(-1).price < highs.at(-2).price;
    const ll = lows.at(-1).price < lows.at(-2).price;
    if (hh && hl) swingBias = 'bullish'; else if (lh && ll) swingBias = 'bearish';
  }
  let emaBias = null;
  if (lastClose > ema21 && ema21 > ema50) emaBias = 'bullish';
  else if (lastClose < ema21 && ema21 < ema50) emaBias = 'bearish';
  const bias = swingBias && emaBias && swingBias === emaBias ? swingBias : null;
  return { bias, lastClose, supportZones: buildZones(lows, windowCandles.length), resistanceZones: buildZones(highs, windowCandles.length) };
}
function nearestBelow(zones, price) { const b = zones.filter((z) => z.price_low <= price); return b.length ? b.reduce((x, z) => z.price_high > x.price_high ? z : x) : null; }
function nearestAbove(zones, price) { const a = zones.filter((z) => z.price_high >= price); return a.length ? a.reduce((x, z) => z.price_low < x.price_low ? z : x) : null; }
function secondAbove(zones, first) { const c = zones.filter((z) => z.price_low > first.price_high); return c.length ? c.reduce((x, z) => z.price_low < x.price_low ? z : x) : null; }
function secondBelow(zones, first) { const c = zones.filter((z) => z.price_high < first.price_low); return c.length ? c.reduce((x, z) => z.price_high > x.price_high ? z : x) : null; }
function classifyOverextension(entryPrice, supportZone, tier) {
  if (!supportZone) return 'UNKNOWN';
  const d = (entryPrice - supportZone.price_high) / supportZone.price_high;
  if (d < 0) return 'NORMAL';
  return d > OVEREXTENSION_MAX_PCT[tier] ? 'OVEREXTENDED' : 'NORMAL';
}
function levelMode(tier, tp1Zone) {
  if (tier === 'swing') return 'SWING';
  return (tp1Zone && tp1Zone.touch_count >= 2) ? 'STANDARD' : 'SCALP';
}

function simulateOneStock(d1, w1, tier) {
  const trades = [];
  const startIdx = Math.max(MIN_CANDLES, 55);
  for (let i = startIdx; i < d1.length - 1; i++) {
    const windowD1 = d1.slice(Math.max(0, i - WINDOW_BARS + 1), i + 1);
    const structEntry = readStructure(windowD1);
    if (!structEntry) continue;
    let structBias = structEntry;
    if (tier === 'swing') {
      const asOfDate = d1[i].ts;
      const w1Window = w1.filter((c) => c.ts <= asOfDate).slice(-WINDOW_BARS);
      structBias = readStructure(w1Window);
      if (!structBias) continue;
    }
    const allBullish = structEntry.bias === 'bullish' && structBias.bias === 'bullish';
    const allBearish = structEntry.bias === 'bearish' && structBias.bias === 'bearish';
    if (!allBullish && !allBearish) continue;
    const direction = allBullish ? 'BUY' : 'SELL';
    const entryPrice = structEntry.lastClose;
    let stopLoss, tp1, tp2, mode;
    if (direction === 'BUY') {
      const supportZone = nearestBelow(structEntry.supportZones, entryPrice);
      const resZone = nearestAbove(structBias.resistanceZones, entryPrice);
      if (!supportZone || !resZone || resZone.mid_price <= entryPrice) continue;
      stopLoss = supportZone.price_low * (1 - SR_BUFFER_PCT);
      if (stopLoss >= entryPrice) continue;
      if (classifyOverextension(entryPrice, supportZone, tier) !== 'NORMAL') continue;
      tp1 = resZone.mid_price;
      const tp2Zone = secondAbove(structBias.resistanceZones, resZone);
      tp2 = tp2Zone ? tp2Zone.mid_price : null;
      mode = levelMode(tier, resZone);
    } else {
      const resZone = nearestAbove(structEntry.resistanceZones, entryPrice);
      const supZone = nearestBelow(structBias.supportZones, entryPrice);
      if (!resZone || !supZone || supZone.mid_price >= entryPrice) continue;
      stopLoss = resZone.price_high * (1 + SR_BUFFER_PCT);
      if (stopLoss <= entryPrice) continue;
      tp1 = supZone.mid_price;
      const tp2Zone = secondBelow(structBias.supportZones, supZone);
      tp2 = tp2Zone ? tp2Zone.mid_price : null;
      mode = levelMode(tier, supZone);
    }
    const maxBars = MAX_HOLDING_BARS[tier];
    let outcome = 'EXPIRED', exitPrice = null, hitTp1 = false;
    for (let j = i + 1; j <= Math.min(i + maxBars, d1.length - 1); j++) {
      const bar = d1[j];
      if (direction === 'BUY') {
        const slHit = bar.low <= stopLoss;
        const tp1Hit = bar.high >= tp1;
        if (slHit && !hitTp1) { outcome = 'HIT_SL'; exitPrice = stopLoss; break; }
        if (tp1Hit && !hitTp1) { hitTp1 = true; if (!tp2) { outcome = 'HIT_TP1'; exitPrice = tp1; break; } if (bar.high >= tp2) { outcome = 'HIT_TP2'; exitPrice = tp2; break; } continue; }
        if (hitTp1) { if (bar.low <= stopLoss) { outcome = 'HIT_TP1'; exitPrice = tp1; break; } if (bar.high >= tp2) { outcome = 'HIT_TP2'; exitPrice = tp2; break; } }
      } else {
        const slHit = bar.high >= stopLoss;
        const tp1Hit = bar.low <= tp1;
        if (slHit && !hitTp1) { outcome = 'HIT_SL'; exitPrice = stopLoss; break; }
        if (tp1Hit && !hitTp1) { hitTp1 = true; if (!tp2) { outcome = 'HIT_TP1'; exitPrice = tp1; break; } if (bar.low <= tp2) { outcome = 'HIT_TP2'; exitPrice = tp2; break; } continue; }
        if (hitTp1) { if (bar.high >= stopLoss) { outcome = 'HIT_TP1'; exitPrice = tp1; break; } if (bar.low <= tp2) { outcome = 'HIT_TP2'; exitPrice = tp2; break; } }
      }
    }
    if (outcome === 'EXPIRED' && hitTp1) { outcome = 'HIT_TP1'; exitPrice = tp1; }
    if (outcome === 'EXPIRED') exitPrice = d1[Math.min(i + maxBars, d1.length - 1)].close;
    const risk = Math.abs(entryPrice - stopLoss);
    const pnlR = risk > 0 ? (direction === 'BUY' ? (exitPrice - entryPrice) : (entryPrice - exitPrice)) / risk : 0;
    trades.push({ direction, outcome, pnl_r: pnlR, level_mode: mode });
  }
  return trades;
}

Deno.serve(async (req) => {
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const url = new URL(req.url);
  const tier = (url.searchParams.get('tier') ?? 'daily').toLowerCase();
  const offset = Number(url.searchParams.get('offset') ?? '0');
  const limit = Number(url.searchParams.get('limit') ?? '150');
  if (tier !== 'daily' && tier !== 'swing') return new Response(JSON.stringify({ error: 'tier must be daily or swing' }), { status: 400 });
  const { data: stocks, error: stErr } = await supabase.from('stocks').select('id, ticker').eq('is_active', true).order('ticker').range(offset, offset + limit - 1);
  if (stErr || !stocks) return new Response(JSON.stringify({ error: stErr?.message }), { status: 500 });

  let allTrades = [];
  let stocksWithData = 0;
  for (const s of stocks) {
    const { data: d1rows } = await supabase.from('candles').select('ts, open, high, low, close').eq('stock_id', s.id).eq('timeframe', 'D1').order('ts', { ascending: true });
    if (!d1rows || d1rows.length < 60) continue;
    let w1rows = [];
    if (tier === 'swing') {
      const { data: w1data } = await supabase.from('candles').select('ts, open, high, low, close').eq('stock_id', s.id).eq('timeframe', 'W1').order('ts', { ascending: true });
      w1rows = w1data ?? [];
      if (w1rows.length < 60) continue;
    }
    stocksWithData++;
    allTrades = allTrades.concat(simulateOneStock(d1rows, w1rows, tier));
  }

  function stats(trades) {
    const total = trades.length;
    const wins = trades.filter((t) => t.pnl_r > 0).length;
    const grossProfit = trades.filter((t) => t.pnl_r > 0).reduce((s, t) => s + t.pnl_r, 0);
    const grossLoss = Math.abs(trades.filter((t) => t.pnl_r <= 0).reduce((s, t) => s + t.pnl_r, 0));
    const avgR = total > 0 ? trades.reduce((s, t) => s + t.pnl_r, 0) / total : 0;
    let equity = 0, peak = 0, maxDD = 0;
    for (const t of trades) { equity += t.pnl_r; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity); }
    return {
      total_trades: total, wins, losses: total - wins,
      win_rate_pct: total > 0 ? Number((wins / total * 100).toFixed(2)) : null,
      profit_factor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(3)) : null,
      expected_value_r: Number(avgR.toFixed(4)), max_drawdown_r: Number(maxDD.toFixed(2)),
      outcome_breakdown: {
        HIT_TP2: trades.filter((t) => t.outcome === 'HIT_TP2').length,
        HIT_TP1: trades.filter((t) => t.outcome === 'HIT_TP1').length,
        HIT_SL: trades.filter((t) => t.outcome === 'HIT_SL').length,
        EXPIRED: trades.filter((t) => t.outcome === 'EXPIRED').length,
      },
    };
  }

  const byMode = {};
  for (const mode of ['SCALP', 'STANDARD', 'SWING']) {
    const subset = allTrades.filter((t) => t.level_mode === mode);
    if (subset.length > 0) byMode[mode] = stats(subset);
  }

  return new Response(JSON.stringify({
    tier, stocks_in_page: stocks.length, stocks_with_data: stocksWithData,
    overall: stats(allTrades), by_level_mode: byMode,
  }), { headers: { 'Content-Type': 'application/json' } });
});
