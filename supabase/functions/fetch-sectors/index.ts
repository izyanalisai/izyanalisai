import { createClient } from 'jsr:@supabase/supabase-js@2'

// Backfill satu kali: ambil sector/industry per saham dari Yahoo Finance
// (module assetProfile, tidak bisa di-batch seperti quote, jadi per-ticker).
const YAHOO_PROFILE_BASE = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary/'
const CONCURRENCY = 10
const BATCH_DELAY_MS = 400

type StockRow = { id: string; ticker: string }

async function fetchSector(ticker: string) {
  const res = await fetch(
    `${YAHOO_PROFILE_BASE}${ticker}.JK?modules=assetProfile`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } },
  )
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`)
  const json = await res.json()
  const profile = json?.quoteSummary?.result?.[0]?.assetProfile
  const sector = profile?.sector ?? null
  return sector as string | null
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

  // Cache nama sektor -> id supaya tidak insert duplikat & tidak query berulang
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

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = (stocks as StockRow[]).slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (s) => {
        const sector = await fetchSector(s.ticker)
        return { stock: s, sector }
      }),
    )

    for (const r of results) {
      if (r.status !== 'fulfilled') {
        totalFailed++
        continue
      }
      const { stock, sector } = r.value
      if (!sector) {
        totalNoSector++
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
        console.error(`update sector gagal untuk ${stock.ticker}`, e)
        totalFailed++
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
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
