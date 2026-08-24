import { createClient } from 'jsr:@supabase/supabase-js@2';
// Worker Trending Score - generate 1-2 kalimat alasan kenapa saham lagi trending.
// URUTAN PROVIDER (diupdate 24 Agustus 2026, migrasi ke Cloudflare -- menyamakan
// pola dengan generate-signal-reasoning/chat-asisten-ai/analyze-chart):
//   Tier 1: Cloudflare Workers AI (REST API langsung, model open-source gratis).
//   Tier 2: 9Router (self-hosted di Railway, OpenAI-compatible) -- fallback kalau CF gagal.
//   Tier 3: OpenRouter, 3 model gratis -- fallback terakhir.
// Diproses SATU-SATU (bukan paralel).
// RESUMABLE OTOMATIS: selalu ambil saham yang trending_reason-nya masih NULL.
//
// UPDATE (24 Agustus 2026, disamakan dengan chat-asisten-ai & generate-signal-reasoning):
// CLOUDFLARE_MODELS diperluas dari 3 jadi 12 model backup, urutan dari paling
// hemat Neuron ke paling mahal, supaya kalau satu/dua model kena limit atau
// di-deprecate Cloudflare, chain tetap jalan sebelum jatuh ke tier 2 (9Router).
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
const SYSTEM_PROMPT = 'Kamu menulis 1-2 kalimat singkat bahasa Indonesia yang menjelaskan kenapa sebuah saham sedang trending, berdasarkan skor & label yang diberikan. Jangan menyebut angka harga baru, jangan kasih rekomendasi buy/sell.';
const REQUEST_TIMEOUT_MS = 20000;
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
async function callProvider(providerLabel, baseUrl, apiKey, models, prompt, extraHeaders = {}) {
  let lastError = null;
  for (const model of models){
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
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
          max_tokens: 150,
          stream: false
        })
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status === 402 || !res.ok) {
        lastError = await res.text();
        console.error(`[generate-trending-reason] [${providerLabel}] model ${model} gagal (${res.status}): ${lastError}`);
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
        console.error(`[generate-trending-reason] [${providerLabel}] model ${model} balas non-JSON (kemungkinan SSE), coba parse manual`);
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
      clearTimeout(timer);
      lastError = err?.name === 'AbortError' ? `timeout setelah ${REQUEST_TIMEOUT_MS}ms (model: ${model})` : err;
      console.error(`[generate-trending-reason] [${providerLabel}] model ${model} exception:`, err);
      continue;
    }
  }
  throw new Error(`[${providerLabel}] semua model gagal: ${JSON.stringify(lastError)}`);
}
// Cloudflare Workers AI: endpoint /ai/run/{model} beda bentuk request/response dari
// OpenAI-compatible chat/completions, tapi model chat (llama/mistral/gemma) di sini
// menerima {messages:[...]} sama seperti OpenAI.
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
          max_tokens: 150
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
      console.error('[generate-trending-reason] tier 1 (cloudflare) gagal, fallback ke 9router:', String(err));
    }
  }
  try {
    return await callProvider('9router', nineRouterBaseUrl, nineRouterKey, nineRouterModels, prompt);
  } catch (nineRouterErr) {
    console.error('[generate-trending-reason] tier 2 (9router) gagal total, coba tier 3 (openrouter):', nineRouterErr);
    const openRouterKey = Deno.env.get('OPENROUTER_API_KEY');
    if (!openRouterKey) {
      console.error('[generate-trending-reason] OPENROUTER_API_KEY belum di-set, chain berhenti');
      throw cfErr ?? nineRouterErr;
    }
    try {
      const baseUrl = Deno.env.get('AI_BASE_URL') || 'https://openrouter.ai/api/v1';
      return await callProvider('openrouter', baseUrl, openRouterKey, FREE_MODELS, prompt, {
        'HTTP-Referer': 'https://izyanalisai.vercel.app',
        'X-Title': 'IzyAnalisAI Trending Reason'
      });
    } catch (openRouterErr) {
      throw new Error(`Semua provider AI gagal. cloudflare: ${String(cfErr)} | 9router: ${String(nineRouterErr)} | openrouter: ${String(openRouterErr)}`);
    }
  }
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
    console.error('[generate-trending-reason] Tidak ada provider AI yang terkonfigurasi (Cloudflare & 9router kosong dua-duanya)');
    return new Response(JSON.stringify({
      error: 'Tidak ada provider AI yang terkonfigurasi (env atau internal_secrets)'
    }), {
      status: 500
    });
  }
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') ?? '5');
  const { data: stocks, error } = await supabase.from('stocks').select('id, ticker, name, trending_score, trending_label').not('trending_score', 'is', null).is('trending_reason', null).order('trending_score', {
    ascending: false
  }).limit(limit);
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
  for (const s of stocks ?? []){
    try {
      const prompt = `Ticker: ${s.ticker} (${s.name})\nTrending Score: ${s.trending_score}\nTrending Label: ${s.trending_label}`;
      const { text, modelUsed, usage } = await callAIChain(prompt, creds);
      await supabase.from('stocks').update({
        trending_reason: text
      }).eq('id', s.id);
      await supabase.from('ai_usage').insert({
        worker: 'generate-trending-reason',
        model: modelUsed,
        tokens_input: usage.input,
        tokens_output: usage.output,
        reference_id: s.id
      });
      success++;
    } catch (err) {
      failed++;
      debugSamples[String(s.id)] = String(err);
      console.error(`[generate-trending-reason] gagal untuk stock ${s.id} (${s.ticker}):`, err);
    }
  }
  return new Response(JSON.stringify({
    limit,
    processed: (stocks ?? []).length,
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
