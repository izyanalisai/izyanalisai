'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

type RotationRow = {
  sector_id: string
  as_of_date: string
  relative_strength: number
  momentum: number
  label: 'LEADING' | 'IMPROVING' | 'WEAKENING' | 'LAGGING'
  sectors: { name: string } | null
}

type StockRow = { id: string; ticker: string; name: string }

const QUADRANTS: { key: RotationRow['label']; title: string; hint: string; color: string }[] = [
  { key: 'LEADING', title: 'Leading', hint: 'Kuat & masih menguat', color: '#22C55E' },
  { key: 'IMPROVING', title: 'Improving', hint: 'Lemah tapi mulai membaik', color: '#3B82F6' },
  { key: 'WEAKENING', title: 'Weakening', hint: 'Kuat tapi mulai melemah', color: '#F59E0B' },
  { key: 'LAGGING', title: 'Lagging', hint: 'Lemah & masih melemah', color: '#EF4444' },
]

export default function SectorRotationFlow({ isPremium }: { isPremium: boolean }) {
  const supabase = createClient()
  const [rows, setRows] = useState<RotationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [openSector, setOpenSector] = useState<{ id: string; name: string } | null>(null)
  const [sectorStocks, setSectorStocks] = useState<StockRow[]>([])

  useEffect(() => {
    async function load() {
      setLoading(true)
      const { data: latestDate } = await supabase
        .from('sector_rotation_scores')
        .select('as_of_date')
        .order('as_of_date', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!latestDate) {
        setRows([])
        setLoading(false)
        return
      }

      const { data } = await supabase
        .from('sector_rotation_scores')
        .select('sector_id, as_of_date, relative_strength, momentum, label, sectors ( name )')
        .eq('as_of_date', latestDate.as_of_date)

      setRows((data as unknown as RotationRow[]) ?? [])
      setLoading(false)
    }
    load()
  }, [supabase])

  const openSectorDetail = async (sectorId: string, name: string) => {
    if (!isPremium) return
    setOpenSector({ id: sectorId, name })
    const { data } = await supabase
      .from('stocks')
      .select('id, ticker, name')
      .eq('sector_id', sectorId)
      .eq('is_active', true)
      .limit(15)
    setSectorStocks(data ?? [])
  }

  if (loading) {
    return <p className="mt-5 text-slate-500 text-sm">Memuat...</p>
  }

  if (rows.length === 0) {
    return (
      <div className="mt-5 rounded-xl bg-white/5 border border-white/10 px-4 py-3">
        <p className="text-slate-500 text-xs">
          Data Sector Rotation Flow belum tersedia — dihitung otomatis tiap hari bursa setelah closing.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-5">
      <p className="text-slate-500 text-[11px] mb-3">
        Kekuatan relatif sektor vs pasar, dihitung dari pergerakan 5 hari terakhir.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {QUADRANTS.map((q) => {
          const members = rows
            .filter((r) => r.label === q.key)
            .sort((a, b) => b.relative_strength - a.relative_strength)
          return (
            <div key={q.key} className="rounded-xl bg-white/5 border border-white/10 p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: q.color }} />
                <p className="text-xs font-semibold">{q.title}</p>
              </div>
              <p className="text-slate-500 text-[10px] mb-2">{q.hint}</p>
              <div className="space-y-1">
                {members.length === 0 && <p className="text-slate-600 text-[11px]">-</p>}
                {members.map((m) => (
                  <button
                    key={m.sector_id}
                    onClick={() => openSectorDetail(m.sector_id, m.sectors?.name ?? '-')}
                    className="w-full text-left text-[11px] text-slate-300 hover:text-white transition-colors duration-200"
                  >
                    {m.sectors?.name ?? '-'}{' '}
                    <span className="text-slate-500">
                      ({m.relative_strength >= 0 ? '+' : ''}
                      {m.relative_strength.toFixed(1)}%)
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {openSector && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={() => setOpenSector(null)}>
          <div
            className="w-full max-w-[480px] bg-[#0F172A] border-t border-white/10 rounded-t-2xl px-4 py-5 max-h-[70vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <p className="font-semibold text-sm">{openSector.name}</p>
              <button onClick={() => setOpenSector(null)} className="text-slate-500 text-xs">Tutup</button>
            </div>
            <div className="space-y-1">
              {sectorStocks.length === 0 && <p className="text-slate-500 text-xs">Belum ada saham.</p>}
              {sectorStocks.map((s) => (
                <Link
                  key={s.id}
                  href={`/saham/${s.ticker}`}
                  className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors duration-200"
                >
                  <span className="text-sm">{s.ticker}</span>
                  <span className="text-slate-500 text-xs">{s.name}</span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      {!isPremium && (
        <div className="mt-3 rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-center">
          <p className="text-slate-400 text-xs">Upgrade Premium buat lihat daftar saham & detail aliran dana per sektor.</p>
        </div>
      )}
    </div>
  )
}
