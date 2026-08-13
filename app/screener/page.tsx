'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

type Sector = { id: string; name: string }
type Stock = {
  id: string
  ticker: string
  name: string
  sector_id: string | null
  sectors: { name: string } | null
}

export default function ScreenerPage() {
  const supabase = createClient()

  const [stocks, setStocks] = useState<Stock[]>([])
  const [sectors, setSectors] = useState<Sector[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [activeSector, setActiveSector] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    async function load() {
      const [stocksRes, sectorsRes] = await Promise.all([
        supabase
          .from('stocks')
          .select('id, ticker, name, sector_id, sectors ( name )')
          .eq('is_active', true)
          .order('ticker'),
        supabase.from('sectors').select('id, name').order('name'),
      ])

      if (!active) return
      setStocks((stocksRes.data as unknown as Stock[]) ?? [])
      setSectors(sectorsRes.data ?? [])
      setLoading(false)
    }

    load()
    return () => {
      active = false
    }
  }, [])

  const filtered = useMemo(() => {
    let list = stocks

    if (activeSector) {
      list = list.filter((s) => s.sector_id === activeSector)
    }

    if (query) {
      const q = query.toUpperCase()
      list = list.filter(
        (s) => s.ticker.includes(q) || s.name.toUpperCase().includes(q)
      )
    }

    return list.slice(0, 50)
  }, [stocks, query, activeSector])

  const hasSectorData = sectors.length > 0

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto">
      <h1 className="text-xl font-bold">Screener</h1>
      <p className="text-slate-400 text-sm mt-1">Cari dan filter saham IDX</p>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Cari kode atau nama saham"
        className="w-full mt-4 rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
      />

      {hasSectorData ? (
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          <button
            onClick={() => setActiveSector(null)}
            className="shrink-0 rounded-full px-4 py-2 text-xs font-medium border transition-colors duration-200"
            style={
              !activeSector
                ? {
                    backgroundImage:
                      'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
                    color: '#fff',
                    borderColor: 'transparent',
                  }
                : { color: '#94A3B8', borderColor: 'rgba(255,255,255,0.1)' }
            }
          >
            Semua Sektor
          </button>
          {sectors.map((s) => {
            const active = activeSector === s.id
            return (
              <button
                key={s.id}
                onClick={() => setActiveSector(s.id)}
                className="shrink-0 rounded-full px-4 py-2 text-xs font-medium border transition-colors duration-200"
                style={
                  active
                    ? {
                        backgroundImage:
                          'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
                        color: '#fff',
                        borderColor: 'transparent',
                      }
                    : { color: '#94A3B8', borderColor: 'rgba(255,255,255,0.1)' }
                }
              >
                {s.name}
              </button>
            )
          })}
        </div>
      ) : (
        !loading && (
          <div className="mt-4 rounded-xl bg-white/5 border border-white/10 px-4 py-3">
            <p className="text-slate-500 text-xs">
              Heatmap Sektor menyusul — data sektor belum tersedia.
            </p>
          </div>
        )
      )}

      <div className="mt-5 space-y-2">
        {loading && <p className="text-slate-500 text-sm">Memuat...</p>}

        {!loading && filtered.length === 0 && (
          <p className="text-slate-500 text-sm">Saham atau berita tidak ditemukan.</p>
        )}

        {!loading &&
          filtered.map((stock) => (
            <Link
              key={stock.id}
              href={`/saham/${stock.ticker}`}
              className="flex items-center justify-between rounded-xl bg-white/5 border border-white/10 px-4 py-3 hover:border-[#8B5CF6] transition-colors duration-200"
            >
              <div className="min-w-0">
                <p className="font-semibold text-sm">{stock.ticker}</p>
                <p className="text-slate-400 text-xs truncate">{stock.name}</p>
              </div>
              {stock.sectors?.name && (
                <span className="shrink-0 text-slate-500 text-[11px] bg-white/5 border border-white/10 rounded-full px-2.5 py-1 ml-2">
                  {stock.sectors.name}
                </span>
              )}
            </Link>
          ))}
      </div>
    </main>
  )
}
