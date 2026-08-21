import { createClient } from 'jsr:@supabase/supabase-js@2';
// Worker Trending Score - generate 1-2 kalimat alasan kenapa saham lagi trending.
// Tier 1: 9Router (self-hosted di Railway, OpenAI-compatible) -- provider utama.
// Tier 2: OpenRouter, 3 model gratis -- fallback kalau 9Router gagal total.
// Diproses SATU-SATU (bukan paralel).
// RESUMABLE OTOMATIS: selalu ambil saham yang trending_reason-nya masih NULL.
const NINEROUTER_MODELS = [
  Deno.env.get('NINEROUTER_MODEL') || 'auto'
];
const FREE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free'
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
// FIX (19 Agustus 2026): 9Router kadang balas format SSE walau stream tidak
// diminta -- res.json() gagal parse. Sama seperti fix di chat-asisten-ai/
// analyze-chart: minta stream:false eksplisit + fallback parse manual.
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
      lastError = err;
      continue;
    }
  }
  throw new Error(`[${providerLabel}] semua model gagal: ${JSON.stringify(lastError)}`);
}
async function callAIChain(prompt, nineRouterKey, nineRouterBaseUrl) {
  try {
    return await callProvider('9router', nineRouterBaseUrl, nineRouterKey, NINEROUTER_MODELS, prompt);
  } catch (nineRouterErr) {
    const openRouterKey = Deno.env.get('OPENROUTER_API_KEY');
    if (!openRouterKey) throw nineRouterErr;
    try {
      const baseUrl = Deno.env.get('AI_BASE_URL') || 'https://openrouter.ai/api/v1';
      return await callProvider('openrouter', baseUrl, openRouterKey, FREE_MODELS, prompt, {
        'HTTP-Referer': 'https://izyanalisai.vercel.app',
        'X-Title': 'IzyAnalisAI Trending Reason'
      });
    } catch (openRouterErr) {
      throw new Error(`Semua provider AI gagal. 9router: ${String(nineRouterErr)} | openrouter: ${String(openRouterErr)}`);
    }
  }
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
  const nineRouterKey = Deno.env.get('NINEROUTER_API_KEY');
  const nineRouterBaseUrl = Deno.env.get('NINEROUTER_BASE_URL');
  if (!nineRouterKey || !nineRouterBaseUrl) {
    return new Response(JSON.stringify({
      error: 'NINEROUTER_API_KEY/NINEROUTER_BASE_URL belum di-set di Supabase Secrets'
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
  for (const s of stocks ?? []){
    try {
      const prompt = `Ticker: ${s.ticker} (${s.name})\nTrending Score: ${s.trending_score}\nTrending Label: ${s.trending_label}`;
      const { text, modelUsed, usage } = await callAIChain(prompt, nineRouterKey, nineRouterBaseUrl);
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
