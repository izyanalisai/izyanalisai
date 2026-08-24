import { createClient } from 'jsr:@supabase/supabase-js@2';
// run-golden-tests: dry-run engine structural_v2 terhadap snapshot candle beku
// (tidak pernah menyentuh tabel signals/structure_zones produksi).
// Logic pivot/zone/trigger/overextension di-port VERBATIM dari generate-signals-mtf
// v58 (23 Agustus 2026) supaya golden test benar-benar menguji logic yang sama
// dengan yang jalan di cron produksi -- bukan reimplementasi yang bisa drift.
//
// Mode:
//  - "seed": hitung output dari input_snapshot, simpan sebagai expected_* (baseline).
//  - "verify": hitung ulang, bandingkan ke expected_*, simpan status PASS/FAIL.
//
// FIX (24 Agustus 2026, audit menyeluruh): status yang ditulis function ini
// ('ACTIVE' saat seed, 'PASS'/'FAIL' saat verify) TIDAK ADA di
// golden_test_cases_status_check (cuma izinkan NOT_POPULATED/READY/PASSING/FAILING).
// Akibatnya SETIAP UPDATE gagal (constraint violation) sejak function ini dibuat --
// expected_signal tidak pernah benar-benar tersimpan walau response selalu 200 OK
// (errornya cuma nongol di field `error` per-case dalam JSON response, gampang
// kelewat kalau cuma cek status code). Fix: pakai READY (seed) / PASSING & FAILING
// (verify), sesuai daftar yang diizinkan constraint.
const PIVOT_LEFT = 2;
const PIVOT_RIGHT = 2;
const MIN_CANDLES = 30;
const SR_BUFFER_PCT = 0.003;
const ZONE_MERGE_TOLERANCE_PCT = 0.012;
const RETEST_TOLERANCE_PCT = 0.01;
const BREAKOUT_LOOKBACK_BARS = 8;
const OVEREXTENSION_MAX_PCT = {
  daily: 0.07,
  swing: 0.12
};
function computeLevelMode(tier, tp1Zone) {
  if (tier === 'swing') return 'SWING';
  if (tp1Zone && tp1Zone.touch_count >= 2) return 'STANDARD';
  return 'SCALP';
}
function findPivots(candles) {
  const highs = [];
  const lows = [];
  for(let i = PIVOT_LEFT; i < candles.length - PIVOT_RIGHT; i++){
    const windowH = candles.slice(i - PIVOT_LEFT, i + PIVOT_RIGHT + 1).map((c)=>c.high);
    const windowL = candles.slice(i - PIVOT_LEFT, i + PIVOT_RIGHT + 1).map((c)=>c.low);
    if (candles[i].high === Math.max(...windowH)) highs.push({
      idx: i,
      price: candles[i].high,
      candleId: candles[i].id ?? i
    });
    if (candles[i].low === Math.min(...windowL)) lows.push({
      idx: i,
      price: candles[i].low,
      candleId: candles[i].id ?? i
    });
  }
  return {
    highs,
    lows
  };
}
function buildZones(pivots, zoneType, timeframe, totalBars) {
  if (pivots.length === 0) return [];
  const sorted = [
    ...pivots
  ].sort((a, b)=>a.price - b.price);
  const clusters = [];
  let current = [
    sorted[0]
  ];
  for(let i = 1; i < sorted.length; i++){
    const clusterMean = current.reduce((s, p)=>s + p.price, 0) / current.length;
    if (Math.abs(sorted[i].price - clusterMean) / clusterMean <= ZONE_MERGE_TOLERANCE_PCT) {
      current.push(sorted[i]);
    } else {
      clusters.push(current);
      current = [
        sorted[i]
      ];
    }
  }
  clusters.push(current);
  return clusters.map((cluster)=>{
    const prices = cluster.map((p)=>p.price);
    const rawLow = Math.min(...prices);
    const rawHigh = Math.max(...prices);
    const buffer = Math.max(rawHigh - rawLow, rawHigh * SR_BUFFER_PCT) / 2;
    const priceLow = rawLow - buffer;
    const priceHigh = rawHigh + buffer;
    const touchCount = cluster.length;
    const retestCount = Math.max(0, touchCount - 1);
    const oldestIdx = Math.min(...cluster.map((p)=>p.idx));
    const ageInBars = Math.max(0, totalBars - 1 - oldestIdx);
    const strengthScore = touchCount * 2 + retestCount * 3 + Math.min(ageInBars, 50) / 10;
    const strength = strengthScore >= 8 ? 'STRONG' : strengthScore >= 4 ? 'MODERATE' : 'WEAK';
    return {
      zone_type: zoneType,
      timeframe,
      price_low: priceLow,
      price_high: priceHigh,
      mid_price: (priceLow + priceHigh) / 2,
      touch_count: touchCount,
      retest_count: retestCount,
      strength_score: Number(strengthScore.toFixed(2)),
      strength,
      age_in_bars: ageInBars
    };
  });
}
function readStructure(candles, indicator, timeframe) {
  if (!candles || candles.length < MIN_CANDLES || !indicator) return null;
  const { highs, lows } = findPivots(candles);
  const lastClose = candles[candles.length - 1].close;
  let swingBias = null;
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
    const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
    const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;
    if (hh && hl) swingBias = 'bullish';
    else if (lh && ll) swingBias = 'bearish';
  }
  let emaBias = null;
  if (indicator.ema21 != null && indicator.ema50 != null) {
    if (lastClose > indicator.ema21 && indicator.ema21 > indicator.ema50) emaBias = 'bullish';
    else if (lastClose < indicator.ema21 && indicator.ema21 < indicator.ema50) emaBias = 'bearish';
  }
  const bias = swingBias && emaBias && swingBias === emaBias ? swingBias : null;
  return {
    bias,
    lastClose,
    supportZones: buildZones(lows, 'SUPPORT', timeframe, candles.length),
    resistanceZones: buildZones(highs, 'RESISTANCE', timeframe, candles.length)
  };
}
function nearestZoneBelow(zones, price) {
  const below = zones.filter((z)=>z.price_low <= price);
  if (below.length === 0) return null;
  return below.reduce((best, z)=>z.price_high > best.price_high ? z : best);
}
function nearestZoneAbove(zones, price) {
  const above = zones.filter((z)=>z.price_high >= price);
  if (above.length === 0) return null;
  return above.reduce((best, z)=>z.price_low < best.price_low ? z : best);
}
function secondZoneAbove(zones, first) {
  const c = zones.filter((z)=>z.price_low > first.price_high);
  if (c.length === 0) return null;
  return c.reduce((best, z)=>z.price_low < best.price_low ? z : best);
}
function secondZoneBelow(zones, first) {
  const c = zones.filter((z)=>z.price_high < first.price_low);
  if (c.length === 0) return null;
  return c.reduce((best, z)=>z.price_high > best.price_high ? z : best);
}
function classifyTrigger(candles, zone, kind) {
  const window = candles.slice(-BREAKOUT_LOOKBACK_BARS);
  if (window.length === 0) return null;
  const last = window[window.length - 1];
  if (kind === 'BREAKOUT') {
    const breakoutIdx = window.findIndex((c)=>c.close > zone.price_high);
    if (breakoutIdx === -1) {
      if (last.high >= zone.price_low && last.close <= zone.price_high) {
        const distToEdge = (zone.price_high - last.close) / zone.price_high;
        return distToEdge <= RETEST_TOLERANCE_PCT ? 'BREAKOUT_CANDIDATE' : 'INTRABAR_TOUCH';
      }
      return null;
    }
    const after = window.slice(breakoutIdx + 1);
    const dippedBackIn = after.some((c)=>c.low <= zone.price_high && c.low >= zone.price_low);
    if (last.close <= zone.price_low) return 'FAILED_BREAKOUT';
    if (dippedBackIn && last.close > zone.price_high) return 'BREAKOUT_RETEST';
    return 'BREAKOUT_CONFIRMED';
  } else {
    const breakdownIdx = window.findIndex((c)=>c.close < zone.price_low);
    if (breakdownIdx === -1) {
      if (last.low <= zone.price_high && last.close >= zone.price_low) {
        const distToEdge = (last.close - zone.price_low) / zone.price_low;
        return distToEdge <= RETEST_TOLERANCE_PCT ? 'BREAKDOWN_CANDIDATE' : 'INTRABAR_TOUCH';
      }
      return null;
    }
    const after = window.slice(breakdownIdx + 1);
    const poppedBackIn = after.some((c)=>c.high >= zone.price_low && c.high <= zone.price_high);
    if (last.close >= zone.price_high) return 'FAILED_BREAKDOWN';
    if (poppedBackIn && last.close < zone.price_low) return 'BREAKDOWN_RETEST';
    return 'BREAKDOWN_CONFIRMED';
  }
}
function classifyOverextension(entryPrice, supportZone, tier) {
  if (!supportZone) return {
    status: 'UNKNOWN',
    distancePct: null
  };
  const distancePct = (entryPrice - supportZone.price_high) / supportZone.price_high;
  if (distancePct < 0) return {
    status: 'NORMAL',
    distancePct
  };
  return {
    status: distancePct > OVEREXTENSION_MAX_PCT[tier] ? 'OVEREXTENDED' : 'NORMAL',
    distancePct
  };
}
function isSameWibDay(tsIso, now) {
  const wibOffsetMs = 7 * 60 * 60 * 1000;
  const a = new Date(new Date(tsIso).getTime() + wibOffsetMs);
  const b = new Date(now.getTime() + wibOffsetMs);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}
