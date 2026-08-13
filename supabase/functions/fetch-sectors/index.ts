import { createClient } from 'jsr:@supabase/supabase-js@2'

// Backfill satu kali: ambil sector/industry per saham dari Yahoo Finance
// pakai endpoint search (tidak butuh crumb, beda dari quoteSummary yang sering diblokir).
const YAHOO_SEARCH_BASE = 'https://query2.finance.yahoo.com/v1/finance/search'
const CONCURRENCY = 8
const BATCH_DELAY_MS = 500

type StockRow = { id: string; ticker: string }

async function fetchSector(ticker: string): Promise<{ sector: string | null; debug?: string }> {
  const res = await fetch(
    `${YAHOO_SEARCH_BASE}?q=${ticker}.JK&quotesCount=1&newsCount=0`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } },
  )
  if (!res.ok) {
    return { sector: null, debug: `HTTP ${res.status}` }
  }
  const json = await res.json()
  const quote = json?.quotes?.[0]
  const sector = quote?.sector ?? quote?.sectorDisp ?? quote?.industry ?? quote?.industryDisp ?? null
  if (!sector) {
    return { sector: null, debug: `no sector field, quote keys: ${quote ? Object.keys(quote).join(',') : 'no quote'}` }
  }
  return { sector }
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: stocks, error } = await supabase
    .from('stocks')
    .select('id, ticker')
    .eq('is_active', true)

  if (error || !stocks) {
    return new Response(
      JSON.stringify({ error: error?.message ?? 'no stocks' }),
      { status: 500 },
    )
  }

  const sectorIdCache = new Map<string, string>()
  const { data: existingSectors } = await supabase.from('sectors').select('id, name')
  for (const s of existingSectors ?? []) sectorIdCache.set(s.name, s.id)

  async function getOrCreateSectorId(name: string): Promise<string> {
    const cached = sectorIdCache.get(name)
    if (cached) return cached
    const { data, error: insErr } = await supabase
      .from('sectors')
      .insert({ name })
      .select('id')
      .single()
    if (insErr || !data) throw new Error(`gagal insert sektor ${name}: ${insErr?.message}`)
    sectorIdCache.set(name, data.id)
    return data.id
  }

  let totalOk = 0
  let totalFailed = 0
  let totalNoSector = 0
  const debugSamples: Record<string, string> = {}

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = (stocks as StockRow[]).slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (s) => {
        const { sector, debug } = await fetchSector(s.ticker)
        return { stock: s, sector, debug }
      }),
    )

    for (const r of results) {
      if (r.status !== 'fulfilled') {
        totalFailed++
        debugSamples[`error-${totalFailed}`] = String(r.reason)
        continue
      }
      const { stock, sector, debug } = r.value
      if (!sector) {
        totalNoSector++
        if (debug && Object.keys(debugSamples).length < 5) {
          debugSamples[stock.ticker] = debug
        }
        continue
      }
      try {
        const sectorId = await getOrCreateSectorId(sector)
        const { error: updErr } = await supabase
          .from('stocks')
          .update({ sector_id: sectorId })
          .eq('id', stock.id)
        if (updErr) throw updErr
        totalOk++
      } catch (e) {
        totalFailed++
        debugSamples[stock.ticker] = String(e)
      }
    }

    if (i + CONCURRENCY < stocks.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
    }
  }

  return new Response(
    JSON.stringify({
      total: stocks.length,
      ok: totalOk,
      no_sector: totalNoSector,
      failed: totalFailed,
      sectors_created: sectorIdCache.size,
      debug_samples: debugSamples,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
