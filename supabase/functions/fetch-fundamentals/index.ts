import { createClient } from 'jsr:@supabase/supabase-js@2'

const YAHOO_QUOTESUMMARY_BASE = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary'
const CONCURRENCY = 8
const BATCH_DELAY_MS = 400

type StockRow = { id: string; ticker: string }

async function getCrumb(): Promise<{ crumb: string; cookie: string }> {
  const cookieRes = await fetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    redirect: 'manual',
  })
  const setCookie = cookieRes.headers.get('set-cookie')
  if (!setCookie) throw new Error('no set-cookie from fc.yahoo.com')
  const cookie = setCookie.split(';')[0]

  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookie },
  })
  const crumb = (await crumbRes.text()).trim()
  if (!crumb || crumb.length > 50 || crumb.includes('<')) {
    throw new Error(`gagal ambil crumb: ${crumb.slice(0, 100)}`)
  }
  return { crumb, cookie }
}

async function fetchFundamentals(ticker: string, crumb: string, cookie: string) {
  const res = await fetch(
    `${YAHOO_QUOTESUMMARY_BASE}/${ticker}.JK?modules=defaultKeyStatistics,summaryDetail,price&crumb=${encodeURIComponent(crumb)}`,
    { headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookie } },
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  const result = json?.quoteSummary?.result?.[0]
  if (!result) throw new Error('no quoteSummary result')

  const stats = result.defaultKeyStatistics ?? {}
  const summary = result.summaryDetail ?? {}
  const price = result.price ?? {}

  return {
    pe_ratio: summary.trailingPE?.raw ?? null,
    pb_ratio: stats.priceToBook?.raw ?? null,
    net_profit: stats.netIncomeToCommon?.raw ?? null,
    market_cap: price.marketCap?.raw ?? summary.marketCap?.raw ?? null,
  }
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const providedSecret = req.headers.get('x-worker-secret')
  const { data: secretRow } = await supabase.from('internal_secrets').select('value').eq('key', 'worker_shared_secret').maybeSingle()
  if (!providedSecret || !secretRow || providedSecret !== secretRow.value) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  let crumb: string
  let cookie: string
  try {
    const c = await getCrumb()
    crumb = c.crumb
    cookie = c.cookie
  } catch (e) {
    return new Response(JSON.stringify({ error: `gagal setup crumb: ${String(e)}` }), { status: 502 })
  }

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

  let totalOk = 0
  let totalFailed = 0
  const errorSamples: Record<string, string> = {}

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = (stocks as StockRow[]).slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (s) => ({ stock: s, data: await fetchFundamentals(s.ticker, crumb, cookie) })),
    )

    const rows = []
    for (const r of results) {
      if (r.status !== 'fulfilled') {
        totalFailed++
        errorSamples[`idx-${totalFailed}`] = String(r.reason)
        continue
      }
      const { stock, data } = r.value
      rows.push({
        stock_id: stock.id,
        pe_ratio: data.pe_ratio,
        pb_ratio: data.pb_ratio,
        net_profit: data.net_profit,
        market_cap: data.market_cap,
        updated_at: new Date().toISOString(),
      })
    }

    if (rows.length > 0) {
      const { error: upsertError } = await supabase
        .from('fundamentals')
        .upsert(rows, { onConflict: 'stock_id' })
      if (upsertError) {
        console.error('upsert error', upsertError)
        errorSamples['upsert'] = upsertError.message
        totalFailed += rows.length
      } else {
        totalOk += rows.length
      }
    }

    if (i + CONCURRENCY < stocks.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
    }
  }

  return new Response(
    JSON.stringify({ total: stocks.length, ok: totalOk, failed: totalFailed, error_samples: errorSamples }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
