import { createClient } from 'jsr:@supabase/supabase-js@2';
// Worker Market Data Refresh (IHSG) - ambil kuotasi index ^JKSE dari Yahoo Finance,
// jadwal sama seperti fetch-quotes (pg_cron).
Deno.serve(async ()=>{
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EJKSE?interval=1d&range=1d', {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    if (!res.ok) throw new Error(`Yahoo fetch gagal: ${res.status}`);
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) throw new Error('Data IHSG kosong dari Yahoo');
    const value = meta.regularMarketPrice ?? null;
    const previousClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const dayHigh = meta.regularMarketDayHigh ?? null;
    const dayLow = meta.regularMarketDayLow ?? null;
    const { error } = await supabase.from('market_index').upsert({
      ticker: '^JKSE',
      name: 'IHSG',
      value,
      previous_close: previousClose,
      day_high: dayHigh,
      day_low: dayLow,
      quality: value !== null ? 'FRESH' : 'MISSING',
      updated_at: new Date().toISOString()
    });
    if (error) throw error;
    return new Response(JSON.stringify({
      ok: true,
      value,
      previousClose
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: String(err)
    }), {
      status: 500
    });
  }
});
