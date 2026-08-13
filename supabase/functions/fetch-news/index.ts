import { createClient } from 'jsr:@supabase/supabase-js@2'

// Worker 5 - Ringkasan Berita (poin 9.5, 14.2, jalan 07:00 & 16:00 WIB).
const FEEDS: { url: string; source: string; category: 'domestic' | 'global' }[] = [
  { url: 'https://www.cnbcindonesia.com/market/rss', source: 'CNBC Indonesia', category: 'domestic' },
  { url: 'https://www.bisnis.com/rss/market', source: 'Bisnis.com', category: 'domestic' },
  { url: 'https://feeds.reuters.com/reuters/businessNews', source: 'Reuters', category: 'global' },
]

const FREE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
]

const SYSTEM_PROMPT =
  'Kamu meringkas berita pasar saham dalam 1-2 kalimat Bahasa Indonesia yang netral dan padat, ' +
  'lalu menentukan sentimen (positive, neutral, atau negative) untuk pasar/saham terkait. ' +
  'Balas HANYA JSON valid tanpa markdown, schema: {"summary": "...", "sentiment": "positive|neutral|negative"}'

const MAX_ITEMS_PER_FEED = 8
const REQUEST_TIMEOUT_MS = 15000

type FeedItem = { title: string; link: string; pubDate: string | null }

function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = block.match(re)
  if (!m) return null
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function parseRss(xml: string): FeedItem[] {
  const items: FeedItem[] = []
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? []
  for (const block of itemBlocks) {
    const title = extractTag(block, 'title')
    const link = extractTag(block, 'link')
    const pubDate = extractTag(block, 'pubDate')
    if (title && link) items.push({ title, link, pubDate })
  }
  return items.slice(0, MAX_ITEMS_PER_FEED)
}

async function fetchFeed(url: string): Promise<FeedItem[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return []
    const xml = await res.text()
    return parseRss(xml)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

async function summarizeAndTag(title: string, apiKey: string): Promise<{ summary: string; sentiment: string } | null> {
  for (const model of FREE_MODELS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://izyanalisai.vercel.app',
          'X-Title': 'IzyAnalisAI News Summary',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Judul berita: ${title}` },
          ],
          max_tokens: 200,
        }),
      })
      clearTimeout(timer)
      if (res.status === 429 || res.status === 402 || !res.ok) continue
      const data = await res.json()
      const raw = data?.choices?.[0]?.message?.content ?? ''
      const cleaned = raw.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(cleaned)
      if (!parsed.summary) continue
      const sentiment = ['positive', 'neutral', 'negative'].includes(parsed.sentiment) ? parsed.sentiment : 'neutral'
      return { summary: parsed.summary, sentiment }
    } catch {
      clearTimeout(timer)
      continue
    }
  }
  return null
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const apiKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'OPENROUTER_API_KEY belum di-set di Supabase Secrets' }), { status: 500 })
  }

  const { data: stocks } = await supabase.from('stocks').select('ticker').eq('is_active', true)
  const tickerSet = new Set((stocks ?? []).map((s) => s.ticker))

  let fetched = 0, inserted = 0, skippedDup = 0, failed = 0

  for (const feed of FEEDS) {
    const items = await fetchFeed(feed.url)
    fetched += items.length
    if (items.length === 0) continue

    const links = items.map((i) => i.link)
    const { data: existing } = await supabase.from('news').select('url').in('url', links)
    const existingSet = new Set((existing ?? []).map((e) => e.url))

    for (const item of items) {
      if (existingSet.has(item.link)) { skippedDup++; continue }
      try {
        const result = await summarizeAndTag(item.title, apiKey)
        if (!result) { failed++; continue }
        const relatedTickers = [...tickerSet].filter((t) => item.title.toUpperCase().includes(t))
        const { error: insErr } = await supabase.from('news').insert({
          title: item.title,
          summary: result.summary,
          source: feed.source,
          url: item.link,
          category: feed.category,
          sentiment: result.sentiment,
          related_tickers: relatedTickers,
          published_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
        })
        if (insErr) {
          if (insErr.message.includes('duplicate') || insErr.message.includes('unique')) skippedDup++
          else failed++
        } else {
          inserted++
        }
      } catch {
        failed++
      }
    }
  }

  return new Response(
    JSON.stringify({ fetched, inserted, skipped_duplicate: skippedDup, failed }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
