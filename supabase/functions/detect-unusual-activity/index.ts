import { createClient } from 'jsr:@supabase/supabase-js@2'

// Worker 10 - Unusual Activity Detector (poin 5.8, 10.9 gaya, 14.2).
// Jalan tiap 5 menit saat sesi pasar. Volume > 3x rata-rata 20 hari
// & harga bergerak > 2% -> catat ke unusual_activities + notif ke
// user Premium yang mengaktifkan unusual_activity_alert (fitur 7.2).
//
// Section 70 INTELLIGENCE NETWORK CONTRACT: setiap deteksi wajib bisa
// dijelaskan dengan baseline/observed_value/threshold/formula/window/
// data_source/timestamp - bukan sekadar label "bandar masuk" tanpa bukti.

const VOLUME_MULTIPLIER_THRESHOLD = 3
const PRICE_CHANGE_THRESHOLD_PCT = 2
const BASELINE_WINDOW = '20D'
const DATA_SOURCE = 'yahoo_finance'

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: quotes, error: qErr } = await supabase
    .from('quotes')
    .select('stock_id, price, previous_close, volume')
    .not('volume', 'is', null)
    .limit(2000)
  if (qErr) return new Response(JSON.stringify({ error: qErr.message }), { status: 500 })

  const { data: indicators, error: iErr } = await supabase
    .from('indicators')
    .select('stock_id, volume_avg20, ts')
    .eq('timeframe', 'D1')
    .not('volume_avg20', 'is', null)
    .order('ts', { ascending: false })
    .limit(4000)
  if (iErr) return new Response(JSON.stringify({ error: iErr.message }), { status: 500 })

  const avgMap = new Map<string, number>()
  for (const row of indicators ?? []) {
    if (!avgMap.has(row.stock_id)) avgMap.set(row.stock_id, Number(row.volume_avg20))
  }

  const detections: { stock_id: string; price: number; volume: number; avg: number; changePct: number }[] = []

  for (const q of quotes ?? []) {
    const avg = avgMap.get(q.stock_id)
    if (!avg || avg <= 0 || q.price == null || q.previous_close == null) continue
    const volume = Number(q.volume)
    const price = Number(q.price)
    const prevClose = Number(q.previous_close)
    if (prevClose === 0) continue

    const changePct = ((price - prevClose) / prevClose) * 100
    if (volume > avg * VOLUME_MULTIPLIER_THRESHOLD && Math.abs(changePct) > PRICE_CHANGE_THRESHOLD_PCT) {
      detections.push({ stock_id: q.stock_id, price, volume, avg, changePct })
    }
  }

  if (detections.length === 0) {
    return new Response(JSON.stringify({ detected: 0 }), { headers: { 'Content-Type': 'application/json' } })
  }

  // Dedup: skip kalau sudah tercatat untuk stock yang sama dalam 30 menit terakhir
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const { data: recent } = await supabase
    .from('unusual_activities')
    .select('stock_id')
    .gt('timestamp', cutoff)
    .in('stock_id', detections.map((d) => d.stock_id))
  const recentSet = new Set((recent ?? []).map((r) => r.stock_id))
  const fresh = detections.filter((d) => !recentSet.has(d.stock_id))

  if (fresh.length === 0) {
    return new Response(JSON.stringify({ detected: detections.length, inserted: 0, deduped: true }), { headers: { 'Content-Type': 'application/json' } })
  }

  const rows = fresh.map((d) => {
    const multiplier = Number((d.volume / d.avg).toFixed(2))
    return {
      stock_id: d.stock_id, price: d.price, volume: d.volume,
      avg_volume_20d: d.avg, price_change_percent: Number(d.changePct.toFixed(2)),
      severity: Math.abs(d.changePct) > 5 ? 'HIGH' : Math.abs(d.changePct) > 3 ? 'MEDIUM' : 'LOW',
      // section 70: explainability wajib - baseline/threshold/formula/window/data_source
      baseline: d.avg,
      threshold: VOLUME_MULTIPLIER_THRESHOLD,
      formula: `volume(${d.volume}) > baseline(${d.avg}) x ${VOLUME_MULTIPLIER_THRESHOLD} AND abs(price_change_pct) > ${PRICE_CHANGE_THRESHOLD_PCT}% -- observed multiplier: ${multiplier}x`,
      window_label: BASELINE_WINDOW,
      data_source: DATA_SOURCE,
    }
  })
  const { data: inserted, error: insErr } = await supabase.from('unusual_activities').insert(rows).select('id, stock_id, price_change_percent, volume')
  if (insErr) return new Response(JSON.stringify({ error: insErr.message }), { status: 500 })

  // Notif real-time hanya untuk user Premium + toggle unusual_activity_alert aktif (poin 7.2)
  const { data: recipients } = await supabase
    .from('profiles')
    .select('id, notification_preferences!inner(master_enabled, unusual_activity_alert)')
    .eq('is_premium', true)
    .eq('notification_preferences.master_enabled', true)
    .eq('notification_preferences.unusual_activity_alert', true)

  let notified = 0
  if (recipients && recipients.length > 0 && inserted) {
    for (const act of inserted) {
      const notifRows = recipients.map((r) => ({
        user_id: r.id, category: 'UNUSUAL_ACTIVITY',
        title: 'Volume Tidak Wajar Terdeteksi',
        body: `Volume ${act.volume}, pergerakan harga ${act.price_change_percent}%.`,
        reference_id: act.stock_id, event_id: `unusual:${act.id}:${r.id}`,
      }))
      const { error: nErr } = await supabase.from('notifications').insert(notifRows)
      if (!nErr) notified += notifRows.length
    }
  }

  return new Response(JSON.stringify({ detected: detections.length, inserted: fresh.length, notified }), { headers: { 'Content-Type': 'application/json' } })
})