function prepCandles(rawCandles, tf, now) {
  let candles = (rawCandles ?? []).slice();
  if ((tf === 'D1' || tf === 'W1') && candles.length > 0 && isSameWibDay(candles[candles.length - 1].ts, now)) {
    candles = candles.slice(0, -1);
  }
  return candles;
}
// Port keputusan BUY/SELL dari body Deno.serve() generate-signals-mtf (inline loop),
// diekstrak jadi pure function murni structural (tanpa DB write / zone persistence id).
function computeSignal(tier, entryPrice, structEntry, structBias, entryCandles) {
  if (!structEntry || !structBias) return {
    no_signal: true,
    reason: 'insufficient_data'
  };
  const biases = [
    structEntry.bias,
    structBias.bias
  ];
  const allBullish = biases.every((b)=>b === 'bullish');
  const allBearish = biases.every((b)=>b === 'bearish');
  if (!allBullish && !allBearish) return {
    no_signal: true,
    reason: 'no_timeframe_confluence',
    biases
  };
  const direction = allBullish ? 'BUY' : 'SELL';
  if (direction === 'BUY') {
    const supportZone = nearestZoneBelow(structEntry.supportZones, entryPrice);
    const resistanceZoneTp1 = nearestZoneAbove(structBias.resistanceZones, entryPrice);
    if (!supportZone) return {
      no_signal: true,
      reason: 'no_valid_support_zone',
      direction
    };
    if (!resistanceZoneTp1 || resistanceZoneTp1.mid_price <= entryPrice) return {
      no_signal: true,
      reason: 'no_valid_resistance_zone_for_tp1',
      direction
    };
    const stopLoss = supportZone.price_low * (1 - SR_BUFFER_PCT);
    if (stopLoss >= entryPrice) return {
      no_signal: true,
      reason: 'invalid_stop_loss',
      direction
    };
    const overext = classifyOverextension(entryPrice, supportZone, tier);
    if (overext.status !== 'NORMAL') return {
      no_signal: true,
      reason: overext.status === 'OVEREXTENDED' ? 'overextended' : 'unknown_overextension',
      direction,
      distance_pct: overext.distancePct
    };
    const tp1 = resistanceZoneTp1.mid_price;
    const tp2Zone = secondZoneAbove(structBias.resistanceZones, resistanceZoneTp1);
    const tp2 = tp2Zone?.mid_price ?? null;
    const triggerState = classifyTrigger(entryCandles, supportZone, 'BREAKOUT');
    const withinSupportZone = entryPrice >= supportZone.price_low && entryPrice <= supportZone.price_high * (1 + RETEST_TOLERANCE_PCT);
    const entryType = withinSupportZone ? 'SUPPORT' : triggerState === 'BREAKOUT_RETEST' ? 'RETEST' : triggerState === 'BREAKOUT_CANDIDATE' ? 'TRIGGER' : 'AREA';
    const levelMode = computeLevelMode(tier, resistanceZoneTp1);
    return {
      no_signal: false,
      direction,
      entry_price: entryPrice,
      buy_area_low: supportZone.price_low,
      buy_area_high: entryPrice,
      tp1,
      tp2,
      tp2_reason: tp2Zone ? null : 'NO_VALID_SECOND_RESISTANCE',
      stop_loss: stopLoss,
      level_mode: levelMode,
      support_level: supportZone.mid_price,
      resistance_level: resistanceZoneTp1.mid_price,
      entry_type: entryType,
      trigger_state: triggerState,
      overextension_status: overext.status
    };
  } else {
    const resistanceZone = nearestZoneAbove(structEntry.resistanceZones, entryPrice);
    const supportZoneTp1 = nearestZoneBelow(structBias.supportZones, entryPrice);
    if (!resistanceZone) return {
      no_signal: true,
      reason: 'no_valid_resistance_zone',
      direction
    };
    if (!supportZoneTp1 || supportZoneTp1.mid_price >= entryPrice) return {
      no_signal: true,
      reason: 'no_valid_support_zone_for_target',
      direction
    };
    const invalidation = resistanceZone.price_high * (1 + SR_BUFFER_PCT);
    if (invalidation <= entryPrice) return {
      no_signal: true,
      reason: 'invalid_invalidation_level',
      direction
    };
    const downsideSupport1 = supportZoneTp1.mid_price;
    const support2Zone = secondZoneBelow(structBias.supportZones, supportZoneTp1);
    const downsideSupport2 = support2Zone?.mid_price ?? null;
    const brokenSupportZone = structEntry.supportZones.filter((z)=>z.price_low > entryPrice).reduce((best, z)=>!best || z.price_low < best.price_low ? z : best, null);
    const breakdownState = brokenSupportZone ? classifyTrigger(entryCandles, brokenSupportZone, 'BREAKDOWN') : null;
    const resistanceTriggerState = classifyTrigger(entryCandles, resistanceZone, 'BREAKOUT');
    const lastCandle = entryCandles[entryCandles.length - 1];
    const vol20 = null; // volume_avg20 tidak dipakai untuk klasifikasi utama kecuali DISTRIBUTION_INDICATION
    let bearishType;
    if (breakdownState === 'BREAKDOWN_CONFIRMED' || breakdownState === 'BREAKDOWN_RETEST') bearishType = 'BEARISH_BREAKDOWN';
    else if (resistanceTriggerState === 'FAILED_BREAKOUT') bearishType = 'BEARISH_REJECTION';
    else bearishType = 'BEARISH_CONTINUATION';
    const levelMode = computeLevelMode(tier, supportZoneTp1);
    return {
      no_signal: false,
      direction,
      entry_price: entryPrice,
      tp1: downsideSupport1,
      tp2: downsideSupport2,
      tp2_reason: support2Zone ? null : 'NO_VALID_SECOND_SUPPORT',
      stop_loss: invalidation,
      level_mode: levelMode,
      support_level: supportZoneTp1.mid_price,
      resistance_level: resistanceZone.mid_price,
      bearish_type: bearishType,
      trigger_state: breakdownState ?? resistanceTriggerState,
      invalidation,
      downside_support_1: downsideSupport1,
      downside_support_2: downsideSupport2
    };
  }
}
function runCase(inputSnapshot) {
  const now = new Date(inputSnapshot.now);
  const tier = inputSnapshot.tier;
  const d1Candles = prepCandles(inputSnapshot.d1?.candles ?? [], 'D1', now);
  const structD1 = readStructure(d1Candles, inputSnapshot.d1?.indicator, 'D1');
  let structBias = structD1;
  if (tier === 'swing') {
    const w1Candles = prepCandles(inputSnapshot.w1?.candles ?? [], 'W1', now);
    structBias = readStructure(w1Candles, inputSnapshot.w1?.indicator, 'W1');
  }
  if (!structD1) return {
    no_signal: true,
    reason: 'insufficient_data'
  };
  const entryPrice = structD1.lastClose;
  return computeSignal(tier, entryPrice, structD1, structBias, d1Candles);
}
function diffResult(expected, actual) {
  const mismatches = [];
  const keys = new Set([
    ...Object.keys(expected ?? {}),
    ...Object.keys(actual ?? {})
  ]);
  for (const k of keys){
    const ev = expected?.[k];
    const av = actual?.[k];
    if (typeof ev === 'number' && typeof av === 'number') {
      if (Math.abs(ev - av) / Math.max(Math.abs(ev), 1) > 0.0001) mismatches.push(`${k}: expected=${ev} actual=${av}`);
    } else if (JSON.stringify(ev) !== JSON.stringify(av)) {
      mismatches.push(`${k}: expected=${JSON.stringify(ev)} actual=${JSON.stringify(av)}`);
    }
  }
  return mismatches;
}
Deno.serve(async (req)=>{
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const body = await req.json().catch(()=>({}));
  const mode = body.mode === 'verify' ? 'verify' : 'seed';
  const caseCodes = body.case_codes;
  let query = supabase.from('golden_test_cases').select('id, case_code, formula_version, input_snapshot, expected_signal');
  if (caseCodes && caseCodes.length > 0) query = query.in('case_code', caseCodes);
  else query = query.not('input_snapshot', 'is', null);
  const { data: cases, error } = await query;
  if (error) return new Response(JSON.stringify({
    error: error.message
  }), {
    status: 500
  });
  const results = [];
  for (const c of cases ?? []){
    if (!c.input_snapshot) {
      results.push({
        case_code: c.case_code,
        skipped: true,
        reason: 'no_input_snapshot'
      });
      continue;
    }
    let actual;
    try {
      actual = runCase(c.input_snapshot);
    } catch (e) {
      actual = {
        error: String(e)
      };
    }
    if (mode === 'seed') {
      const { error: updErr } = await supabase.from('golden_test_cases').update({
        expected_signal: actual,
        status: 'READY',
        last_run_at: new Date().toISOString(),
        last_run_result: {
          mode: 'seed',
          seeded_from_actual: true
        }
      }).eq('id', c.id);
      results.push({
        case_code: c.case_code,
        mode: 'seed',
        ok: !updErr,
        actual,
        error: updErr?.message
      });
    } else {
      const mismatches = diffResult(c.expected_signal, actual);
      const status = mismatches.length === 0 ? 'PASSING' : 'FAILING';
      const { error: updErr } = await supabase.from('golden_test_cases').update({
        status,
        last_run_at: new Date().toISOString(),
        last_run_result: {
          mode: 'verify',
          mismatches,
          actual
        }
      }).eq('id', c.id);
      results.push({
        case_code: c.case_code,
        mode: 'verify',
        status,
        mismatches,
        ok: !updErr
      });
    }
  }
  return new Response(JSON.stringify({
    mode,
    total: results.length,
    results
  }), {
    headers: {
      'Content-Type': 'application/json'
    }
  });
});
