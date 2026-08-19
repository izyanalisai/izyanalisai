import { createClient } from 'jsr:@supabase/supabase-js@2';
// Worker Section 4.2 spec v4.2: dijalankan jam 12.10 WIB (05.10 UTC), setelah
// sesi 1 (09.00-12.00 WIB) selesai. Tujuannya HANYA mendeteksi kandidat
// setup/area entry potensial untuk sesi 2 (13.30-15.30 WIB) berdasarkan posisi
// harga terkini terhadap structure_zones (support/resistance) yang sudah
// dihitung dari data D1 sebelumnya.
//
// PENTING (kepatuhan spec 4.2 & 1.5):
// - Hasil di sini BUKAN signal resmi. Tidak pernah insert/update ke tabel `signals`.
// - Tidak menentukan entry/SL/TP -- itu wewenang generate-signals-mtf saat EOD.
// - Disimpan sebagai catatan di session2_setup_previews.
//
// FIX v3: query structure_zones SEBELUMNYA pakai .in('stock_id', [...949 uuid])
// -- URL query string jadi kepanjangan dan server balas 500 "Bad Request" sebelum
// sempat masuk logic. structure_zones cuma ~600 baris total, jadi sekarang ambil
// semua zona D1 langsung (tanpa filter stock_id di query) lalu di-group di memory.
const NEAR_ZONE_THRESHOLD_PCT = 2.0;
Deno.serve(async (req)=>{
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const providedSecret = req.headers.get('x-worker-secret');
  const { data: secretRow } = await supabase.from('internal_secrets').select('value').eq('key', 'worker_shared_secret').maybeSingle();
  if (!providedSecret || !secretRow || providedSecret !== secretRow.value) {
    return new Response(JSON.stringify({
      error: 'unauthorized'
    }), {
      status: 401
    });
  }
  const todayJakarta = new Date(new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Jakarta'
  }));
  const tradeDate = todayJakarta.toISOString().slice(0, 10);
  const { data: calRow } = await supabase.from('market_calendar').select('is_trading_day').eq('date', tradeDate).maybeSingle();
  if (calRow && calRow.is_trading_day === false) {
    return new Response(JSON.stringify({
      skipped: true,
      reason: 'NOT_A_TRADING_DAY',
      trade_date: tradeDate
    }), {
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
  const { data: quotes, error: quoteErr } = await supabase.from('quotes').select('stock_id, price, day_high, day_low, quality').in('quality', [
    'FRESH'
  ]).limit(1000);
  if (quoteErr) return new Response(JSON.stringify({
    error: quoteErr.message
  }), {
    status: 500
  });
  if (!quotes?.length) {
    return new Response(JSON.stringify({
      evaluated: 0,
      reason: 'NO_FRESH_QUOTES'
    }), {
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
  // FIX v3: tidak lagi filter by stock_id di query (URL terlalu panjang untuk ~950
  // saham). Ambil semua zona D1 sekaligus lalu group per stock_id di memory.
  const { data: zones, error: zoneErr } = await supabase.from('structure_zones').select('id, stock_id, zone_type, price_low, price_high, mid_price, strength').eq('timeframe', 'D1').order('generated_at', {
    ascending: false
  }).limit(5000);
  if (zoneErr) return new Response(JSON.stringify({
    error: zoneErr.message
  }), {
    status: 500
  });
  const zonesByStock = new Map();
  for (const z of zones ?? []){
    const list = zonesByStock.get(z.stock_id) ?? [];
    if (list.length < 20) list.push(z);
    zonesByStock.set(z.stock_id, list);
  }
  let evaluated = 0;
  let potentialBuy = 0;
  let potentialSell = 0;
  let noneCount = 0;
  const rows = [];
  for (const q of quotes){
    if (q.price == null) continue;
    const stockZones = zonesByStock.get(q.stock_id) ?? [];
    if (!stockZones.length) continue;
    let nearestSupport = null;
    let nearestResistance = null;
    for (const z of stockZones){
      if (z.zone_type === 'SUPPORT' && z.mid_price != null && z.mid_price <= q.price) {
        if (!nearestSupport || z.mid_price > (nearestSupport.mid_price ?? -Infinity)) nearestSupport = z;
      }
      if (z.zone_type === 'RESISTANCE' && z.mid_price != null && z.mid_price >= q.price) {
        if (!nearestResistance || z.mid_price < (nearestResistance.mid_price ?? Infinity)) nearestResistance = z;
      }
    }
    let bias = 'NONE';
    let nearbyZoneId = null;
    let distancePct = null;
    let note = 'Harga tidak dekat zona support/resistance D1 manapun.';
    const distToSupportPct = nearestSupport?.mid_price ? Math.abs((q.price - nearestSupport.mid_price) / q.price) * 100 : null;
    const distToResistancePct = nearestResistance?.mid_price ? Math.abs((nearestResistance.mid_price - q.price) / q.price) * 100 : null;
    if (distToSupportPct != null && distToSupportPct <= NEAR_ZONE_THRESHOLD_PCT) {
      bias = 'POTENTIAL_BUY';
      nearbyZoneId = nearestSupport.id;
      distancePct = distToSupportPct;
      note = `Harga sesi 1 mendekati support D1 (~${distToSupportPct.toFixed(2)}%). Berpotensi jadi area entry sesi 2 kalau struktur bertahan -- BUKAN sinyal resmi.`;
      potentialBuy++;
    } else if (distToResistancePct != null && distToResistancePct <= NEAR_ZONE_THRESHOLD_PCT) {
      bias = 'POTENTIAL_SELL';
      nearbyZoneId = nearestResistance.id;
      distancePct = distToResistancePct;
      note = `Harga sesi 1 mendekati resistance D1 (~${distToResistancePct.toFixed(2)}%). Berpotensi jadi area rejection/bearish alert sesi 2 -- BUKAN sinyal resmi.`;
      potentialSell++;
    } else {
      noneCount++;
    }
    evaluated++;
    rows.push({
      stock_id: q.stock_id,
      trade_date: tradeDate,
      direction_bias: bias,
      price_at_check: q.price,
      session1_high: q.day_high,
      session1_low: q.day_low,
      nearby_zone_id: nearbyZoneId,
      distance_to_zone_pct: distancePct,
      note
    });
  }
  let inserted = 0;
  const BATCH = 200;
  for(let i = 0; i < rows.length; i += BATCH){
    const batch = rows.slice(i, i + BATCH);
    const { error: upErr, count } = await supabase.from('session2_setup_previews').upsert(batch, {
      onConflict: 'stock_id,trade_date',
      count: 'exact'
    });
    if (!upErr) inserted += count ?? batch.length;
    else console.error('[evaluate-session2-preview] upsert error:', upErr.message);
  }
  await supabase.from('job_runs').insert({
    job_name: 'evaluate-session2-preview',
    status: 'SUCCESS',
    detail: {
      evaluated,
      potential_buy: potentialBuy,
      potential_sell: potentialSell,
      none: noneCount,
      inserted,
      trade_date: tradeDate
    },
    finished_at: new Date().toISOString()
  });
  return new Response(JSON.stringify({
    evaluated,
    potential_buy: potentialBuy,
    potential_sell: potentialSell,
    none: noneCount,
    inserted,
    trade_date: tradeDate
  }), {
    headers: {
      'Content-Type': 'application/json'
    }
  });
});
