'use client'

import { createClient } from '@/lib/supabase/client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

type HistoryItem = {
  id: string
  ticker: string
  stock_name: string
  direction: 'BUY' | 'SELL'
  timeframe: string
  signal_tier: 'daily' | 'swing'
  status: string
  created_at: string
  resolved_at: string | null
  result: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'INVALID' | null
  unlocked: boolean
  entry_price: number | null
  tp1: number | null
  tp2: number | null
  stop_loss: number | null
}

// Catatan: result (WIN/LOSS/dst) di sini murni status akhir sinyal
// tersebut sendiri, bukan agregat performa. Win Rate / Avg R gabungan
// sengaja TIDAK ditampilkan ke user (dokumen 10.6-10.7 & 22.7) — itu
// dashboard internal tim, bukan fitur produk.

const tierLabel: Record<string, string> = {
  daily: 'Daily',
  swing: 'Swing',
}

const TIER_FILTERS: { value: '' | 'daily' | 'swing'; label: string }[] = [
  { value: '', label: 'Semua Tier' },
  { value: 'daily', label: 'Daily' },
  { value: 'swing', label: 'Swing' },
]

const STATUS_FILTERS = [
  { value: '', label: 'Semua' },
  { value: 'HIT_TP1', label: 'TP1' },
  { value: 'HIT_TP2', label: 'TP2' },
  { value: 'HIT_SL', label: 'SL' },
  { value: 'EXPIRED', label: 'Expired' },
]

const PERIOD_FILTERS = [
  { value: null, label: 'Semua' },
  { value: 30, label: '30 hari' },
  { value: 90, label: '90 hari' },
]

function fmt(n: number | null) {
  if (n === null) return '-'
  return new Intl.NumberFormat('id-ID').format(n)
}

const RESULT_COLOR: Record<string, string> = {
  WIN: 'text-[#22C55E]',
  LOSS: 'text-[#EF4444]',
  BREAKEVEN: 'text-slate-400',
  INVALID: 'text-slate-500',
}

export default function RiwayatSinyalPage() {
  const supabase = createClient()
  const [items, setItems] = useState<HistoryItem[]>([])
  const [statusFilter, setStatusFilter] = useState('')
  const [tierFilter, setTierFilter] = useState<'' | 'daily' | 'swing'>('')
  const [periodFilter, setPeriodFilter] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const { data: historyData } = await supabase.rpc('get_signal_history', {
      p_status: statusFilter || null,
      p_tier: tierFilter || null,
      p_days: periodFilter,
      p_limit: 50,
      p_offset: 0,
    })
    setItems((historyData as HistoryItem[]) ?? [])
    setLoading(false)
  }, [supabase, statusFilter, tierFilter, periodFilter])

  useEffect(() => {
    load()
  }, [load])

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 pb-16 max-w-[480px] mx-auto lg:max-w-2xl lg:pl-64">
      <div className="flex items-center gap-3 mb-4">
        <Link href="/profil" className="text-sm text-slate-400">‹</Link>
        <h1 className="text-xl font-bold">Riwayat Sinyal</h1>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-2 mb-2">
        {TIER_FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setTierFilter(f.value)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs border ${
              tierFilter === f.value
                ? 'bg-[#8B5CF6]/20 border-[#8B5CF6] text-white'
                : 'border-white/10 text-slate-400'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 mb-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatusFilter(f.value)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs border ${
              statusFilter === f.value
                ? 'bg-[#8B5CF6]/20 border-[#8B5CF6] text-white'
                : 'border-white/10 text-slate-400'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-2 mb-4">
        {PERIOD_FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setPeriodFilter(f.value)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs border ${
              periodFilter === f.value
                ? 'bg-[#3B82F6]/20 border-[#3B82F6] text-white'
                : 'border-white/10 text-slate-400'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && <p className="text-slate-500 text-sm">Memuat...</p>}
      {!loading && items.length === 0 && (
        <p className="text-slate-500 text-sm text-center py-10">Belum ada riwayat sinyal.</p>
      )}

      <div className="space-y-2">
        {items.map((it) => (
          <div key={it.id} className="rounded-xl bg-white/5 border border-white/10 p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">
                  {it.ticker} <span className="text-slate-500 font-normal">· {tierLabel[it.signal_tier] ?? it.signal_tier} · {it.timeframe}</span>
                </p>
                <p className="text-[11px] text-slate-500">{it.stock_name}</p>
              </div>
              <div className="text-right">
                <p className={`text-xs font-semibold ${RESULT_COLOR[it.result ?? ''] ?? 'text-slate-400'}`}>
                  {it.result ?? it.status}
                </p>
              </div>
            </div>

            {it.unlocked ? (
              <div className="grid grid-cols-3 gap-2 mt-2 text-[11px]">
                <div>
                  <p className="text-slate-500">Entry</p>
                  <p>{fmt(it.entry_price)}</p>
                </div>
                <div>
                  <p className="text-slate-500">TP1/TP2</p>
                  <p>{fmt(it.tp1)} / {fmt(it.tp2)}</p>
                </div>
                <div>
                  <p className="text-slate-500">SL</p>
                  <p>{fmt(it.stop_loss)}</p>
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-slate-600 mt-2">
                Detail harga terkunci — unlock saat sinyal ini aktif untuk melihat.
              </p>
            )}
          </div>
        ))}
      </div>
    </main>
  )
  }
