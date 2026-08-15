'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import SectorRotationFlow from '@/components/SectorRotationFlow'

type Sector = { id: string; name: string }
type Stock = {
  id: string
  ticker: string
  name: string
  sector_id: string | null
  sectors: { name: string } | null
  quotes: {
    price: number | null
    previous_close: number | null
    volume: number | null
    market_cap: number | null
  } | null
}

type MarketCapFilter = 'ALL' | 'SMALL' | 'MID' | 'BIG'
type VolumeFilter = 'ALL' | 'RENDAH' | 'SEDANG' | 'TINGGI'
type ViewMode = 'HEATMAP' | 'LIST' | 'ROTATION'

function formatHarga(n: number | null) {
  if (n === null || n === undefined) return '-'
  return new Intl.NumberFormat('id-ID').format(n)
}

function pctChange(price: number | null, prev: number | null) {
  if (price === null || prev === null || prev === 0) return null
  return ((price - prev) / prev) * 100
}

// Threshold sesuai spesifikasi: Small <2T, Mid 2-10T, Big >10T
function marketCapBucket(cap: number | null): MarketCapFilter | null {
  if (cap === null || cap === undefined) return null
  if (cap < 2_000_000_000_000) return 'SMALL'
  if (cap <= 10_000_000_000_000) return 'MID'
  return 'BIG'
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

// Warna heatmap: intensitas mengikuti besar %, hijau naik / merah turun,
// abu-abu kalau data belum ada.
function heatColor(pct: number | null) {
  if (pct === null) return 'rgba(148,163,184,0.15)'
  const clamped = Math.max(-5, Math.min(5, pct))
  const intensity = Math.abs(clamped) / 5
  const alpha = 0.15 + intensity * 0.55
  return pct >= 0 ? `rgba(34,197,94,${alpha})` : `rgba(239,68,68,${alpha})`
}

export default function ScreenerPage() {
  const supabase = createClient()

  const [stocks, setStocks] = useState<Stock[]>([])
  const [sectors, setSectors] = useState<Sector[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [activeSector, setActiveSector] = useState<string | null>(null)
  const [marketCapFilter, setMarketCapFilter] = useState<MarketCapFilter>('ALL')
  const [volumeFilter, setVolumeFilter] = useState<VolumeFilter>('ALL')
  const [view, setView] = useState<ViewMode>('HEATMAP')
  const [isPremium, setIsPremium] = useState(false)

  useEffect(() => {
    async function loadPremiumStatus() {
      const { data: userData } = await supabase.auth.getUser()
      if (!userData.user) return
      const { data: profile } = await supabase
        .from('profiles')
        .select('is_premium')
        .eq('id', userData.user.id)
        .single()
      setIsPremium(profile?.is_premium ?? false)
    }
    loadPremiumStatus()
  }, [supabase])

  useEffect(() => {
    let active = true

    async function load() {
      const [stocksRes, sectorsRes] = await Promise.all([
        supabase
          .from('stocks')
          .select(
            'id, ticker, name, sector_id, sectors ( name ), quotes ( price, previous_close, volume, market_cap )'
          )
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

  // Kuartil volume dihitung dari seluruh saham aktif yang punya data volume,
  // sesuai definisi: Rendah <P25, Sedang P25-P75, Tinggi >=P75
  const volumeQuartiles = useMemo(() => {
    const volumes = stocks
      .map((s) => s.quotes?.volume)
      .filter((v): v is number => v !== null && v !== undefined)
      .sort((a, b) => a - b)
    return { p25: percentile(volumes, 0.25), p75: percentile(volumes, 0.75) }
  }, [stocks])

  function volumeBucket(vol: number | null): VolumeFilter | null {
    if (vol === null || vol === undefined) return null
    if (vol < volumeQuartiles.p25) return 'RENDAH'
    if (vol < volumeQuartiles.p75) return 'SEDANG'
    return 'TINGGI'
  }

  // Filter Market Cap/Volume/Search dipakai bersama oleh List DAN Heatmap.
  // Sebelumnya filter ini hanya diterapkan ke `filtered` (dipakai List view),
  // sehingga di tab Heatmap tombol filter berubah state tapi tidak berefek
  // ke tampilan (bug: "tombol kosong"). Sekarang Heatmap ikut memakai
  // `commonFiltered` yang sama sebagai dasar agregasi per sektor.
  const commonFiltered = useMemo(() => {
    let list = stocks

    if (query) {
      const q = query.toUpperCase()
      list = list.filter(
        (s) => s.ticker.includes(q) || s.name.toUpperCase().includes(q)
      )
    }
    if (volumeFilter !== 'ALL') {
      list = list.filter(
        (s) => volumeBucket(s.quotes?.volume ?? null) === volumeFilter
      )
    }
    if (marketCapFilter !== 'ALL') {
      list = list.filter(
        (s) => marketCapBucket(s.quotes?.market_cap ?? null) === marketCapFilter
      )
    }

    return list
  }, [stocks, query, marketCapFilter, volumeFilter, volumeQuartiles])

  const filtered = useMemo(() => {
    let list = commonFiltered
    if (activeSector) {
      list = list.filter((s) => s.sector_id === activeSector)
    }
    return list.slice(0, 50)
  }, [commonFiltered, activeSector])

  // Agregat per sektor untuk heatmap: rata-rata persen perubahan.
  // Memakai commonFiltered supaya filter Market Cap/Volume/Search juga
  // mempengaruhi tampilan Heatmap, bukan hanya tab List.
  const sectorHeat = useMemo(() => {
    return sectors.map((sector) => {
      const members = commonFiltered.filter((s) => s.sector_id === sector.id)
      const pcts = members
        .map((s) => pctChange(s.quotes?.price ?? null, s.quotes?.previous_close ?? null))
        .filter((p): p is number => p !== null)
      const avgPct = pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null
      return { sector, avgPct, count: members.length }
    })
  }, [sectors, commonFiltered])

  const hasSectorData = sectors.length > 0
  const activeFilterCount =
    (marketCapFilter !== 'ALL' ? 1 : 0) + (volumeFilter !== 'ALL' ? 1 : 0)

  const pillActiveStyle = {
    backgroundImage:
      'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
    color: '#fff',
    borderColor: 'transparent',
  }
  const pillInactiveStyle = { color: '#94A3B8', borderColor: 'rgba(255,255,255,0.1)' }

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

      {/* Toggle view: Heatmap (default) vs List */}
      <div className="mt-4 flex gap-2">
        <button
          onClick={() => setView('HEATMAP')}
          className="flex-1 rounded-xl px-4 py-2 text-xs font-medium border transition-colors duration-200"
          style={view === 'HEATMAP' ? pillActiveStyle : pillInactiveStyle}
        >
          Heatmap Sektor
        </button>
        <button
          onClick={() => setView('LIST')}
          className="flex-1 rounded-xl px-4 py-2 text-xs font-medium border transition-colors duration-200"
          style={view === 'LIST' ? pillActiveStyle : pillInactiveStyle}
        >
          Daftar Saham
        </button>
        <button
          onClick={() => setView('ROTATION')}
          className="flex-1 rounded-xl px-4 py-2 text-xs font-medium border transition-colors duration-200"
          style={view === 'ROTATION' ? pillActiveStyle : pillInactiveStyle}
        >
          Sector Rotation
        </button>
      </div>

      {/* Filter Market Cap & Volume */}
      <div className="mt-4 space-y-2">
        <div>
          <p className="text-slate-500 text-[11px] mb-1.5">Market Cap</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {(
              [
                ['ALL', 'Semua'],
                ['SMALL', 'Small <2T'],
                ['MID', 'Mid 2-10T'],
                ['BIG', 'Big >10T'],
              ] as [MarketCapFilter, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setMarketCapFilter(key)}
                className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-medium border transition-colors duration-200"
                style={marketCapFilter === key ? pillActiveStyle : pillInactiveStyle}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-slate-500 text-[11px] mb-1.5">Volume</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {(
              [
                ['ALL', 'Semua'],
                ['RENDAH', 'Rendah'],
                ['SEDANG', 'Sedang'],
                ['TINGGI', 'Tinggi'],
              ] as [VolumeFilter, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setVolumeFilter(key)}
                className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-medium border transition-colors duration-200"
                style={volumeFilter === key ? pillActiveStyle : pillInactiveStyle}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Filter Sektor (dipakai di view List) */}
      {view === 'LIST' &&
        (hasSectorData ? (
          <div className="mt-4 flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            <button
              onClick={() => setActiveSector(null)}
              className="shrink-0 rounded-full px-4 py-2 text-xs font-medium border transition-colors duration-200"
              style={!activeSector ? pillActiveStyle : pillInactiveStyle}
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
                  style={active ? pillActiveStyle : pillInactiveStyle}
                >
                  {s.name}
                </button>
              )
            })}
          </div>
        ) : (
          !loading && (
            <div className="mt-4 rounded-xl bg-white/5 border border-white/10 px-4 py-3">
              <p className="text-slate-500 text-xs">Data sektor belum tersedia.</p>
            </div>
          )
        ))}

      {loading && <p className="mt-5 text-slate-500 text-sm">Memuat...</p>}

      {!loading && view === 'ROTATION' && <SectorRotationFlow isPremium={isPremium} />}

      {/* HEATMAP VIEW */}
      {!loading && view === 'HEATMAP' && (
        <div className="mt-5">
          {activeFilterCount > 0 && (
            <p className="text-slate-500 text-[11px] mb-2">
              Heatmap menampilkan {commonFiltered.length} saham sesuai filter aktif
            </p>
          )}
          {!hasSectorData ? (
            <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
              <p className="text-slate-500 text-xs">
                Heatmap Sektor menyusul — data sektor belum tersedia.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {sectorHeat.map(({ sector, avgPct, count }) => (
                <button
                  key={sector.id}
                  onClick={() => {
                    setActiveSector(sector.id)
                    setView('LIST')
                  }}
                  className="rounded-xl border border-white/10 px-3 py-3 text-left transition-colors duration-300"
                  style={{ backgroundColor: heatColor(avgPct) }}
                >
                  <p className="text-sm font-semibold truncate">{sector.name}</p>
                  <p className="text-xs mt-1 text-slate-200">
                    {avgPct !== null ? `${avgPct >= 0 ? '+' : ''}${avgPct.toFixed(2)}%` : 'Data belum ada'}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-0.5">{count} saham</p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* LIST VIEW */}
      {!loading && view === 'LIST' && (
        <div className="mt-5 space-y-2">
          {activeFilterCount > 0 && (
            <p className="text-slate-500 text-[11px]">
              {filtered.length} saham cocok dengan filter aktif
            </p>
          )}

          {filtered.length === 0 && (
            <p className="text-slate-500 text-sm">Saham atau berita tidak ditemukan.</p>
          )}

          {filtered.map((stock) => {
            const price = stock.quotes?.price ?? null
            const prev = stock.quotes?.previous_close ?? null
            const pct = pctChange(price, prev)
            const up = pct !== null && pct >= 0

            return (
              <Link
                key={stock.id}
                href={`/saham/${stock.ticker}`}
                className="flex items-center justify-between rounded-xl bg-white/5 border border-white/10 px-4 py-3 hover:border-[#8B5CF6] transition-colors duration-200"
              >
                <div className="min-w-0">
                  <p className="font-semibold text-sm">{stock.ticker}</p>
                  <p className="text-slate-400 text-xs truncate">{stock.name}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {price !== null && (
                    <div className="text-right">
                      <p className="font-medium text-sm">{formatHarga(price)}</p>
                      {pct !== null && (
                        <p className={`text-xs ${up ? 'text-[#22C55E]' : 'text-[#EF4444]'}`}>
                          {up ? '+' : ''}
                          {pct.toFixed(2)}%
                        </p>
                      )}
                    </div>
                  )}
                  {stock.sectors?.name && (
                    <span className="text-slate-500 text-[11px] bg-white/5 border border-white/10 rounded-full px-2.5 py-1">
                      {stock.sectors.name}
                    </span>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </main>
  )
}
