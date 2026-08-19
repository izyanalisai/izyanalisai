import { createClient } from 'jsr:@supabase/supabase-js@2';
const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const CONCURRENCY = 10;
const BATCH_DELAY_MS = 300;
class DelistedError extends Error {
  constructor(msg){
    super(msg);
    this.name = 'DelistedError';
  }
}
async function fetchQuoteMeta(ticker) {
  const res = await fetch(`${YAHOO_CHART_BASE}/${ticker}.JK?interval=1d&range=5d`, {
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });
  if (!res.ok) {
    // Yahoo mengembalikan 404 + pesan spesifik saat simbol memang sudah tidak ada
    // (delisting/merger), beda dengan error jaringan/rate-limit biasa.
    if (res.status === 404) {
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch  {}
      if (bodyText.toLowerCase().includes('delisted') || bodyText.toLowerCase().includes('no data found')) {
        throw new DelistedError(`Yahoo 404: ${bodyText.slice(0, 200)}`);
      }
    }
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result?.meta) throw new Error('no chart meta');
  return result.meta;
}
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
  const { data: stocks, error } = await supabase.from('stocks').select('id, ticker').eq('is_active', true);
  if (error || !stocks) {
    return new Response(JSON.stringify({
      error: error?.message ?? 'no stocks'
    }), {
      status: 500
    });
  }
  let totalOk = 0;
  let totalFailed = 0;
  const errorSamples = {};
  const possiblyDelisted = [];
  for(let i = 0; i < stocks.length; i += CONCURRENCY){
    const batch = stocks.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (s)=>{
      try {
        const meta = await fetchQuoteMeta(s.ticker);
        return {
          stock: s,
          meta
        };
      } catch (err) {
        // lampirkan info stock ke error supaya bisa dilacak per-ticker,
        // bukan cuma index batch yang tidak berguna untuk debugging.
        const wrapped = err instanceof Error ? err : new Error(String(err));
        wrapped.stockTicker = s.ticker;
        wrapped.stockId = s.id;
        wrapped.isDelisted = err instanceof DelistedError;
        throw wrapped;
      }
    }));
    const rows = [];
    for (const r of results){
      if (r.status !== 'fulfilled') {
        totalFailed++;
        const reason = r.reason;
        const ticker = reason?.stockTicker ?? `unknown-${totalFailed}`;
        errorSamples[ticker] = String(reason?.message ?? reason);
        if (reason?.isDelisted && reason?.stockId) {
          possiblyDelisted.push({
            id: reason.stockId,
            ticker: reason.stockTicker
          });
        }
        continue;
      }
      const { stock, meta } = r.value;
      rows.push({
        stock_id: stock.id,
        price: meta.regularMarketPrice ?? null,
        previous_close: meta.chartPreviousClose ?? meta.previousClose ?? null,
        day_high: meta.regularMarketDayHigh ?? null,
        day_low: meta.regularMarketDayLow ?? null,
        volume: meta.regularMarketVolume ?? null,
        market_time: meta.regularMarketTime ? new Date(Number(meta.regularMarketTime) * 1000).toISOString() : null,
        quality: 'FRESH',
        updated_at: new Date().toISOString()
      });
    }
    if (rows.length > 0) {
      const { error: upsertError } = await supabase.from('quotes').upsert(rows, {
        onConflict: 'stock_id'
      });
      if (upsertError) {
        console.error('upsert error', upsertError);
        errorSamples['upsert'] = upsertError.message;
        totalFailed += rows.length;
      } else {
        totalOk += rows.length;
      }
    }
    if (i + CONCURRENCY < stocks.length) {
      await new Promise((r)=>setTimeout(r, BATCH_DELAY_MS));
    }
  }
  // Saham yang Yahoo Finance secara eksplisit bilang "delisted/no data found" dicatat sebagai
  // corporate action PENDING (bukan langsung dinonaktifkan otomatis, untuk hindari false-positive
  // dari glitch API sesaat) supaya admin bisa review & konfirmasi lewat halaman Admin.
  for (const d of possiblyDelisted){
    const { data: existing } = await supabase.from('corporate_actions').select('id').eq('stock_id', d.id).eq('action_type', 'DELISTING').eq('status', 'PENDING').maybeSingle();
    if (!existing) {
      await supabase.from('corporate_actions').insert({
        stock_id: d.id,
        action_type: 'DELISTING',
        ex_date: new Date().toISOString().slice(0, 10),
        status: 'PENDING',
        notes: `Auto-detected: Yahoo Finance melaporkan simbol ${d.ticker}.JK tidak ditemukan / kemungkinan delisted. Perlu konfirmasi admin sebelum stocks.is_active diubah.`
      });
    }
  }
  return new Response(JSON.stringify({
    total: stocks.length,
    ok: totalOk,
    failed: totalFailed,
    error_samples: errorSamples,
    possibly_delisted: possiblyDelisted.map((d)=>d.ticker)
  }), {
    headers: {
      'Content-Type': 'application/json'
    }
  });
});
