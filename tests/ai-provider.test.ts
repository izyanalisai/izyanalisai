import { describe, expect, it, vi } from 'vitest'
import { callSelectedAI, hasSelectedProvider, resolveProvider } from '../supabase/functions/_shared/ai-provider'

const env = (values: Record<string, string>) => (name: string) => values[name]
const defaults = { AI_PROVIDER: 'openai', AI_MODEL: 'test-model', OPENAI_API_KEY: 'test-only' }

describe('configured AI providers', () => {
  it('keeps legacy routing until explicitly selected', () => {
    expect(hasSelectedProvider(env({}))).toBe(false)
    expect(hasSelectedProvider(env({ AI_PROVIDER: 'legacy' }))).toBe(false)
    expect(hasSelectedProvider(env(defaults))).toBe(true)
  })
  it.each([
    ['openai', 'https://api.openai.com/v1/', 'max_completion_tokens'],
    ['xai', 'https://api.x.ai/v1/', 'max_tokens'],
  ])('resolves %s with its own endpoint and key', (name, baseUrl, tokenParameter) => {
    const result = resolveProvider(env({ ...defaults, AI_PROVIDER: name, XAI_API_KEY: 'xai-test' }))
    expect(result.baseUrl).toBe(baseUrl)
    expect(result.tokenParameter).toBe(tokenParameter)
    expect(result.apiKey).toBe(name === 'xai' ? 'xai-test' : 'test-only')
  })
  it('requires an explicit vision model', () => {
    expect(() => resolveProvider(env(defaults), true)).toThrow('AI_VISION_MODEL')
    expect(resolveProvider(env({ ...defaults, AI_VISION_MODEL: 'vision-test' }), true).model).toBe('vision-test')
  })
  it.each([
    { AI_PROVIDER: 'wrong' },
    { ...defaults, OPENAI_API_KEY: '' },
    { ...defaults, AI_MODEL: '' },
    { ...defaults, AI_MAX_TOKENS: '0' },
    { ...defaults, AI_TIMEOUT_MS: 'bad' },
    { ...defaults, AI_PROVIDER_BASE_URL: 'http://remote.example/v1' },
    { ...defaults, AI_PROVIDER_BASE_URL: 'https://evil.example/v1' },
    { ...defaults, AI_PROVIDER_BASE_URL: 'https://api.openai.com/v1?key=x' },
  ])('rejects invalid configuration', (values) => {
    expect(() => resolveProvider(env(values))).toThrow()
  })
  it('preserves a fully versioned compatible gateway path', () => {
    const p = resolveProvider(env({ AI_PROVIDER: 'compatible', AI_PROVIDER_BASE_URL: 'https://gateway.example/api/v1/', AI_MODEL: 'model', AI_API_KEY: 'key' }))
    expect(p.baseUrl).toBe('https://gateway.example/api/v1/')
  })
  it('sends one bounded request and reads usage', async () => {
    const fetcher = vi.fn(async (url, init) => {
      expect(String(url)).toBe('https://api.openai.com/v1/chat/completions')
      const payload = JSON.parse(String(init?.body))
      expect(payload.max_completion_tokens).toBe(2048)
      expect(payload.temperature).toBeUndefined()
      expect(payload.response_format).toEqual({ type: 'json_object' })
      return Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } })
    })
    const result = await callSelectedAI([{ role: 'user', content: 'JSON test' }], { getEnv: env(defaults), fetcher, json: true })
    expect(result.usage).toEqual({ input: 5, output: 3 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('does not leak provider error bodies or retry paid calls', async () => {
    const fetcher = vi.fn(async () => new Response('sensitive-test-body', { status: 401 }))
    await expect(callSelectedAI([], { getEnv: env(defaults), fetcher })).rejects.toThrow('HTTP 401')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each(['length', 'content_filter'])('rejects incomplete output: %s', async (finish_reason) => {
    const fetcher = vi.fn(async () => Response.json({ choices: [{ message: { content: 'partial' }, finish_reason }] }))
    await expect(callSelectedAI([], { getEnv: env(defaults), fetcher })).rejects.toThrow('refused or truncated')
  })
})

it('does not expose malformed provider response bodies', async () => {
  const fetcher = vi.fn(async () => new Response('sensitive-invalid-json', { status: 200 }))
  await expect(callSelectedAI([], { getEnv: env(defaults), fetcher })).rejects.toThrow('AI provider returned invalid JSON')
})
