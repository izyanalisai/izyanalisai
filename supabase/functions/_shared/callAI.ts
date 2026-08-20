import { createClient } from 'jsr:@supabase/supabase-js@2'

// ============================================================
// callAI(task_type) -- abstraksi AI provider terpusat
// Spec v5.0 section 14.1 / 14.2:
//   "Model spesifik tidak boleh hardcode. Code hanya memanggil callAI(task_type)."
//
// Sebelum ini: chat-asisten-ai, generate-signal-reasoning,
// generate-trending-reason, dan analyze-chart masing-masing punya
// callAIChain()/callProvider() sendiri yang isinya 90% sama (copy-paste).
// Akibatnya waktu ada fix (mis. bug SSE parsing 19 Agustus 2026), harus
// ditempel manual ke 4 file terpisah.
//
// Sekarang: satu fungsi callAI(taskType, input) dipanggil dari 4 worker itu.
// Task type -> model mapping (spec 14.2):
//   FAST_MODEL      -> NETRAL analysis, 957 stock processing, simple/trending text
//   REASONING_MODEL -> BUY/SELL signal reasoning
//   PREMIUM_CHAT_MODEL -> AI Chat (termasuk Premium chat)
//   VISION_MODEL    -> chart upload / vision
//
// Provider chain tetap sama seperti sebelumnya (tidak mengubah behavior):
//   Tier 1: 9Router (self-hosted di Railway, OpenAI-compatible) -- provider utama.
//   Tier 2: OpenRouter, model gratis -- fallback kalau 9Router gagal total.
// ============================================================

export type AITaskType = 'FAST' | 'REASONING' | 'PREMIUM_CHAT' | 'VISION'

export interface AIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
}

export interface AICallResult {
  text: string
  modelUsed: string
  usage: { input: number; output: number }
}

export class AllProvidersFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AllProvidersFailedError'
  }
}

// ------------------------------------------------------------
// Model mapping per task type.
// ENV var per task-type didahulukan (biar bisa di-tune per task tanpa deploy
// ulang code), fallback ke NINEROUTER_MODEL lama (backward compat), lalu 'auto'.
// ------------------------------------------------------------
function nineRouterModelsFor(taskType: AITaskType): string[] {
  const perTaskEnv: Record<AITaskType, string> = {
    FAST: 'NINEROUTER_MODEL_FAST',
    REASONING: 'NINEROUTER_MODEL_REASONING',
    PREMIUM_CHAT: 'NINEROUTER_MODEL_CHAT',
    VISION: 'NINEROUTER_MODEL_VISION',
  }
  const legacyFallbackEnv = taskType === 'VISION' ? 'NINEROUTER_VISION_MODEL' : 'NINEROUTER_MODEL'
  const model =
    Deno.env.get(perTaskEnv[taskType]) ||
    Deno.env.get(legacyFallbackEnv) ||
    Deno.env.get('NINEROUTER_MODEL') ||
    'auto'
  return [model]
}

function openRouterFreeModelsFor(taskType: AITaskType): string[] {
  if (taskType === 'VISION') {
    return [
      'google/gemma-4-31b-it:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'google/gemma-4-26b-a4b-it:free',
    ]
  }
  if (taskType === 'PREMIUM_CHAT') {
    return [
      'google/gemma-4-31b-it:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'google/gemma-4-26b-a4b-it:free',
    ]
  }
  // FAST & REASONING pakai daftar yang sama seperti sebelumnya
  return [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
  ]
}

function maxTokensFor(taskType: AITaskType): number {
  switch (taskType) {
    case 'FAST':
      return 150
    case 'REASONING':
      return 300
    case 'PREMIUM_CHAT':
      return 800
    case 'VISION':
      return 500
  }
}

// ------------------------------------------------------------
// SSE fallback parser (fix 19 Agustus 2026): 9Router kadang balas format
// SSE ("data: {...}") walau stream:false diminta -- res.json() gagal parse.
// ------------------------------------------------------------
function parseSSEToContent(raw: string): { content: string; usage: { input: number; output: number } } {
  let content = ''
  let usage = { input: 0, output: 0 }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const chunk = JSON.parse(payload)
      const delta = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content
      if (delta) content += delta
      if (chunk?.usage) {
        usage = {
          input: chunk.usage.prompt_tokens ?? usage.input,
          output: chunk.usage.completion_tokens ?? usage.output,
        }
      }
    } catch {
      continue
    }
  }
  return { content, usage }
}

