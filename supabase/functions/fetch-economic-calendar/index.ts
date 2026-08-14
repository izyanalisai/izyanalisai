import { createClient } from 'jsr:@supabase/supabase-js@2'

// Worker - Kalender Ekonomi (spec 5.10).
// Sumber: feed publik ForexFactory (nfs.faireconomy.media), gratis, tanpa API key.
// Rate limit sumber: maksimal ~2 request/5 menit -- jangan panggil worker ini lebih sering dari itu.
const FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'

interface FFEvent {
  title: string
  country: string
  date: string
  impact: 'High' | 'Medium' | 'Low' | 'Holiday' | string
  forecast?: string
  previous?: string
  actual?: string
}

function mapImpact(raw: string): 'high' | 'medium' | 'low' {
  const r = raw.toLowerCase()
  if (r === 'high') return 'high'
  if (r === 'medium') return 'medium'
  return 'low'
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

  let events: FFEvent[]
  try {
    const res = await fetch(FEED_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    events = await res.json()
  } catch (e) {
    return new Response(JSON.stringify({ error: `gagal ambil feed: ${String(e)}` }), { status: 502 })
  }

  if (!Array.isArray(events)) {
    return new Response(JSON.stringify({ error: 'format feed tidak dikenali' }), { status: 502 })
  }

  const rows = events
    .filter((e) => e.title && e.date && e.country && e.impact !== 'Holiday')
    .map((e) => {
      const dt = new Date(e.date)
      return {
        event_name: e.title,
        country: e.country,
        event_date: dt.toISOString().slice(0, 10),
        event_time: dt.toISOString().slice(11, 19),
        impact: mapImpact(e.impact),
        forecast: e.forecast || null,
        previous: e.previous || null,
        actual: e.actual || null,
      }
    })

  let ok = 0
  let failed = 0
  const errorSamples: string[] = []

  for (const row of rows) {
    const { error } = await supabase
      .from('economic_events')
      .upsert(row, { onConflict: 'event_name,country,event_date' })
    if (error) {
      failed++
      if (errorSamples.length < 3) errorSamples.push(error.message)
    } else {
      ok++
    }
  }

  return new Response(
    JSON.stringify({ total: rows.length, ok, failed, error_samples: errorSamples }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
