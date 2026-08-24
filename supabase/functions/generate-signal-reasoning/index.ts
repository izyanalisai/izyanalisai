import { createClient } from 'jsr:@supabase/supabase-js@2';
// Worker Sinyal AI - generate penjelasan/reasoning teks untuk kartu sinyal.
// PENTING: worker ini HANYA menjelaskan evidence yang sudah dihitung engine deterministik
// (generate-signals / generate-signals-mtf). Tidak pernah menentukan ulang angka
// Buy Area/SL/TP/bearish trigger/invalidation/RR/Confidence.
//
// URUTAN PROVIDER (23 Agustus 2026, migrasi ke Cloudflare):
// Tier 1: Cloudflare Workers AI (REST API langsung, model open-source gratis 10rb Neuron/hari,
//         dikelola Cloudflare sendiri, gak perlu jaga kredit/akun kayak 9router).
// Tier 2: 9Router (self-hosted di Railway, OpenAI-compatible) -- fallback kalau CF gagal.
// Tier 3: OpenRouter, 3 model gratis -- fallback terakhir kalau 9Router juga gagal total.
//
// UPDATE (24 Agustus 2026, disamakan dengan chat-asisten-ai): CLOUDFLARE_MODELS
// diperluas dari 3 jadi 12 model backup, urutan dari paling hemat Neuron ke
// paling mahal, supaya kalau satu/dua model kena limit atau di-deprecate
// Cloudflare, chain tetap jalan sebelum jatuh ke tier 2 (9Router). ID lain
// (glm-4.7-flash, qwen3-30b-a3b, granite-4.0-instruct, gemma-3-27b-it) belum
// dikonfirmasi manual -- kalau ternyata salah/403, otomatis di-skip oleh
// callCloudflare() dan lanjut ke model berikutnya, jadi tidak fatal.
const FREE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free'
];
const CLOUDFLARE_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/openai/gpt-oss-20b',
  '@cf/openai/gpt-oss-120b',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
];
const SYSTEM_PROMPT = `Kamu menjelaskan alasan sinyal saham berdasarkan evidence struktur harga (support/resistance, struktur swing, EMA) yang diberikan.

ATURAN YANG HARUS DIPATUHI:
- JANGAN pernah menyebut/mengubah angka Buy Area, SL, TP, bearish trigger, invalidation, downside support, atau membuat klaim statistik apapun (win rate, probabilitas, confidence) -- angka sudah fix dari engine.
- Jika arah sinyal SELL: ini adalah Bearish Alert, BUKAN instruksi short-selling. JANGAN gunakan kata "short entry", "pasti turun", atau "sell area untuk short". Gunakan istilah seperti "risiko penurunan meningkat", "tekanan jual meningkat", "struktur bearish terkonfirmasi".
- Jika ada "Katalis Berita" di evidence, sebutkan secara singkat sebagai pendukung, tapi tetap tekankan bahwa keputusan utama berdasarkan struktur harga.
- Tulis 2-4 kalimat bahasa Indonesia santai, jelasin kenapa struktur harga di timeframe-timeframe terkait mendukung arah sinyalnya.
- JANGAN pernah menulis "Berdasarkan analisis saya" atau "Menurut saya" — tulis seolah-olah ini adalah kesimpulan dari engine.`;
function sanitizeReply(raw) {
  let text = raw.trim();
  const marker = SYSTEM_PROMPT.slice(0, 25);
  const idx = text.indexOf(marker);
  if (idx !== -1) text = text.slice(0, idx).trim();
  text = text.replace(/^["']|["']$/g, '').trim();
  return text;
}
function parseSSEToContent(raw) {
  let content = '';
  for (const line of raw.split('\n')){
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload);
      const delta = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content;
      if (delta) content += delta;
    } catch  {
      continue;
    }
  }
  return content;
}
async function callProvider(providerLabel, baseUrl, apiKey, models, prompt, perModelTimeoutMs, extraHeaders = {}) {
  let lastError = null;
  for (const model of models){
    const controller = new AbortController();
    const timeoutId = setTimeout(()=>controller.abort(), perModelTimeoutMs);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...extraHeaders
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: SYSTEM_PROMPT
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          max_tokens: 1200,
          stream: false
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.status === 429 || res.status === 402 || !res.ok) {
        lastError = await res.text();
        continue;
      }
      const rawBody = await res.text();
      let rawText = '';
      let usageIn = 0, usageOut = 0;
      try {
        const data = JSON.parse(rawBody);
        rawText = data?.choices?.[0]?.message?.content ?? '';
        usageIn = data?.usage?.prompt_tokens ?? 0;
        usageOut = data?.usage?.completion_tokens ?? 0;
      } catch  {
        console.error(`[generate-signal-reasoning] [${providerLabel}] model ${model} balas non-JSON (kemungkinan SSE), coba parse manual`);
        rawText = parseSSEToContent(rawBody);
      }
      const text = sanitizeReply(rawText);
      if (!text) {
        lastError = 'response kosong setelah sanitize';
        continue;
      }
      return {
        text,
        modelUsed: `${providerLabel}:${model}`,
        usage: {
          input: usageIn,
          output: usageOut
        }
      };
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err?.name === 'AbortError' ? `timeout setelah ${perModelTimeoutMs}ms (model: ${model})` : err;
      continue;
    }
  }
  throw new Error(`[${providerLabel}] semua model gagal: ${JSON.stringify(lastError)}`);
}
// Cloudflare Workers AI pakai bentuk request/response beda dari OpenAI-compatible chat/completions,
// jadi dikasih fungsi terpisah (bukan lewat callProvider yang generic OpenAI-style).
async function callCloudflare(accountId, apiToken, models, prompt, perModelTimeoutMs) {
  let lastError = null;
  for (const model of models){
    const controller = new AbortController();
    const timeoutId = setTimeout(()=>controller.abort(), perModelTimeoutMs);
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: SYSTEM_PROMPT
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          max_tokens: 1200
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        lastError = await res.text();
        continue;
      }
      const data = await res.json();
      if (data?.success === false) {
        lastError = JSON.stringify(data.errors);
        continue;
      }
      const rawText = data?.result?.response ?? '';
      const text = sanitizeReply(rawText);
      if (!text) {
        lastError = 'response kosong setelah sanitize';
        continue;
      }
      return {
        text,
        modelUsed: `cloudflare:${model}`,
        usage: {
          input: data?.result?.usage?.prompt_tokens ?? 0,
          output: data?.result?.usage?.completion_tokens ?? 0
        }
      };
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err?.name === 'AbortError' ? `timeout setelah ${perModelTimeoutMs}ms (model: ${model})` : err;
      continue;
    }
  }
  throw new Error(`[cloudflare] semua model gagal: ${JSON.stringify(lastError)}`);
}
async function callAIChain(prompt, creds) {
  const { cfAccountId, cfApiToken, nineRouterKey, nineRouterBaseUrl, nineRouterModels } = creds;
  let cfErr = null;
  if (cfAccountId && cfApiToken) {
    try {
      return await callCloudflare(cfAccountId, cfApiToken, CLOUDFLARE_MODELS, prompt, 15000);
    } catch (err) {
      cfErr = err;
      console.error('[generate-signal-reasoning] Cloudflare Workers AI gagal, fallback ke 9router:', String(err));
    }
  }
  try {
    return await callProvider('9router', nineRouterBaseUrl, nineRouterKey, nineRouterModels, prompt, 50000);
  } catch (nineRouterErr) {
    const openRouterKey = Deno.env.get('OPENROUTER_API_KEY');
    if (!openRouterKey) throw cfErr ?? nineRouterErr;
    try {
      const baseUrl = Deno.env.get('AI_BASE_URL') || 'https://openrouter.ai/api/v1';
      return await callProvider('openrouter', baseUrl, openRouterKey, FREE_MODELS, prompt, 8000, {
        'HTTP-Referer': 'https://izyanalisai.vercel.app',
        'X-Title': 'IzyAnalisAI Signal Reasoning'
      });
    } catch (openRouterErr) {
      throw new Error(`Semua provider AI gagal. cloudflare: ${String(cfErr)} | 9router: ${String(nineRouterErr)} | openrouter: ${String(openRouterErr)}`);
    }
  }
}
function buildPrompt(s, ticker, tierLabel, tfChain, catalystText) {
  const header = `Ticker: ${ticker}
Tier: ${tierLabel} (confluence ${tfChain})
Arah: ${s.direction}`;
  if (s.direction === 'SELL') {
    return `${header}
Jenis Bearish: ${s.bearish_type ?? '-'}
Bearish Trigger: ${s.bearish_trigger ?? '-'}
Invalidation: ${s.invalidation ?? '-'}
Downside Support: ${s.downside_support_1 ?? '-'}${s.downside_support_2 ? ' / ' + s.downside_support_2 : ''}
Evidence struktur: ${JSON.stringify(s.evidence)}${catalystText}`;
  }
  return `${header}
Entry: ${s.entry_price}
Buy Area: ${s.buy_area_low} - ${s.buy_area_high}
Support: ${s.support_level}, Resistance: ${s.resistance_level}
TP1: ${s.tp1}, TP2: ${s.tp2}
Stop Loss: ${s.stop_loss}
Evidence struktur: ${JSON.stringify(s.evidence)}${catalystText}`;
}
Deno.serve(async (req)=>{
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const providedSecret = req.headers.get('x-worker-secret');
  const { data: secretRow, error: secretError } = await supabase.from('internal_secrets').select('value').eq('key', 'worker_shared_secret').maybeSingle();
  if (secretError) {
    return new Response(JSON.stringify({
      error: 'gagal cek worker secret',
      detail: secretError.message
    }), {
      status: 500
    });
  }
  if (!providedSecret || !secretRow || providedSecret !== secretRow.value) {
    return new Response(JSON.stringify({
      error: 'unauthorized'
    }), {
      status: 401
    });
  }
  let nineRouterKey = Deno.env.get('NINEROUTER_API_KEY');
  let nineRouterBaseUrl = Deno.env.get('NINEROUTER_BASE_URL');
  let nineRouterModel = Deno.env.get('NINEROUTER_MODEL');
  let cfAccountId = Deno.env.get('CLOUDFLARE_ACCOUNT_ID');
  let cfApiToken = Deno.env.get('CLOUDFLARE_API_TOKEN');
  if (!nineRouterKey || !nineRouterBaseUrl || !nineRouterModel || nineRouterModel.startsWith('sk-') || !cfAccountId || !cfApiToken) {
    const { data: nrRows } = await supabase.from('internal_secrets').select('key,value').in('key', [
      'nineRouter_api_key',
      'nineRouter_base_url',
      'nineRouter_model',
      'cloudflare_account_id',
      'cloudflare_api_token'
    ]);
    const nrMap = Object.fromEntries((nrRows ?? []).map((r)=>[
        r.key,
        r.value
      ]));
    nineRouterKey = nineRouterKey || nrMap['nineRouter_api_key'];
    nineRouterBaseUrl = nineRouterBaseUrl || (nrMap['nineRouter_base_url'] ? nrMap['nineRouter_base_url'] + '/v1' : undefined);
    if (!nineRouterModel || nineRouterModel.startsWith('sk-')) {
      nineRouterModel = nrMap['nineRouter_model'] || 'auto';
    }
    cfAccountId = cfAccountId || nrMap['cloudflare_account_id'];
    cfApiToken = cfApiToken || nrMap['cloudflare_api_token'];
  }
  const NINEROUTER_MODELS = [
    nineRouterModel || 'auto'
  ];
  if ((!nineRouterKey || !nineRouterBaseUrl) && (!cfAccountId || !cfApiToken)) {
    console.error('[generate-signal-reasoning] Tidak ada provider AI yang terkonfigurasi (Cloudflare & 9router kosong dua-duanya)');
    return new Response(JSON.stringify({
      error: 'Tidak ada provider AI yang terkonfigurasi (env atau internal_secrets)'
    }), {
      status: 500
    });
  }
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') ?? '1');
  const offset = Number(url.searchParams.get('offset') ?? '0');
  const { data: signals, error } = await supabase.from('signals').select(`id, direction, entry_price, buy_area_low, buy_area_high, tp1, tp2, stop_loss,
       support_level, resistance_level, bearish_type, bearish_trigger, invalidation,
       downside_support_1, downside_support_2,
       evidence, signal_tier, entry_timeframe,
       confirm_timeframe, bias_timeframe, stock_id, stocks(ticker, name)`).in('status', [
    'ACTIVE',
    'HIT_TP1',
    'HIT_TP2',
    'HIT_SL',
    'EXPIRED',
    'INVALIDATED'
  ]).is('ai_reasoning', null).order('created_at', {
    ascending: false
  }).range(offset, offset + limit - 1);
  if (error) {
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500
    });
  }
  let success = 0, failed = 0;
  const debugSamples = {};
  const creds = {
    cfAccountId,
    cfApiToken,
    nineRouterKey,
    nineRouterBaseUrl,
    nineRouterModels: NINEROUTER_MODELS
  };
  for (const s of signals ?? []){
    try {
      const ticker = s.stocks?.ticker ?? s.stock_id;
      const tierLabel = s.signal_tier === 'swing' ? 'Swing' : 'Daily';
      const tfChain = s.confirm_timeframe ? `${s.entry_timeframe} -> ${s.confirm_timeframe} -> ${s.bias_timeframe}` : `${s.entry_timeframe} -> ${s.bias_timeframe}`;
      const ev = s.evidence;
      let catalystText = '';
      if (ev?.catalyst && ev.catalyst.has_catalyst) {
        catalystText = `\n\n📰 KATALIS BERITA POSITIF:\n- ${ev.catalyst.summary}\n- Sumber: ${ev.catalyst.source}\n- Waktu: ${new Date(ev.catalyst.published_at).toLocaleString('id-ID', {
          timeZone: 'Asia/Jakarta'
        })}`;
      }
      const prompt = buildPrompt(s, ticker, tierLabel, tfChain, catalystText);
      const { text, modelUsed, usage } = await callAIChain(prompt, creds);
      await supabase.from('signals').update({
        ai_reasoning: {
          text,
          model: modelUsed,
          generated_at: new Date().toISOString()
        }
      }).eq('id', s.id);
      await supabase.from('ai_usage').insert({
        worker: 'generate-signal-reasoning',
        model: modelUsed,
        tokens_input: usage.input,
        tokens_output: usage.output,
        reference_id: s.id
      });
      success++;
    } catch (err) {
      failed++;
      debugSamples[String(s.id)] = String(err);
      console.error(`[generate-signal-reasoning] gagal untuk signal ${s.id} (${s.stocks?.ticker ?? s.stock_id}):`, err);
    }
  }
  return new Response(JSON.stringify({
    offset,
    limit,
    processed: (signals ?? []).length,
    success,
    failed,
    debug_samples: debugSamples
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json'
    }
  });
});
