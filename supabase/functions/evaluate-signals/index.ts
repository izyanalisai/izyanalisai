import { createClient } from 'jsr:@supabase/supabase-js@2'

// Worker 3 - Evaluate TP/SL/Expiry (poin 10.9 & 14.2).
// Sinyal ACTIVE atau HIT_TP1 (belum terminal) dicek terhadap harga terkini di tabel quotes.
// Terminal state: HIT_TP2, HIT_SL, EXPIRED, INVALIDATED — tidak dievaluasi ulang.

type SignalRow = {
  id: string; stock_id: string; direction: 'BUY' | 'SELL' | 'HOLD'
  tp1: number | null; tp2: number | null; stop_loss: number | null
  status: string; expires_at: string | null
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

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

  // Query quotes per-chunk. .in() dikirim via GET dan stockIds di-embed di URL query
  // string — kalau jumlah saham banyak, URL bisa kepanjangan dan kena HTTP/2 header
  // size limit di proxy Supabase (muncul sebagai "stream error: Protocol error").
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

    let newStatus = s.status

    if (s.expires_at && new Date(s.expires_at) < now) {
      newStatus = 'EXPIRED'
    } else if (s.direction === 'BUY') {
      if (s.stop_loss != null && price <= s.stop_loss) newStatus = 'HIT_SL'
      else if (s.tp2 != null && price >= s.tp2) newStatus = 'HIT_TP2'
      else if (s.tp1 != null && price >= s.tp1 && s.status !== 'HIT_TP1') newStatus = 'HIT_TP1'
    } else if (s.direction === 'SELL') {
      if (s.stop_loss != null && price >= s.stop_loss) newStatus = 'HIT_SL'
      else if (s.tp2 != null && price <= s.tp2) newStatus = 'HIT_TP2'
      else if (s.tp1 != null && price <= s.tp1 && s.status !== 'HIT_TP1') newStatus = 'HIT_TP1'
    }

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
          .update({ status, triggered_at: now.toISOString() })
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
