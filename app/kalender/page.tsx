'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

type EconEvent = {
  id: string
  event_name: string
  country: string
  event_date: string
  event_time: string | null
  impact: 'low' | 'medium' | 'high' | null
  actual: string | null
  forecast: string | null
  previous: string | null
}

type EarningsItem = {
  id: string
  quarter: number
  year: number
  announcement_date: string
  estimated_eps: number | null
  actual_eps: number | null
  status: 'SCHEDULED' | 'RELEASED' | 'DELAYED'
  stocks: { ticker: string; name: string } | null
}

type IpoItem = {
  id: string
  company_name: string
  ticker: string | null
  opening_date: string | null
  closing_date: string | null
  listing_date: string | null
  price_range_low: number | null
  price_range_high: number | null
  status: 'UPCOMING' | 'OPEN' | 'CLOSED' | 'LISTED' | 'CANCELLED'
}

type Tab = 'ekonomi' | 'laba' | 'ipo'

const IMPACT_LABEL: Record<string, string> = { low: 'Rendah', medium: 'Sedang', high: 'Tinggi' }
const IMPACT_COLOR: Record<string, string> = {
  low: 'text-slate-400',
  medium: 'text-amber-400',
  high: 'text-[#F43F5E]',
}
const IPO_STATUS_LABEL: Record<string, string> = {
  UPCOMING: 'Akan Datang',
  OPEN: 'Dibuka',
  CLOSED: 'Ditutup',
  LISTED: 'Listing',
  CANCELLED: 'Dibatalkan',
}
const EARNINGS_STATUS_LABEL: Record<string, string> = {
  SCHEDULED: 'Terjadwal',
  RELEASED: 'Rilis',
  DELAYED: 'Ditunda',
}

