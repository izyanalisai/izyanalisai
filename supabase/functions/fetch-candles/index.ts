import { createClient } from 'jsr:@supabase/supabase-js@2';
const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const CONCURRENCY = 10;
const BATCH_DELAY_MS = 300;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const FULL_RANGE = {
  D1: {
    interval: '1d',
    range: '2y'
  },
  W1: {
    interval: '1wk',
    range: '5y'
  },
  H1: {
    interval: '60m',
    range: '60d'
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
  },
  H1: {
    interval: '60m',
    range: '10d'
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
function aggregateToH4(h1) {
  const out = [];
  // Aggregate only complete 4-hour buckets in chronological order.
  for(let i = 0; i + 3 < h1.length; i += 4){
    const b = h1.slice(i, i + 4);
    out.push({
      ts: b[0].ts,
      open: b[0].open,
      high: Math.max(...b.map((c)=>c.high)),
      low: Math.min(...b.map((c)=>c.low)),
      close: b[3].close,
      volume: b.reduce((s, c)=>s + (c.volume ?? 0), 0)
    });
  }
  return out;
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
    'W1',
    'H1',
    'H4'
  ].includes(timeframe)) return new Response(JSON.stringify({
    error: `timeframe tidak didukung: ${timeframe}`
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
      let candles;
      if (timeframe === 'H4') {
        const { data: latestH1 } = await supabase.from('candles').select('ts').eq('stock_id', s.id).eq('timeframe', 'H1').order('ts', {
          ascending: false
        }).limit(1).maybeSingle();
        const fullH1 = forceFull || !latestH1?.ts || Date.now() - new Date(latestH1.ts).getTime() > STALE_MS;
        const h1 = await fetchYahoo(s.ticker, 'H1', fullH1);
        if (!h1.length) throw new Error('no H1 candle data from Yahoo');
        const rows = h1.map((c)=>({
            stock_id: s.id,
            timeframe: 'H1',
            ...c
          }));
        const { error: e } = await supabase.from('candles').upsert(rows, {
          onConflict: 'stock_id,timeframe,ts'
        });
        if (e) throw e;
        candles = aggregateToH4(h1);
        incrementalCount += fullH1 ? 0 : 1;
        fullCount += fullH1 ? 1 : 0;
      } else {
        const { data: latest } = await supabase.from('candles').select('ts').eq('stock_id', s.id).eq('timeframe', timeframe).order('ts', {
          ascending: false
        }).limit(1).maybeSingle();
        const full = !forceFull && latest?.ts ? Date.now() - new Date(latest.ts).getTime() > STALE_MS : !latest?.ts;
        candles = await fetchYahoo(s.ticker, timeframe, full);
        if (!candles.length) throw new Error('no candle data from Yahoo');
        incrementalCount += full ? 0 : 1;
        fullCount += full ? 1 : 0;
      }
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
