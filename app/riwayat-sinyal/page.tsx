'use client'

import { createClient } from '@/lib/supabase/client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

type HistoryItem = {
  id: string
  ticker: string
  stock_name: string
  direction: 'BUY' | 'SELL' | 'HOLD'
  timeframe: string
  status: string
  created_at: string
  resolved_at: string | null
  result: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'INVALID' | null
  r_multiple: number | null
  unlocked: boolean
  entry_price: number | null
  tp1: number | null
  tp2: number | null
  stop_loss: number | null
}

type Stats = {
  total_trades: number
  wins: number
  losses: number
  breakeven: number
  win_rate: number | null
  avg_r: number
}

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
  const [stats, setStats] = useState<Stats | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [periodFilter, setPeriodFilter] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: historyData }, { data: statsData }] = await Promise.all([
      supabase.rpc('get_signal_history', {
        p_status: statusFilter || null,
        p_days: periodFilter,
        p_limit: 50,
        p_offset: 0,
      }),
      supabase.rpc('get_signal_history_stats', { p_days: periodFilter }),
    ])
    setItems((historyData as HistoryItem[]) ?? [])
    setStats(statsData as Stats)
    setLoading(false)
  }, [supabase, statusFilter, periodFilter])

  useEffect(() => {
    load()
  }, [load])

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 pb-16 max-w-[480px] mx-auto lg:max-w-2xl lg:pl-64">
      <div className="flex items-center gap-3 mb-4">
        <Link href="/profil" className="text-sm text-slate-400">‹</Link>
        <h1 className="text-xl font-bold">Riwayat Sinyal</h1>
      </div>

      {stats && (
        <div className="grid grid-cols-3 gap-2 mb-4">
          <div className="rounded-xl bg-white/5 border border-white/10 p-3 text-center">
            <p className="text-[10px] text-slate-500">Win Rate</p>
            <p className="text-lg font-bold mt-0.5">
              {stats.win_rate !== null ? `${stats.win_rate}%` : '-'}
            </p>
          </div>
          <div className="rounded-xl bg-white/5 border border-white/10 p-3 text-center">
            <p className="text-[10px] text-slate-500">Total Trade</p>
            <p className="text-lg font-bold mt-0.5">{stats.total_trades}</p>
          </div>
          <div className="rounded-xl bg-white/5 border border-white/10 p-3 text-center">
            <p className="text-[10px] text-slate-500">Avg R</p>
            <p className="text-lg font-bold mt-0.5">{stats.avg_r}</p>
          </div>
        </div>
      )}

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
                  {it.ticker} <span className="text-slate-500 font-normal">· {it.timeframe}</span>
                </p>
                <p className="text-[11px] text-slate-500">{it.stock_name}</p>
              </div>
              <div className="text-right">
                <p className={`text-xs font-semibold ${RESULT_COLOR[it.result ?? ''] ?? 'text-slate-400'}`}>
                  {it.result ?? it.status}
                </p>
                {it.r_multiple !== null && (
                  <p className="text-[10px] text-slate-500">{it.r_multiple > 0 ? '+' : ''}{it.r_multiple}R</p>
                )}
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
