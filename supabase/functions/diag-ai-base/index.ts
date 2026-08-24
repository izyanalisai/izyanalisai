Deno.serve(async (_req) => {
  const nineRouterKey = Deno.env.get('NINEROUTER_API_KEY') ?? null;
  const nineRouterBaseUrl = Deno.env.get('NINEROUTER_BASE_URL') ?? null;
  const cfAccountId = Deno.env.get('CLOUDFLARE_ACCOUNT_ID') ?? null;
  const cfApiToken = Deno.env.get('CLOUDFLARE_API_TOKEN') ?? null;

  const report: Record<string, unknown> = {};

  // Daftar 12 model persis sama seperti CLOUDFLARE_MODELS di chat-asisten-ai /
  // generate-signal-reasoning / generate-trending-reason / fetch-news.
  // Kalau daftar itu diubah, update juga di sini biar diagnosticnya tetap akurat.
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

  // --- Tier 1: Cloudflare Workers AI -- tes SEMUA 12 model satu-satu ---
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

  // --- Tier 2: 9Router ---
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
