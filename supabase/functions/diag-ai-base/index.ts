Deno.serve(async (_req) => {
  const nineRouterKey = Deno.env.get('NINEROUTER_API_KEY') ?? null;
  const nineRouterBaseUrl = Deno.env.get('NINEROUTER_BASE_URL') ?? null;
  const cfAccountId = Deno.env.get('CLOUDFLARE_ACCOUNT_ID') ?? null;
  const cfApiToken = Deno.env.get('CLOUDFLARE_API_TOKEN') ?? null;

  const report: Record<string, unknown> = {};

  // --- Tier 1: Cloudflare Workers AI ---
  if (cfAccountId && cfApiToken) {
    // Model paling murah di chain (llama-3.1-8b-instruct-fast) dipakai sebagai
    // probe ringan -- cukup buat konfirmasi kredensial & model masih valid,
    // tanpa boros Neuron budget harian.
    const probeModel = '@cf/meta/llama-3.1-8b-instruct-fast';
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/${probeModel}`,
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
      const text = await res.text();
      report.cloudflare_status = res.status;
      report.cloudflare_probe_model = probeModel;
      report.cloudflare_body = text.slice(0, 1000);
    } catch (err) {
      report.cloudflare_error = String(err);
    }
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
