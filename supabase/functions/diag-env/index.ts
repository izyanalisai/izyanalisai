import { hasValidWorkerSecret } from '../_shared/worker-auth.ts';
Deno.serve(async (req)=>{
  if (req.method !== 'POST') return new Response('METHOD_NOT_ALLOWED', {status:405});
  const expected = Deno.env.get('WORKER_SHARED_SECRET');
  if (!expected) return new Response('DIAGNOSTIC_DISABLED', {status:503});
  if (!(await hasValidWorkerSecret(req, expected)))
    return new Response('UNAUTHORIZED', {status:401});
  return new Response(JSON.stringify({
    OPENROUTER_API_KEY_set: !!Deno.env.get('OPENROUTER_API_KEY'),
    AI_BASE_URL: Deno.env.get('AI_BASE_URL') ?? null
  }), {
    headers: {
      'Content-Type': 'application/json'
    }
  });
});