async function callProvider(
  providerLabel: string,
  baseUrl: string,
  apiKey: string,
  models: string[],
  messages: AIMessage[],
  maxTokens: number,
  extraHeaders: Record<string, string> = {},
): Promise<AICallResult> {
  let lastError: unknown = null
  for (const model of models) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: false }),
      })
      clearTimeout(timer)

      if (res.status === 429 || res.status === 402 || !res.ok) {
        lastError = await res.text()
        console.error(`[callAI] [${providerLabel}] model ${model} gagal (${res.status}): ${lastError}`)
        continue
      }

      const rawBody = await res.text()
      let text = ''
      let usageIn = 0
      let usageOut = 0
      try {
        const data = JSON.parse(rawBody)
        text = data?.choices?.[0]?.message?.content ?? ''
        usageIn = data?.usage?.prompt_tokens ?? 0
        usageOut = data?.usage?.completion_tokens ?? 0
      } catch {
        console.error(`[callAI] [${providerLabel}] model ${model} balas non-JSON (kemungkinan SSE), coba parse manual`)
        const parsed = parseSSEToContent(rawBody)
        text = parsed.content
        usageIn = parsed.usage.input
        usageOut = parsed.usage.output
      }

      if (!text) {
        lastError = 'response kosong'
        continue
      }

      return { text, modelUsed: `${providerLabel}:${model}`, usage: { input: usageIn, output: usageOut } }
    } catch (err) {
      clearTimeout(timer)
      lastError = err
      continue
    }
  }
  throw new Error(`[${providerLabel}] semua model gagal: ${JSON.stringify(lastError)}`)
}

// ------------------------------------------------------------
// Ambil kredensial 9Router: env var dulu, fallback ke internal_secrets
// (dipakai chat-asisten-ai & analyze-chart sebelumnya, sekarang berlaku
// untuk semua task type biar konsisten).
// ------------------------------------------------------------
export async function getNineRouterCredentials(): Promise<{ key: string; baseUrl: string } | null> {
  let key = Deno.env.get('NINEROUTER_API_KEY')
  let baseUrl = Deno.env.get('NINEROUTER_BASE_URL')

  if (!key || !baseUrl) {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: rows } = await admin
      .from('internal_secrets')
      .select('key,value')
      .in('key', ['nineRouter_api_key', 'nineRouter_base_url'])
    const map = Object.fromEntries((rows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]))
    key = key || map['nineRouter_api_key']
    baseUrl = baseUrl || (map['nineRouter_base_url'] ? map['nineRouter_base_url'] + '/v1' : undefined)
  }

  if (!key || !baseUrl) return null
  return { key, baseUrl }
}

// ------------------------------------------------------------
// callAI(task_type) -- satu pintu masuk untuk semua worker.
// ------------------------------------------------------------
export async function callAI(taskType: AITaskType, messages: AIMessage[]): Promise<AICallResult> {
  const creds = await getNineRouterCredentials()
  if (!creds) {
    throw new Error('NINEROUTER_API_KEY/NINEROUTER_BASE_URL belum di-set (env atau internal_secrets)')
  }

  const nineRouterModels = nineRouterModelsFor(taskType)
  const maxTokens = maxTokensFor(taskType)

  try {
    return await callProvider('9router', creds.baseUrl, creds.key, nineRouterModels, messages, maxTokens)
  } catch (nineRouterErr) {
    console.error(`[callAI] tier 1 (9router) gagal total untuk task ${taskType}, coba tier 2 (openrouter):`, nineRouterErr)

    const openRouterKey = Deno.env.get('OPENROUTER_API_KEY')
    if (!openRouterKey) {
      throw new AllProvidersFailedError(`Semua provider AI gagal (openrouter tidak dikonfigurasi). 9router: ${String(nineRouterErr)}`)
    }

    try {
      const baseUrl = Deno.env.get('AI_BASE_URL') || 'https://openrouter.ai/api/v1'
      const freeModels = openRouterFreeModelsFor(taskType)
      return await callProvider('openrouter', baseUrl, openRouterKey, freeModels, messages, maxTokens, {
        'HTTP-Referer': 'https://izyanalisai.vercel.app',
        'X-Title': `IzyAnalisAI ${taskType}`,
      })
    } catch (openRouterErr) {
      throw new AllProvidersFailedError(
        `Semua provider AI gagal. 9router: ${String(nineRouterErr)} | openrouter: ${String(openRouterErr)}`,
      )
    }
  }
}

// Helper: bungkus prompt teks polos jadi messages array (buat worker yang cuma
// butuh system+user prompt tanpa history, kayak generate-trending-reason /
// generate-signal-reasoning).
export function simplePrompt(systemPrompt: string, userPrompt: string): AIMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]
}

// Helper: sanitize reply teks pendek (buang echo system prompt / tanda kutip
// pembungkus), dipakai generate-trending-reason & generate-signal-reasoning.
export function sanitizeShortReply(raw: string, systemPromptForMarker: string): string {
  let text = raw.trim()
  const marker = systemPromptForMarker.slice(0, 25)
  const idx = text.indexOf(marker)
  if (idx !== -1) text = text.slice(0, idx).trim()
  text = text.replace(/^["']|["']$/g, '').trim()
  return text
}
