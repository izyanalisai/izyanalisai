import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import * as cheerio from 'cheerio'

// Worker fetch-ipo-calendar — DIPINDAH dari Supabase Edge Function ke Railway
// (19 Agustus 2026) karena IP Supabase Edge Function mulai diblokir 403 oleh
// e-ipo.co.id. Logic parsing sama persis dengan versi Deno sebelumnya, cuma
// deno-dom diganti cheerio (setara di Node) dan dijalankan di Next.js API
// route (Node runtime) yang berjalan di Railway, bukan lagi di edge function.
//
// Auth: sama seperti worker lain — header x-worker-secret dicocokkan dengan
// tabel internal_secrets.worker_shared_secret di Supabase.

export const runtime = 'nodejs' // WAJIB Node runtime (bukan edge) supaya IP-nya beda dari Vercel Edge

const EIPO_BASE = 'https://e-ipo.co.id/id/ipo/index?view=list'
const PAGES_TO_SCAN = 3
const JOB_NAME = 'fetch-ipo-calendar'

const MONTH_ID: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
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

function mapStatus(rawStatus: string): string {
  const t = (rawStatus ?? '').trim().toLowerCase()
  if (t.includes('closed')) return 'LISTED'
  if (t.includes('cancel') || t.includes('postpone')) return 'CANCELLED'
  if (t.includes('offering') && !t.includes('waiting')) return 'OPEN'
  if (t.includes('waiting for offering') || t.includes('book building') || t.includes('pre-effective')) return 'UPCOMING'
  if (t.includes('allotment')) return 'OPEN'
  return 'UPCOMING'
}

type IpoRow = {
  company_name: string
  ticker: string
  listing_date: string | null
  price_range_low: number | null
  price_range_high: number | null
  status: string
}

async function fetchPage(page: number): Promise<IpoRow[]> {
  const url = page <= 1 ? EIPO_BASE : `${EIPO_BASE}&page=${page}&per-page=12`
  const res = await fetch(url, { headers: BROWSER_HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`)
  const html = await res.text()
  const $ = cheerio.load(html)
  const rows: IpoRow[] = []

  $('h3').each((_, h3el) => {
    const h3 = $(h3el)
    const titleText = h3.text().trim()
    const titleMatch = titleText.match(/^(.+?)\s*\(([A-Z]{4})\)\s*(.*)$/)
    if (!titleMatch) return
    const companyName = titleMatch[1].trim()
    const ticker = titleMatch[2].trim()
    const statusRaw = titleMatch[3].trim()

    // Kumpulkan teks dari sibling setelah h3 sampai h3 berikutnya (field
    // Sektor/Tanggal Pencatatan/Harga Final berupa heading h5 + teks terpisah).
    let block = ''
    let node = h3.next()
    let guard = 0
    while (node.length && guard < 40) {
      if (node.is('h3')) break
      block += node.text() + '\n'
      node = node.next()
      guard++
    }

    const tglMatch = block.match(/Tanggal Pencatatan\s*\n?\s*([\d]{1,2}\s+[A-Za-z]{3}\s+\d{4})/)
    const listingDate = tglMatch ? parseTanggalPencatatan(tglMatch[1]) : null
    const hargaMatch = block.match(/(?:Harga Final|Rentang Harga Book Building)\s*\n?\s*(Rp[\s\d.\-Rp]+)/)
    const { low, high } = hargaMatch ? parseHarga(hargaMatch[1]) : { low: null, high: null }
    const status = mapStatus(statusRaw)

    rows.push({ company_name: companyName, ticker, listing_date: listingDate, price_range_low: low, price_range_high: high, status })
  })

  return rows
}

async function logJobRun(supabase: ReturnType<typeof createClient>, status: string, detail: Record<string, unknown>, startedAt: string) {
  try {
    await supabase.from('job_runs').insert({
      job_name: JOB_NAME,
      status,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      detail,
    })
  } catch (e) {
    console.error('gagal menulis job_runs', String(e))
  }
}

export async function POST(req: NextRequest) {
  const startedAt = new Date().toISOString()
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  const providedSecret = req.headers.get('x-worker-secret')
  const { data: secretRow, error: secretError } = await supabase
    .from('internal_secrets')
    .select('value')
    .eq('key', 'worker_shared_secret')
    .maybeSingle()

  if (secretError) {
    await logJobRun(supabase, 'ERROR', { stage: 'auth', message: secretError.message }, startedAt)
    return NextResponse.json({ error: 'gagal cek worker secret', detail: secretError.message }, { status: 500 })
  }
  if (!providedSecret || !secretRow || providedSecret !== (secretRow as { value: string }).value) {
    await logJobRun(supabase, 'ERROR', { stage: 'auth', message: 'unauthorized' }, startedAt)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
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
    const { error: upsertError } = await supabase.from('ipo_calendar').upsert(
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
      { onConflict: 'ticker' }
    )
    if (upsertError) {
      totalFailed++
      errorSamples[row.ticker ?? row.company_name] = upsertError.message
    } else {
      totalOk++
    }
  }

  const summary = {
    pages_scanned: PAGES_TO_SCAN,
    total_found: allRows.length,
    total_dedup: dedup.length,
    ok: totalOk,
    failed: totalFailed,
    error_samples: errorSamples,
  }

  const jobStatus = allRows.length === 0 ? 'ERROR' : 'SUCCESS'
  await logJobRun(supabase, jobStatus, summary, startedAt)

  return NextResponse.json(summary)
      }
