/** Explicit cloud provider selection. Credentials are server-side secrets only. */
type Env = (name: string) => string | undefined
const env: Env = (name) => (globalThis as typeof globalThis & {
  Deno?: { env: { get: Env } }
}).Deno?.env.get(name)

type Message = { role: string; content: unknown }
export type Provider = {
  name: 'openai' | 'xai' | 'compatible'
  baseUrl: string
  apiKey: string
  model: string
  tokenParameter: 'max_tokens' | 'max_completion_tokens'
  maxTokens: number
  timeoutMs: number
}

export function hasSelectedProvider(getEnv: Env = env): boolean {
  const selected = getEnv('AI_PROVIDER')?.trim()
  return !!selected && selected !== 'legacy'
}

export function resolveProvider(getEnv: Env = env, vision = false): Provider {
  const name = getEnv('AI_PROVIDER')?.trim()
  if (name !== 'openai' && name !== 'xai' && name !== 'compatible') {
    throw new Error('AI_PROVIDER must be openai, xai, compatible, or legacy')
  }
  const defaultUrl = name === 'openai' ? 'https://api.openai.com/v1' : name === 'xai' ? 'https://api.x.ai/v1' : undefined
  const rawUrl = getEnv('AI_PROVIDER_BASE_URL') || defaultUrl
  if (!rawUrl) throw new Error('AI_PROVIDER_BASE_URL is required for compatible providers')
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('AI provider base URL must use HTTPS without credentials, query, or fragment')
  }
  const expectedHost = name === 'openai' ? 'api.openai.com' : name === 'xai' ? 'api.x.ai' : undefined
  if (expectedHost && (url.hostname !== expectedHost || (url.port && url.port !== '443'))) {
    throw new Error('Custom gateways must use AI_PROVIDER=compatible')
  }
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = (path || '/v1') + '/'
  const apiKey = (getEnv('AI_API_KEY') || getEnv(name === 'openai' ? 'OPENAI_API_KEY' : name === 'xai' ? 'XAI_API_KEY' : 'AI_API_KEY'))?.trim()
  const model = getEnv(vision ? 'AI_VISION_MODEL' : 'AI_MODEL')?.trim()
  if (!apiKey) throw new Error('Set a server-side API key for the selected AI provider')
  if (!model) throw new Error(vision ? 'AI_VISION_MODEL is required for image analysis' : 'AI_MODEL is required for the selected AI provider')
  const tokenParameter = getEnv('AI_TOKEN_PARAMETER') || (name === 'openai' ? 'max_completion_tokens' : 'max_tokens')
  if (tokenParameter !== 'max_tokens' && tokenParameter !== 'max_completion_tokens') throw new Error('Invalid AI_TOKEN_PARAMETER')
  const maxTokens = Number(getEnv('AI_MAX_TOKENS') || '2048')
  const timeoutMs = Number(getEnv('AI_TIMEOUT_MS') || '30000')
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 16384) throw new Error('AI_MAX_TOKENS must be an integer from 1 to 16384')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('AI_TIMEOUT_MS must be an integer from 1000 to 120000')
  return { name, baseUrl: url.toString(), apiKey, model, tokenParameter, maxTokens, timeoutMs }
}

export async function callSelectedAI(
  messages: Message[],
  options: { vision?: boolean; json?: boolean; getEnv?: Env; fetcher?: typeof fetch } = {},
) {
  const provider = resolveProvider(options.getEnv || env, options.vision)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), provider.timeoutMs)
  try {
    const response = await (options.fetcher || fetch)(new URL('chat/completions', provider.baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model, messages, [provider.tokenParameter]: provider.maxTokens,
        ...(options.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    })
    // Do not expose provider error bodies, request data, or credentials to users/logs.
    if (!response.ok) throw new Error(`AI provider ${provider.name} returned HTTP ${response.status}`)
    let data
    try { data = await response.json() } catch { throw new Error('AI provider returned invalid JSON') }
    const choice = data?.choices?.[0]
    const text = choice?.message?.content
    if (choice?.message?.refusal || ['length', 'content_filter'].includes(choice?.finish_reason)) {
      throw new Error('AI response was refused or truncated')
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error('AI provider returned no text')
    return {
      text, modelUsed: `${provider.name}:${provider.model}`,
      usage: { input: data?.usage?.prompt_tokens ?? 0, output: data?.usage?.completion_tokens ?? 0 },
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`AI provider ${provider.name} timed out`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}