function formatDate(d: string | null) {
  if (!d) return '-'
  return new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatHarga(n: number | null) {
  if (n === null || n === undefined) return '-'
  return new Intl.NumberFormat('id-ID').format(n)
}

export default function KalenderPage() {
  const [tab, setTab] = useState<Tab>('ekonomi')

  const [events, setEvents] = useState<EconEvent[]>([])
  const [earnings, setEarnings] = useState<EarningsItem[]>([])
  const [ipos, setIpos] = useState<IpoItem[]>([])
  const [loading, setLoading] = useState(true)

  const [countryFilter, setCountryFilter] = useState('')
  const [impactFilter, setImpactFilter] = useState('')

  useEffect(() => {
    const supabase = createClient()
    let active = true

    async function load() {
      setLoading(true)
      if (tab === 'ekonomi') {
        let query = supabase.from('economic_events').select('*').order('event_date', { ascending: true })
        if (countryFilter) query = query.eq('country', countryFilter)
        if (impactFilter) query = query.eq('impact', impactFilter)
        const { data } = await query
        if (active) setEvents(data ?? [])
      } else if (tab === 'laba') {
        const { data } = await supabase
          .from('earnings_calendar')
          .select('id, quarter, year, announcement_date, estimated_eps, actual_eps, status, stocks ( ticker, name )')
          .order('announcement_date', { ascending: true })
        if (active) setEarnings((data as unknown as EarningsItem[]) ?? [])
      } else {
        const { data } = await supabase
          .from('ipo_calendar')
          .select('*')
          .order('opening_date', { ascending: true })
        if (active) setIpos(data ?? [])
      }
      if (active) setLoading(false)
    }

    load()
    return () => {
      active = false
    }
  }, [tab, countryFilter, impactFilter])

  const countries = Array.from(new Set(events.map((e) => e.country))).filter(Boolean)

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 pb-16 max-w-[480px] mx-auto lg:max-w-2xl lg:pl-64">
      <div className="flex items-center gap-3 mb-4">
        <Link href="/" className="text-sm text-slate-400">‹</Link>
        <h1 className="text-xl font-bold">Kalender Ekonomi, Laba & IPO</h1>
      </div>

      <div className="flex gap-2 mb-4 border-b border-white/10">
        {([
          { key: 'ekonomi', label: 'Ekonomi' },
          { key: 'laba', label: 'Kalender Laba' },
          { key: 'ipo', label: 'Kalender IPO' },
        ] as { key: Tab; label: string }[]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors duration-200 ${
              tab === t.key ? 'border-[#8B5CF6] text-white' : 'border-transparent text-slate-500'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'ekonomi' && (
        <>
          <div className="flex gap-2 mb-4 overflow-x-auto">
            <select
              value={countryFilter}
              onChange={(e) => setCountryFilter(e.target.value)}
              className="rounded-lg bg-white/5 border border-white/10 px-2.5 py-1.5 text-xs shrink-0"
            >
              <option value="">Semua Negara</option>
              {countries.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              value={impactFilter}
              onChange={(e) => setImpactFilter(e.target.value)}
              className="rounded-lg bg-white/5 border border-white/10 px-2.5 py-1.5 text-xs shrink-0"
            >
              <option value="">Semua Dampak</option>
              <option value="low">Rendah</option>
              <option value="medium">Sedang</option>
              <option value="high">Tinggi</option>
            </select>
          </div>

          {loading && <p className="text-slate-500 text-sm">Memuat...</p>}
          {!loading && events.length === 0 && (
            <p className="text-slate-500 text-sm text-center py-10">Tidak ada event pada rentang ini.</p>
          )}
          <div className="space-y-2">
            {events.map((e) => (
              <div key={e.id} className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">{e.event_name}</p>
                  {e.impact && (
                    <span className={`text-[10px] font-semibold uppercase ${IMPACT_COLOR[e.impact]}`}>
                      {IMPACT_LABEL[e.impact]}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  {e.country} · {formatDate(e.event_date)}
                  {e.event_time ? ` · ${e.event_time}` : ''}
                </p>
                {(e.actual || e.forecast || e.previous) && (
                  <div className="flex gap-4 mt-2 text-[11px] text-slate-400">
                    {e.actual && <span>Aktual: {e.actual}</span>}
                    {e.forecast && <span>Forecast: {e.forecast}</span>}
                    {e.previous && <span>Sebelumnya: {e.previous}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {tab === 'laba' && (
        <>
          {loading && <p className="text-slate-500 text-sm">Memuat...</p>}
          {!loading && earnings.length === 0 && (
            <p className="text-slate-500 text-sm text-center py-10">Belum ada jadwal rilis laba.</p>
          )}
          <div className="space-y-2">
            {earnings.map((e) => (
              <div key={e.id} className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">{e.stocks?.ticker ?? '-'}</p>
                  <span className="text-[10px] text-slate-400">{EARNINGS_STATUS_LABEL[e.status]}</span>
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {e.stocks?.name} · Q{e.quarter} {e.year} · {formatDate(e.announcement_date)}
                </p>
                <div className="flex gap-4 mt-2 text-[11px] text-slate-400">
                  <span>Estimasi EPS: {e.estimated_eps ?? '-'}</span>
                  <span>Aktual EPS: {e.actual_eps ?? '-'}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === 'ipo' && (
        <>
          {loading && <p className="text-slate-500 text-sm">Memuat...</p>}
          {!loading && ipos.length === 0 && (
            <p className="text-slate-500 text-sm text-center py-10">Belum ada jadwal IPO.</p>
          )}
          <div className="space-y-2">
            {ipos.map((ipo) => (
              <div key={ipo.id} className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">{ipo.company_name}</p>
                  <span className="text-[10px] text-slate-400">{IPO_STATUS_LABEL[ipo.status]}</span>
                </div>
                {ipo.ticker && <p className="text-[11px] text-slate-500 mt-0.5">{ipo.ticker}</p>}
                <div className="grid grid-cols-3 gap-2 mt-2 text-[11px] text-slate-400">
                  <span>Buka: {formatDate(ipo.opening_date)}</span>
                  <span>Tutup: {formatDate(ipo.closing_date)}</span>
                  <span>Listing: {formatDate(ipo.listing_date)}</span>
                </div>
                {(ipo.price_range_low || ipo.price_range_high) && (
                  <p className="text-[11px] text-slate-400 mt-1">
                    Rentang Harga: {formatHarga(ipo.price_range_low)} - {formatHarga(ipo.price_range_high)}
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  )
}
