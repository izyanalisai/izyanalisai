
'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

type SignalRow = {
  id: string
  direction: 'BUY' | 'SELL'
  created_at: string
  stock_id: string
  ticker: string
  name: string
}

type FilterValue = 'ALL' | 'BUY' | 'SELL'

const directionStyle: Record<string, { bg: string; text: string }> = {
  BUY: { bg: 'bg-[#22C55E]/15', text: 'text-[#22C55E]' },
  SELL: { bg: 'bg-[#EF4444]/15', text: 'text-[#EF4444]' },
  HOLD: { bg: 'bg-white/10', text: 'text-slate-300' },
}

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: 'ALL', label: 'Semua' },
  { value: 'BUY', label: 'BUY' },
  { value: 'SELL', label: 'SELL' },
]

export default function SignalPage() {
  const supabase = createClient()

  const [signals, setSignals] = useState<SignalRow[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterValue>('ALL')

  useEffect(() => {
    let active = true

    async function load() {
      const { data } = await supabase.rpc('list_active_signals')

      if (!active) return
      setSignals((data as SignalRow[]) ?? [])
      setLoading(false)
    }

    load()

    return () => {
      active = false
    }
  }, [])

  const filtered = useMemo(() => {
    let list = signals

    if (filter !== 'ALL') {
      list = list.filter((s) => s.direction === filter)
    }

    if (query) {
      const q = query.toUpperCase()
      list = list.filter(
        (s) => s.ticker.includes(q) || s.name.toUpperCase().includes(q)
      )
    }

    return list
  }, [signals, query, filter])

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto">
      <h1 className="text-xl font-bold">Sinyal AI</h1>

      <p className="text-slate-500 text-xs mt-1">
        Diperbarui setiap sesi perdagangan · DYOR
      </p>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Cari sinyal saham"
        className="w-full mt-4 rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
      />

      <div className="mt-4 flex gap-2">
        {FILTERS.map((f) => {
          const active = filter === f.value

          return (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className="rounded-full px-4 py-2 text-xs font-medium border transition-colors duration-200"
              style={
                active
                  ? {
                      backgroundImage:
                        'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
                      color: '#fff',
                      borderColor: 'transparent',
                    }
                  : {
                      color: '#94A3B8',
                      borderColor: 'rgba(255,255,255,0.1)',
                    }
              }
            >
              {f.label}
            </button>
          )
        })}
      </div>

      <div className="mt-5 space-y-2">
        {loading && (
          <p className="text-slate-500 text-sm">
            Memuat...
          </p>
        )}

        {!loading && filtered.length === 0 && (
          <p className="text-slate-500 text-sm">
            Belum ada sinyal aktif.
          </p>
        )}

        {!loading &&
          filtered.map((s) => {
            const dir = directionStyle[s.direction]

            return (
              <Link
                key={s.id}
                href={`/saham/${s.ticker}`}
                className="block rounded-xl bg-white/5 border border-white/10 px-4 py-3 hover:border-[#8B5CF6] transition-colors duration-200"
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm">
                      {s.ticker}
                    </p>

                    <p className="text-slate-400 text-xs truncate">
                      {s.name}
                    </p>
                  </div>

                  <span
                    className={`shrink-0 text-xs font-bold px-3 py-1 rounded-full ml-2 ${dir.bg} ${dir.text}`}
                  >
                    {s.direction}
                  </span>
                </div>

                <p className="text-slate-500 text-xs mt-2">
                  Buy Area, TP, SL & Confidence — buka di Detail Saham
                </p>
              </Link>
            )
          })}
      </div>
    </main>
  )
}

