import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (_req) => {
  let nineRouterKey = Deno.env.get('NINEROUTER_API_KEY') ?? null;
  let nineRouterBaseUrl = Deno.env.get('NINEROUTER_BASE_URL') ?? null;
  let cfAccountId = Deno.env.get('CLOUDFLARE_ACCOUNT_ID') ?? null;
  let cfApiToken = Deno.env.get('CLOUDFLARE_API_TOKEN') ?? null;

  // Fallback ke internal_secrets -- pola yang sama seperti chat-asisten-ai,
  // generate-signal-reasoning, generate-trending-reason, fetch-news. Kredensial
  // CF/9Router bisa disimpan di env var ATAU di tabel internal_secrets, jadi
  // diagnostic ini harus cek dua-duanya juga, bukan cuma env var.
  if (!cfAccountId || !cfApiToken || !nineRouterKey || !nineRouterBaseUrl) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (supabaseUrl && serviceKey) {
      const admin = createClient(supabaseUrl, serviceKey);
      const { data: rows } = await admin
        .from('internal_secrets')
        .select('key,value')
        .in('key', [
          'nineRouter_api_key',
          'nineRouter_base_url',
          'cloudflare_account_id',
          'cloudflare_api_token',
        ]);
      const map = Object.fromEntries(
        (rows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]),
      );
      nineRouterKey = nineRouterKey || map['nineRouter_api_key'] || null;
      nineRouterBaseUrl =
        nineRouterBaseUrl || (map['nineRouter_base_url'] ? map['nineRouter_base_url'] + '/v1' : null);
      cfAccountId = cfAccountId || map['cloudflare_account_id'] || null;
      cfApiToken = cfApiToken || map['cloudflare_api_token'] || null;
    }
  }

  const report: Record<string, unknown> = {};

  const CLOUDFLARE_MODELS = [
    '@cf/meta/llama-3.1-8b-instruct-fast',
    '@cf/meta/llama-3.2-3b-instruct',
    '@cf/qwen/qwen1.5-14b-chat-awq',
    '@cf/meta/llama-3.1-8b-instruct',
    '@cf/mistralai/mistral-small-3.1-24b-instruct',
    '@cf/openai/gpt-oss-20b',
    '@cf/google/gemma-3-27b-it',
    '@cf/zhipu/glm-4.7-flash',
    '@cf/qwen/qwen3-30b-a3b',
    '@cf/ibm-granite/granite-4.0-instruct',
    '@cf/openai/gpt-oss-120b',
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  ];

  if (cfAccountId && cfApiToken) {
    const results: Record<string, unknown>[] = [];
    for (const model of CLOUDFLARE_MODELS) {
      try {
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/${model}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cfApiToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 5,
            }),
            signal: AbortSignal.timeout(10000),
          },
        );
        const data = await res.json().catch(() => null);
        const ok = res.ok && data?.success !== false && !!data?.result?.response;
        results.push({
          model,
          http_status: res.status,
          ok,
          error: ok ? null : (data?.errors ?? (await res.text().catch(() => 'unknown'))),
        });
      } catch (err) {
        results.push({ model, ok: false, error: String(err) });
      }
    }
    report.cloudflare_models = results;
    report.cloudflare_summary = {
      total: results.length,
      valid: results.filter((r) => r.ok).length,
      dead: results.filter((r) => !r.ok).map((r) => r.model),
    };
  } else {
    report.cloudflare_configured = false;
  }

  if (nineRouterKey && nineRouterBaseUrl) {
    try {
      const res = await fetch(`${nineRouterBaseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${nineRouterKey}` },
        signal: AbortSignal.timeout(10000),
      });
      const text = await res.text();
      report.ninerouter_status = res.status;
      report.ninerouter_body = text.slice(0, 3000);
    } catch (err) {
      report.ninerouter_error = String(err);
    }
  } else {
    report.ninerouter_configured = false;
  }

  return new Response(JSON.stringify(report, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
});
