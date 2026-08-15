import { createClient } from 'jsr:@supabase/supabase-js@2'
import { classifySignalStatus, type SignalInput } from './logic.ts'

// Worker 3 - Evaluate TP/SL/Expiry (poin 10.9 & 14.2).
// Logic klasifikasi status dipisah ke logic.ts supaya bisa di-unit-test
// (lihat logic.test.ts) tanpa perlu koneksi Supabase asli.

type SignalRow = {
  id: string; stock_id: string; direction: 'BUY' | 'SELL' | 'HOLD'
  tp1: number | null; tp2: number | null; stop_loss: number | null
  status: string; expires_at: string | null
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

  const { data: signals, error: sigErr } = await supabase
    .from('signals')
    .select('id, stock_id, direction, tp1, tp2, stop_loss, status, expires_at')
    .in('status', ['ACTIVE', 'HIT_TP1'])
    .is('superseded_by', null)
    .limit(2000)

  if (sigErr) {
    return new Response(JSON.stringify({ error: sigErr.message }), { status: 500 })
  }
  if (!signals || signals.length === 0) {
    return new Response(JSON.stringify({ evaluated: 0, transitions: {} }), { headers: { 'Content-Type': 'application/json' } })
  }

  const stockIds = [...new Set((signals as SignalRow[]).map((s) => s.stock_id))]

  const QUOTE_CHUNK_SIZE = 150
  const priceMap = new Map<string, number>()
  for (let i = 0; i < stockIds.length; i += QUOTE_CHUNK_SIZE) {
    const idChunk = stockIds.slice(i, i + QUOTE_CHUNK_SIZE)
    const { data: quotes, error: qErr } = await supabase
      .from('quotes')
      .select('stock_id, price')
      .in('stock_id', idChunk)

    if (qErr) {
      return new Response(JSON.stringify({ error: qErr.message }), { status: 500 })
    }
    for (const q of quotes ?? []) {
      if (q.price != null) priceMap.set(q.stock_id, Number(q.price))
    }
  }

  const now = new Date()
  const updatesByStatus = new Map<string, string[]>()
  let noPriceCount = 0

  for (const s of signals as SignalRow[]) {
    const price = priceMap.get(s.stock_id)
    if (price == null) { noPriceCount++; continue }

    const newStatus = classifySignalStatus(s as unknown as SignalInput, price, now)

    if (newStatus !== s.status) {
      const list = updatesByStatus.get(newStatus) ?? []
      list.push(s.id)
      updatesByStatus.set(newStatus, list)
    }
  }

  const CHUNK_SIZE = 200
  const transitions: Record<string, number> = {}
  for (const [status, ids] of updatesByStatus) {
    let okCount = 0
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE)
      try {
        const { error: updErr } = await supabase
          .from('signals')
          .update({ status, resolved_at: now.toISOString() })
          .in('id', chunk)
        if (!updErr) okCount += chunk.length
      } catch (_e) {
        // chunk gagal, skip - tidak mempengaruhi chunk lain
      }
    }
    transitions[status] = okCount
  }

  return new Response(
    JSON.stringify({
      evaluated: signals.length,
      no_price_data: noPriceCount,
      transitions,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
