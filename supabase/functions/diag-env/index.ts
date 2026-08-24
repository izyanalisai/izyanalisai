Deno.serve(()=>{
  return new Response(JSON.stringify({
    OPENROUTER_API_KEY_set: !!Deno.env.get('OPENROUTER_API_KEY'),
    AI_BASE_URL: Deno.env.get('AI_BASE_URL') ?? null
  }), {
    headers: {
      'Content-Type': 'application/json'
    }
  });
});
