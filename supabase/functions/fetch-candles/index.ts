import { createClient } from 'jsr:@supabase/supabase-js@2';
const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const CONCURRENCY = 10;
const BATCH_DELAY_MS = 300;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
// Spec v4.2 Section 3.3: H1/H4 dihapus total dari engine (data tidak reliable dari
// Yahoo dan tidak tersedia gratis dari IDX). Hanya D1 (daily) dan W1 (swing bias) dipakai.
const FULL_RANGE = {
  D1: {
    interval: '1d',
    range: '2y'
  },
  W1: {
    interval: '1wk',
    range: '5y'
  }
};
const INCREMENTAL_RANGE = {
  D1: {
    interval: '1d',
    range: '30d'
  },
  W1: {
    interval: '1wk',
    range: '6mo'
  }
};
async function fetchYahoo(ticker, timeframe, full) {
  const cfg = (full ? FULL_RANGE : INCREMENTAL_RANGE)[timeframe];
  const res = await fetch(`${YAHOO_CHART_BASE}/${ticker}.JK?interval=${cfg.interval}&range=${cfg.range}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('no chart result');
  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const { open = [], high = [], low = [], close = [], volume = [] } = quote;
  const rows = [];
  for(let i = 0; i < timestamps.length; i++)if (open[i] != null && high[i] != null && low[i] != null && close[i] != null) rows.push({
    ts: new Date(timestamps[i] * 1000).toISOString(),
    open: open[i],
    high: high[i],
    low: low[i],
    close: close[i],
    volume: volume[i] ?? null
  });
  return rows;
}
Deno.serve(async (req)=>{
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const url = new URL(req.url);
  const timeframe = (url.searchParams.get('timeframe') ?? 'D1').toUpperCase();
  const offset = Number(url.searchParams.get('offset') ?? '0');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '50'), 1), 50);
  const forceFull = url.searchParams.get('full') === 'true';
  if (![
    'D1',
    'W1'
  ].includes(timeframe)) return new Response(JSON.stringify({
    error: `timeframe tidak didukung: ${timeframe} (H1/H4 sudah dihapus dari engine sesuai spec v4.2 Section 3.3, hanya D1/W1)`
  }), {
    status: 400
  });
  const { data: stocks, error } = await supabase.from('stocks').select('id,ticker').eq('is_active', true).order('ticker').range(offset, offset + limit - 1);
  if (error || !stocks) return new Response(JSON.stringify({
    error: error?.message ?? 'no stocks'
  }), {
    status: 500
  });
  let totalOk = 0, totalFailed = 0, totalCandles = 0, incrementalCount = 0, fullCount = 0;
  const debugSamples = {};
  for(let i = 0; i < stocks.length; i += CONCURRENCY){
    const batch = stocks.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (s)=>{
      const { data: latest } = await supabase.from('candles').select('ts').eq('stock_id', s.id).eq('timeframe', timeframe).order('ts', {
        ascending: false
      }).limit(1).maybeSingle();
      const full = !forceFull && latest?.ts ? Date.now() - new Date(latest.ts).getTime() > STALE_MS : !latest?.ts;
      const candles = await fetchYahoo(s.ticker, timeframe, full);
      if (!candles.length) throw new Error('no candle data from Yahoo');
      incrementalCount += full ? 0 : 1;
      fullCount += full ? 1 : 0;
      return {
        stock: s,
        candles
      };
    }));
    for (const r of results){
      if (r.status !== 'fulfilled') {
        totalFailed++;
        debugSamples[`error-${totalFailed}`] = String(r.reason);
        continue;
      }
      const { stock, candles } = r.value;
      if (!candles.length) {
        totalFailed++;
        debugSamples[stock.ticker] = 'no candle data';
        continue;
      }
      const rows = candles.map((c)=>({
          stock_id: stock.id,
          timeframe,
          ...c
        }));
      const { error: upsertErr } = await supabase.from('candles').upsert(rows, {
        onConflict: 'stock_id,timeframe,ts'
      });
      if (upsertErr) {
        totalFailed++;
        debugSamples[stock.ticker] = upsertErr.message;
        continue;
      }
      totalOk++;
      totalCandles += rows.length;
    }
    if (i + CONCURRENCY < stocks.length) await new Promise((r)=>setTimeout(r, BATCH_DELAY_MS));
  }
  return new Response(JSON.stringify({
    timeframe,
    offset,
    limit,
    total: stocks.length,
    ok: totalOk,
    failed: totalFailed,
    candles_upserted: totalCandles,
    incremental: incrementalCount,
    full: fullCount,
    debug_samples: debugSamples
  }), {
    headers: {
      'Content-Type': 'application/json'
    }
  });
});
