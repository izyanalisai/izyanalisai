import { createClient } from 'jsr:@supabase/supabase-js@2'
import { DOMParser } from 'jsr:@b-fuze/deno-dom'

// Worker 8 (bagian IPO) — bagian earnings sudah dikerjakan fetch-earnings-calendar.
// Sumber: e-ipo.co.id — situs resmi bersama OJK/IDX/KPEI/KSEI untuk pipeline
// penawaran umum saham. Tidak ada JSON API publik, jadi worker ini parse HTML
// halaman listing (server-rendered, bukan SPA) yang selalu diurutkan dari IPO
// terbaru ke terlama.
const EIPO_BASE = 'https://e-ipo.co.id/id/ipo/index'
const PAGES_TO_SCAN = 3
const MONTH_ID: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

type IpoRow = {
  company_name: string
  ticker: string | null
  listing_date: string | null
  price_range_low: number | null
  price_range_high: number | null
  status: 'UPCOMING' | 'OPEN' | 'CLOSED' | 'LISTED' | 'CANCELLED'
}

function parseTanggalPencatatan(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/)
  if (!m) return null
  const [, day, monRaw, year] = m
  const mon = MONTH_ID[monRaw.toLowerCase()]
  if (!mon) return null
  return `${year}-${mon}-${day.padStart(2, '0')}`
}

function parseHarga(text: string): { low: number | null; high: number | null } {
  const nums = [...text.matchAll(/Rp\s*([\d.]+)/g)].map((m) => Number(m[1].replace(/\./g, '')))
  if (nums.length === 0) return { low: null, high: null }
  if (nums.length === 1) return { low: nums[0], high: nums[0] }
  return { low: Math.min(...nums), high: Math.max(...nums) }
}

function mapStatus(headerText: string): IpoRow['status'] {
  const t = headerText.trim().toLowerCase()
  if (t.includes('closed')) return 'LISTED'
  if (t.includes('cancel') || t.includes('postpone')) return 'CANCELLED'
  if (t.includes('offering') && !t.includes('waiting')) return 'OPEN'
  if (t.includes('waiting for offering') || t.includes('book building') || t.includes('pre-effective')) return 'UPCOMING'
  if (t.includes('allotment')) return 'OPEN'
  return 'UPCOMING'
}

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
}

async function fetchPage(page: number): Promise<IpoRow[]> {
  const url = page <= 1 ? EIPO_BASE : `${EIPO_BASE}?page=${page}&per-page=12`
  const res = await fetch(url, { headers: BROWSER_HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`)
  const html = await res.text()
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (!doc) throw new Error(`gagal parse HTML halaman ${page}`)

  const rows: IpoRow[] = []
  const links = doc.querySelectorAll('a')
  for (const a of Array.from(links)) {
    const href = a.getAttribute('href') ?? ''
    if (!href.match(/\/id\/ipo\/\d+\//)) continue

    let container: Element | null = a.parentElement
    let hops = 0
    while (container && hops < 6) {
      const txt = container.textContent ?? ''
      if (txt.includes('Tanggal Pencatatan') || txt.includes('Periode Book Building')) break
      container = container.parentElement
      hops++
    }
    if (!container) continue
    const block = container.textContent ?? ''

    const nameTickerMatch = block.match(/([A-Z][A-Za-z0-9.,'&\s]+?)\s*\(([A-Z]{4})\)/)
    if (!nameTickerMatch) continue
    const companyName = nameTickerMatch[1].trim()
    const ticker = nameTickerMatch[2].trim()

    const tglMatch = block.match(/Tanggal Pencatatan\s*([\d]{1,2}\s+[A-Za-z]{3}\s+\d{4})/)
    const listingDate = tglMatch ? parseTanggalPencatatan(tglMatch[1]) : null

    const hargaMatch = block.match(/(?:Harga Final|Rentang Harga Book Building)\s*(Rp[\s\d.\-Rp]+)/)
    const { low, high } = hargaMatch ? parseHarga(hargaMatch[1]) : { low: null, high: null }

    const statusMatch = block.match(/^(Closed|Offering|Book Building|Waiting For Offering|Allotment|Postpone|Canceled|Pre-Effective)/)
    const status = mapStatus(statusMatch ? statusMatch[1] : 'Closed')

    rows.push({
      company_name: companyName,
      ticker,
      listing_date: listingDate,
      price_range_low: low,
      price_range_high: high,
      status,
    })
  }

  return rows
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

  let allRows: IpoRow[] = []
  const errorSamples: Record<string, string> = {}

  for (let page = 1; page <= PAGES_TO_SCAN; page++) {
    try {
      const rows = await fetchPage(page)
      allRows = allRows.concat(rows)
    } catch (e) {
      errorSamples[`page-${page}`] = String(e)
    }
    if (page < PAGES_TO_SCAN) await new Promise((r) => setTimeout(r, 300))
  }

  const seen = new Set<string>()
  const dedup = allRows.filter((r) => {
    const key = `${r.ticker}-${r.listing_date}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  let totalOk = 0
  let totalFailed = 0

  for (const row of dedup) {
    const { error: upsertError } = await supabase
      .from('ipo_calendar')
      .upsert(
        {
          company_name: row.company_name,
          ticker: row.ticker,
          opening_date: null,
          closing_date: null,
          listing_date: row.listing_date,
          price_range_low: row.price_range_low,
          price_range_high: row.price_range_high,
          status: row.status,
        },
        { onConflict: 'ticker' },
      )
    if (upsertError) {
      totalFailed++
      errorSamples[row.ticker ?? row.company_name] = upsertError.message
    } else {
      totalOk++
    }
  }

  return new Response(
    JSON.stringify({
      pages_scanned: PAGES_TO_SCAN,
      total_found: allRows.length,
      total_dedup: dedup.length,
      ok: totalOk,
      failed: totalFailed,
      error_samples: errorSamples,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
