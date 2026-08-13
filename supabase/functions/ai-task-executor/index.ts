import { createClient } from 'jsr:@supabase/supabase-js@2'

// Worker 9 - AI Task Executor (poin 5.14 & 14.2, jalan tiap 5 menit 24/7).
// Mengeksekusi 4 jenis tugas: PRICE_ALERT, LEVEL_RETEST, DAILY_SUMMARY, UNUSUAL_VOLUME.
// PRICE_ALERT & LEVEL_RETEST: one-shot -> status DONE setelah trigger.
// DAILY_SUMMARY & UNUSUAL_VOLUME: recurring -> tetap ACTIVE, last_run diperbarui.

type Task = {
  id: string; user_id: string; task_type: string
  parameters: Record<string, string>; last_run: string | null
}

function todayWIB(d = new Date()) {
  return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10)
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: tasks, error } = await supabase
    .from('ai_tasks')
    .select('id, user_id, task_type, parameters, last_run')
    .eq('is_active', true)
    .eq('status', 'ACTIVE')
    .limit(500)

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  if (!tasks || tasks.length === 0) {
    return new Response(JSON.stringify({ processed: 0 }), { headers: { 'Content-Type': 'application/json' } })
  }

  // Preload preferensi notifikasi semua user yang punya task
  const userIds = [...new Set((tasks as Task[]).map((t) => t.user_id))]
  const { data: prefs } = await supabase
    .from('notification_preferences')
    .select('user_id, master_enabled, signal_alerts, morning_briefing, unusual_activity_alert')
    .in('user_id', userIds)
  const prefMap = new Map((prefs ?? []).map((p) => [p.user_id, p]))

  function allowed(userId: string, key: 'signal_alerts' | 'morning_briefing' | 'unusual_activity_alert') {
    const p = prefMap.get(userId)
    if (!p) return true // default ON kalau belum ada row preferensi
    return p.master_enabled !== false && p[key] !== false
  }

  let fired = 0, checked = 0, failed = 0

  for (const t of tasks as Task[]) {
    checked++
    try {
      if (t.task_type === 'PRICE_ALERT') {
        const ticker = t.parameters?.ticker
        const target = Number(t.parameters?.target_price)
        const dir = t.parameters?.direction // 'above' | 'below'
        if (!ticker || !Number.isFinite(target)) continue

        const { data: stock } = await supabase.from('stocks').select('id, name').eq('ticker', ticker).maybeSingle()
        if (!stock) continue
        const { data: quote } = await supabase.from('quotes').select('price').eq('stock_id', stock.id).maybeSingle()
        if (!quote?.price) continue

        const price = Number(quote.price)
        const hit = dir === 'below' ? price <= target : price >= target

        if (hit && allowed(t.user_id, 'signal_alerts')) {
          await supabase.from('notifications').insert({
            user_id: t.user_id, category: 'MARKET',
            title: `${ticker} ${dir === 'below' ? 'di bawah' : 'di atas'} ${target}`,
            body: `Harga ${ticker} sekarang ${price}. DYOR sebelum eksekusi.`,
            reference_id: stock.id, event_id: `ai_task:${t.id}:price_alert`,
          })
          await supabase.from('ai_tasks').update({ status: 'DONE', is_active: false, last_run: new Date().toISOString() }).eq('id', t.id)
          fired++
        }
      }

      else if (t.task_type === 'LEVEL_RETEST') {
        const ticker = t.parameters?.ticker
        const level = Number(t.parameters?.level)
        const tolerancePct = Number(t.parameters?.tolerance_pct ?? '1')
        if (!ticker || !Number.isFinite(level)) continue

        const { data: stock } = await supabase.from('stocks').select('id').eq('ticker', ticker).maybeSingle()
        if (!stock) continue
        const { data: quote } = await supabase.from('quotes').select('price').eq('stock_id', stock.id).maybeSingle()
        if (!quote?.price) continue

        const price = Number(quote.price)
        const diffPct = Math.abs(price - level) / level * 100
        // NOTE: ini baru deteksi "harga menyentuh level", bukan "retest + bounce"
        // penuh (butuh histori intraday berturut-turut). Cukup untuk MVP.
        if (diffPct <= tolerancePct && allowed(t.user_id, 'signal_alerts')) {
          await supabase.from('notifications').insert({
            user_id: t.user_id, category: 'MARKET',
            title: `${ticker} retest level ${level}`,
            body: `Harga ${ticker} sekarang ${price}, dekat level ${level}. DYOR.`,
            reference_id: stock.id, event_id: `ai_task:${t.id}:level_retest`,
          })
          await supabase.from('ai_tasks').update({ status: 'DONE', is_active: false, last_run: new Date().toISOString() }).eq('id', t.id)
          fired++
        }
      }

      else if (t.task_type === 'DAILY_SUMMARY') {
        const today = todayWIB()
        const lastRunDay = t.last_run ? todayWIB(new Date(t.last_run)) : null
        if (lastRunDay === today) continue // sudah kirim hari ini

        const { data: idx } = await supabase.from('market_index').select('*').eq('ticker', '^JKSE').maybeSingle()
        const changeTxt = idx?.previous_close && idx?.value != null
          ? `${(Number(idx.value) - Number(idx.previous_close)) >= 0 ? '+' : ''}${(Number(idx.value) - Number(idx.previous_close)).toFixed(2)} poin`
          : 'data belum tersedia'

        if (allowed(t.user_id, 'morning_briefing')) {
          await supabase.from('notifications').insert({
            user_id: t.user_id, category: 'MORNING_BRIEFING',
            title: 'Ringkasan Pasar Pagi Ini',
            body: idx ? `IHSG ${idx.value} (${changeTxt}). Cek Home untuk detail sinyal & berita.` : 'Data IHSG belum tersedia pagi ini.',
            event_id: `ai_task:${t.id}:daily_summary:${today}`,
          })
        }
        await supabase.from('ai_tasks').update({ last_run: new Date().toISOString() }).eq('id', t.id)
        fired++
      }

      else if (t.task_type === 'UNUSUAL_VOLUME') {
        const ticker = t.parameters?.ticker || null
        const since = t.last_run ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString()

        let query = supabase.from('unusual_activities').select('id, stock_id, price, volume, price_change_percent, timestamp').gt('timestamp', since).order('timestamp', { ascending: false }).limit(5)
        if (ticker) {
          const { data: stock } = await supabase.from('stocks').select('id').eq('ticker', ticker).maybeSingle()
          if (stock) query = query.eq('stock_id', stock.id)
          else { await supabase.from('ai_tasks').update({ last_run: new Date().toISOString() }).eq('id', t.id); continue }
        }
        const { data: activities } = await query

        if (activities && activities.length > 0 && allowed(t.user_id, 'unusual_activity_alert')) {
          for (const a of activities) {
            await supabase.from('notifications').insert({
              user_id: t.user_id, category: 'UNUSUAL_ACTIVITY',
              title: 'Volume Tidak Wajar Terdeteksi',
              body: `Volume ${a.volume} (${a.price_change_percent}% pergerakan harga).`,
              reference_id: a.stock_id, event_id: `ai_task:${t.id}:unusual:${a.id}`,
            })
          }
          fired++
        }
        await supabase.from('ai_tasks').update({ last_run: new Date().toISOString() }).eq('id', t.id)
      }
    } catch (_e) {
      failed++
    }
  }

  return new Response(JSON.stringify({ checked, fired, failed }), { headers: { 'Content-Type': 'application/json' } })
})
