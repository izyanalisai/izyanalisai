import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
// FIX (audit 17 Agustus 2026): js_scenario SEBELUMNYA dikirim di body POST request
// ke ScrapingBee (JSON.stringify({js_scenario})) -- padahal menurut dokumentasi resmi
// ScrapingBee, js_scenario harus dikirim sebagai QUERY PARAMETER (URL-encoded JSON),
// sama seperti api_key/url/render_js, BUKAN di body. Akibatnya instruksi 'wait' dan
// 'evaluate' di js_scenario SELALU diabaikan oleh ScrapingBee (evaluate_results selalu
// kosong []), jadi probe ini tidak pernah berhasil menangkap daftar network request
// (XHR/fetch) yang dilakukan halaman React/Nuxt IDX untuk memuat data tabel -- padahal
// itu tujuan utama probe ini (mencari endpoint API JSON asli di balik halaman SPA).
// Sekarang js_scenario dikirim lewat query string sesuai dokumentasi resmi.
Deno.serve(async (_req)=>{
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const { data: secretRow } = await supabase.from('internal_secrets').select('value').eq('key', 'scrapingbee_api_key').maybeSingle();
  const apiKey = secretRow?.value;
  if (!apiKey) return new Response(JSON.stringify({
    error: 'no api key'
  }), {
    status: 500
  });
  const targetUrl = 'https://www.idx.co.id/id/data-pasar/ringkasan-perdagangan/ringkasan-saham/';
  const jsScenario = {
    instructions: [
      {
        wait: 8000
      },
      {
        evaluate: "JSON.stringify(performance.getEntriesByType('resource').map(e=>e.name).filter(n=>n.match(/api|json|primary|summary|download|export/i)))"
      }
    ]
  };
  const qs = new URLSearchParams({
    api_key: apiKey,
    url: targetUrl,
    render_js: 'true',
    premium_proxy: 'true',
    json_response: 'true',
    js_scenario: JSON.stringify(jsScenario)
  });
  const res = await fetch(`https://app.scrapingbee.com/api/v1/?${qs.toString()}`, {
    method: 'GET'
  });
  const creditsUsed = res.headers.get('spb-cost');
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch  {}
  // Cuma kembalikan bagian yang relevan (evaluate_results + status), bukan seluruh HTML
  // mentah, supaya hasilnya kebaca jelas dan tidak makan konteks besar seperti sebelumnya.
  const evaluateResults = parsed?.['evaluate_results'] ?? parsed?.js_scenario_report ?? null;
  return new Response(JSON.stringify({
    status: res.status,
    creditsUsed,
    evaluateResults,
    rawKeys: parsed ? Object.keys(parsed) : null,
    fallbackSample: !parsed ? text.slice(0, 1000) : undefined
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json'
    }
  });
});
