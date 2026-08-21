Deno.serve(async (_req)=>{
  const nineRouterKey = Deno.env.get('NINEROUTER_API_KEY') ?? null;
  const nineRouterBaseUrl = Deno.env.get('NINEROUTER_BASE_URL') ?? null;
  const report = {};
  if (nineRouterKey && nineRouterBaseUrl) {
    try {
      const res = await fetch(`${nineRouterBaseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${nineRouterKey}`
        }
      });
      const text = await res.text();
      report.models_status = res.status;
      report.models_body = text.slice(0, 3000);
    } catch (err) {
      report.models_error = String(err);
    }
  }
  return new Response(JSON.stringify(report, null, 2), {
    headers: {
      'Content-Type': 'application/json'
    }
  });
});
