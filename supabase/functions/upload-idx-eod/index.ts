import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
import * as XLSX from 'https://esm.sh/xlsx@0.18.5';
function parseIdxDate(s) {
  const bulan = {
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    mei: '05',
    jun: '06',
    jul: '07',
    agt: '08',
    sep: '09',
    okt: '10',
    nov: '11',
    des: '12'
  };
  const m = String(s).trim().toLowerCase().match(/(\d{1,2})\s+([a-z]{3})\w*\s+(\d{4})/);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mm = bulan[m[2]];
  if (!mm) return null;
  return `${m[3]}-${mm}-${dd}`;
}
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
async function processRows(rows, tradeDateInput, admin, userId, fileName) {
  let tradeDate = tradeDateInput;
  if (!tradeDate) {
    const sample = rows.find((r)=>r['Tanggal Perdagangan Terakhir']);
    tradeDate = sample ? parseIdxDate(sample['Tanggal Perdagangan Terakhir']) : null;
  }
  if (!tradeDate) throw new Error('could not determine trade_date');
  const { data: stocks } = await admin.from('stocks').select('id, ticker');
  const tickerMap = new Map((stocks ?? []).map((s)=>[
      s.ticker.toUpperCase(),
      s.id
    ]));
  const quoteRows = [];
  const candleRows = [];
  const unmatched = [];
  let matched = 0;
  let totalForeignBuy = 0;
  let totalForeignSell = 0;
  let foreignColsFound = false;
  for (const r of rows){
    const ticker = String(r['Kode Saham'] ?? '').trim().toUpperCase();
    if (!ticker) continue;
    const fBuy = numOrNull(r['Foreign Buy']);
    const fSell = numOrNull(r['Foreign Sell']);
    if (fBuy !== null || fSell !== null) {
      foreignColsFound = true;
      totalForeignBuy += fBuy ?? 0;
      totalForeignSell += fSell ?? 0;
    }
    const stockId = tickerMap.get(ticker);
    if (!stockId) {
      unmatched.push(ticker);
      continue;
    }
    const open = Number(r['Open Price'] ?? 0) || null;
    const high = Number(r['Tertinggi'] ?? 0) || null;
    const low = Number(r['Terendah'] ?? 0) || null;
    const close = Number(r['Penutupan'] ?? 0) || null;
    const prevClose = Number(r['Sebelumnya'] ?? 0) || null;
    const volume = Number(r['Volume'] ?? 0) || 0;
    if (close === null) {
      unmatched.push(`${ticker} (no close)`);
      continue;
    }
    matched++;
    quoteRows.push({
      stock_id: stockId,
      price: close,
      previous_close: prevClose,
      day_high: high,
      day_low: low,
      volume,
      market_time: `${tradeDate}T16:00:00+07:00`,
      quality: 'FRESH',
      source: 'IDX_MANUAL',
      updated_at: new Date().toISOString()
    });
    candleRows.push({
      stock_id: stockId,
      timeframe: 'D1',
      ts: `${tradeDate}T00:00:00+07:00`,
      open: open ?? close,
      high: high ?? close,
      low: low ?? close,
      close,
      volume,
      source: 'IDX_MANUAL'
    });
  }
  let quoteError = null;
  let candleError = null;
  if (quoteRows.length > 0) {
    const { error } = await admin.from('quotes').upsert(quoteRows, {
      onConflict: 'stock_id'
    });
    if (error) quoteError = error.message;
  }
  if (candleRows.length > 0) {
    const { error } = await admin.from('candles').upsert(candleRows, {
      onConflict: 'stock_id,timeframe,ts'
    });
    if (error) candleError = error.message;
  }
  let foreignFlowError = null;
  let foreignFlowNet = null;
  if (foreignColsFound) {
    foreignFlowNet = totalForeignBuy - totalForeignSell;
    const { error } = await admin.from('foreign_flow').upsert({
      date: tradeDate,
      net_value: foreignFlowNet,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'date'
    });
    if (error) foreignFlowError = error.message;
  }
  const { error: logError } = await admin.from('idx_eod_uploads').upsert({
    trade_date: tradeDate,
    uploaded_by: userId,
    file_name: fileName,
    row_count: rows.length,
    matched_count: matched,
    unmatched_tickers: Array.from(new Set(unmatched)).slice(0, 50),
    status: quoteError || candleError ? 'FAILED' : 'PROCESSED',
    error_message: quoteError || candleError || null
  }, {
    onConflict: 'trade_date'
  });
  return {
    trade_date: tradeDate,
    total_rows: rows.length,
    matched,
    unmatched_sample: Array.from(new Set(unmatched)).slice(0, 20),
    quoteError,
    candleError,
    logError: logError?.message ?? null,
    foreign_flow: {
      found_columns: foreignColsFound,
      net_value: foreignFlowNet,
      foreignFlowError
    }
  };
}
Deno.serve(async (req)=>{
  if (req.method !== 'POST') return new Response(JSON.stringify({
    error: 'method not allowed'
  }), {
    status: 405
  });
  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  let userId = null;
  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return new Response(JSON.stringify({
    error: 'unauthorized'
  }), {
    status: 401
  });
  const { data: profile } = await admin.from('profiles').select('is_admin').eq('id', userData.user.id).maybeSingle();
  if (!profile?.is_admin) return new Response(JSON.stringify({
    error: 'forbidden: admin only'
  }), {
    status: 403
  });
  userId = userData.user.id;
  let form;
  try {
    form = await req.formData();
  } catch (e) {
    return new Response(JSON.stringify({
      error: 'expected multipart/form-data',
      detail: String(e)
    }), {
      status: 400
    });
  }
  const file = form.get('file');
  if (!(file instanceof File)) return new Response(JSON.stringify({
    error: 'missing file field'
  }), {
    status: 400
  });
  const tradeDateInput = form.get('trade_date');
  const buf = await file.arrayBuffer();
  let wb;
  try {
    wb = XLSX.read(new Uint8Array(buf), {
      type: 'array'
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: 'failed to parse xlsx',
      detail: String(e)
    }), {
      status: 400
    });
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {
    defval: null
  });
  if (rows.length === 0) return new Response(JSON.stringify({
    error: 'no rows found in file'
  }), {
    status: 400
  });
  try {
    const result = await processRows(rows, tradeDateInput, admin, userId, file.name);
    return new Response(JSON.stringify(result, null, 2), {
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: String(e)
    }), {
      status: 400
    });
  }
});
