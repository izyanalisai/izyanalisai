import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
// Worker IDX EOD (OTOMATIS) - dibuat 17 Agustus 2026, diperbaiki 18 Agustus 2026,
// diperbaiki lagi 19 Agustus 2026 (fix upsert idx_eod_uploads, lihat bawah).
// Sumber: endpoint JSON resmi di balik halaman "Ringkasan Saham" idx.co.id
// (ditemukan via probe-idx-eod v21 setelah fix js_scenario). Endpoint ini di
// belakang Cloudflare JS-challenge, jadi WAJIB lewat ScrapingBee (render_js +
// premium_proxy) -- ini charge credit tiap panggilan (akun ScrapingBee saat ini
// masih TRIAL, expired 1 Sept 2026, makanya job ini didesain untuk GAGAL DENGAN
// AMAN kalau ScrapingBee error/quota habis: hanya log job_runs ERROR, tidak
// pernah menyentuh data -- sistem otomatis tetap jalan pakai Yahoo Fallback
// seperti sebelumnya (sesuai Section 3.2 dokumen spec).
//
// FIX 18 Agustus 2026: root cause data selalu SKIPPED (sampleDate beku di
// 2026-08-14 terus menerus) adalah karena target URL dipanggil TANPA parameter
// `date`, sehingga endpoint IDX mengembalikan snapshot default/cache lama yang
// sama terus-menerus alih-alih data terbaru. Endpoint resmi (didokumentasikan
// publik di berbagai integrasi pihak ketiga) menerima date=YYYYMMDD eksplisit.
// Perbaikan: selalu kirim date=<expectedDate dalam YYYYMMDD> ke target URL.
//
// FIX 19 Agustus 2026: tabel idx_eod_uploads punya UNIQUE(trade_date), tapi kode
// sebelumnya pakai .insert() biasa TANPA cek error hasilnya. Begitu ada 1 baris
// (misal FAILED) untuk tanggal tertentu, percobaan berikutnya untuk tanggal yang
// sama -- termasuk yang SUKSES dapat data -- gagal nulis log karena conflict
// unique key, dan errornya ditelan diam-diam. Akibatnya log idx_eod_uploads bisa
// terlihat "gagal terus" padahal data aslinya sudah benar masuk ke quotes/candles.
// Perbaikan: ganti semua .insert() ke .upsert(..., {onConflict:'trade_date'})
// supaya baris log per tanggal selalu mencerminkan hasil percobaan TERAKHIR.
function todayWIB() {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return wib.toISOString().slice(0, 10);
}
function toCompactDate(isoDate) {
  return isoDate.replaceAll('-', '');
}
async function fetchViaScrapingBee(sbKey, targetPath, expectedDateCompact) {
  const targetUrl = `https://www.idx.co.id${targetPath}?date=${expectedDateCompact}&length=9999&start=0`;
  const qs = new URLSearchParams({
    api_key: sbKey,
    url: targetUrl,
    render_js: 'true',
    premium_proxy: 'true',
    forward_headers: 'true'
  });
  const sbRes = await fetch(`https://app.scrapingbee.com/api/v1/?${qs.toString()}`, {
    method: 'GET',
    headers: {
      'Spb-Forward-Referer': 'https://www.idx.co.id/id/data-pasar/ringkasan-perdagangan/ringkasan-saham/',
      'Spb-Forward-Accept': 'application/json',
      'Spb-Forward-Cache-Control': 'no-cache'
    }
  });
  const bodyText = await sbRes.text();
  if (!sbRes.ok) {
    return {
      ok: false,
      status: sbRes.status,
      json: null,
      bodyText
    };
  }
  try {
    const json = JSON.parse(bodyText);
    return {
      ok: true,
      status: sbRes.status,
      json,
      bodyText
    };
  } catch (e) {
    return {
      ok: false,
      status: sbRes.status,
      json: null,
      bodyText: `parse json gagal: ${e}`
    };
  }
}
Deno.serve(async (req)=>{
  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const providedSecret = req.headers.get('x-worker-secret');
  const { data: secretRow } = await admin.from('internal_secrets').select('value').eq('key', 'worker_shared_secret').maybeSingle();
  if (!providedSecret || !secretRow || providedSecret !== secretRow.value) {
    return new Response(JSON.stringify({
      error: 'unauthorized'
    }), {
      status: 401
    });
  }
  const { data: sbKeyRow } = await admin.from('internal_secrets').select('value').eq('key', 'scrapingbee_api_key').maybeSingle();
  const sbKey = sbKeyRow?.value;
  if (!sbKey) return new Response(JSON.stringify({
    error: 'scrapingbee_api_key belum di-set'
  }), {
    status: 500
  });
  const url = new URL(req.url);
  const dateOverride = url.searchParams.get('date');
  const expectedDate = dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride) ? dateOverride : todayWIB();
  const expectedDateCompact = toCompactDate(expectedDate);
  const targetPath = '/primary/TradingSummary/GetStockSummary';
  let result;
  try {
    result = await fetchViaScrapingBee(sbKey, targetPath, expectedDateCompact);
  } catch (e) {
    const { error: logErr } = await admin.from('idx_eod_uploads').upsert({
      trade_date: expectedDate,
      file_name: 'auto:scrapingbee',
      row_count: 0,
      matched_count: 0,
      status: 'FAILED',
      error_message: `exception: ${e}`
    }, {
      onConflict: 'trade_date'
    });
    if (logErr) console.error('[fetch-idx-eod] gagal upsert idx_eod_uploads (exception path):', logErr.message);
    return new Response(JSON.stringify({
      status: 'FAILED',
      reason: String(e)
    }), {
      status: 502
    });
  }
  if (!result.ok) {
    const { error: logErr } = await admin.from('idx_eod_uploads').upsert({
      trade_date: expectedDate,
      file_name: 'auto:scrapingbee',
      row_count: 0,
      matched_count: 0,
      status: 'FAILED',
      error_message: `http ${result.status}: ${result.bodyText.slice(0, 300)}`
    }, {
      onConflict: 'trade_date'
    });
    if (logErr) console.error('[fetch-idx-eod] gagal upsert idx_eod_uploads (http not ok):', logErr.message);
    return new Response(JSON.stringify({
      status: 'FAILED',
      http_status: result.status,
      detail: result.bodyText.slice(0, 500)
    }), {
      status: 502
    });
  }
  const rows = Array.isArray(result.json?.data) ? result.json.data : [];
  if (rows.length === 0) {
    return new Response(JSON.stringify({
      status: 'SKIPPED',
      reason: `belum ada data IDX untuk tanggal ${expectedDate} (kemungkinan belum rilis atau hari libur) - akan dicoba lagi jadwal berikutnya`,
      expectedDate
    }), {
      status: 200
    });
  }
  const sampleDate = String(rows[0]?.Date ?? '').slice(0, 10);
  if (sampleDate !== expectedDate) {
    return new Response(JSON.stringify({
      status: 'SKIPPED',
      reason: `data IDX yang diterima tanggal ${sampleDate}, tidak cocok dengan ${expectedDate} yang diminta - akan dicoba lagi jadwal berikutnya`,
      expectedDate,
      sampleDate
    }), {
      status: 200
    });
  }
  const { data: stocks } = await admin.from('stocks').select('id, ticker');
  const tickerMap = new Map((stocks ?? []).map((s)=>[
      String(s.ticker).toUpperCase(),
      s.id
    ]));
  const quoteRows = [];
  const candleRows = [];
  const unmatched = [];
  let matched = 0;
  let totalForeignBuy = 0;
  let totalForeignSell = 0;
  for (const r of rows){
    const ticker = String(r.StockCode ?? '').trim().toUpperCase();
    if (!ticker) continue;
    const fBuy = Number(r.ForeignBuy ?? 0) || 0;
    const fSell = Number(r.ForeignSell ?? 0) || 0;
    totalForeignBuy += fBuy;
    totalForeignSell += fSell;
    const stockId = tickerMap.get(ticker);
    if (!stockId) {
      unmatched.push(ticker);
      continue;
    }
    const close = Number(r.Close ?? 0) || null;
    if (close === null) {
      unmatched.push(`${ticker} (no close)`);
      continue;
    }
    const open = Number(r.OpenPrice ?? 0) || close;
    const high = Number(r.High ?? 0) || close;
    const low = Number(r.Low ?? 0) || close;
    const prevClose = Number(r.Previous ?? 0) || null;
    const volume = Number(r.Volume ?? 0) || 0;
    matched++;
    quoteRows.push({
      stock_id: stockId,
      price: close,
      previous_close: prevClose,
      day_high: high,
      day_low: low,
      volume,
      market_time: `${expectedDate}T16:00:00+07:00`,
      quality: 'FRESH',
      source: 'IDX_AUTO',
      updated_at: new Date().toISOString()
    });
    candleRows.push({
      stock_id: stockId,
      timeframe: 'D1',
      ts: `${expectedDate}T00:00:00+07:00`,
      open,
      high,
      low,
      close,
      volume,
      source: 'IDX_AUTO'
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
  const foreignFlowNet = totalForeignBuy - totalForeignSell;
  const { error: ffError } = await admin.from('foreign_flow').upsert({
    date: expectedDate,
    net_value: foreignFlowNet,
    updated_at: new Date().toISOString()
  }, {
    onConflict: 'date'
  });
  const { error: logErr } = await admin.from('idx_eod_uploads').upsert({
    trade_date: expectedDate,
    file_name: 'auto:scrapingbee',
    row_count: rows.length,
    matched_count: matched,
    unmatched_tickers: Array.from(new Set(unmatched)).slice(0, 50),
    status: quoteError || candleError ? 'FAILED' : 'PROCESSED',
    error_message: quoteError || candleError || null
  }, {
    onConflict: 'trade_date'
  });
  if (logErr) console.error('[fetch-idx-eod] gagal upsert idx_eod_uploads (success path):', logErr.message);
  return new Response(JSON.stringify({
    status: 'PROCESSED',
    trade_date: expectedDate,
    used_path: targetPath,
    total_rows: rows.length,
    matched,
    unmatched_sample: Array.from(new Set(unmatched)).slice(0, 20),
    quoteError,
    candleError,
    foreign_flow_net: foreignFlowNet,
    foreignFlowError: ffError?.message ?? null,
    upload_log_error: logErr?.message ?? null
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json'
    }
  });
});
