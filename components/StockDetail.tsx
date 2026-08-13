'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { User } from '@supabase/supabase-js'

type Stock = {
  id: string
  ticker: string
  name: string
  sectors: { name: string } | null
}

type Signal = {
  id: string
  direction: 'BUY' | 'SELL' | 'HOLD'
  entry_price: number | null
  buy_area_low: number | null
  buy_area_high: number | null
  tp1: number | null
  tp2: number | null
  stop_loss: number | null
  confidence_score: number | null
  status: string
  ai_reasoning: { teknikal?: string; fundamental?: string; makro?: string } | null
  created_at: string
}

const directionStyle: Record<string, { bg: string; text: string; label: string }> = {
  BUY: { bg: 'bg-[#22C55E]/15', text: 'text-[#22C55E]', label: 'BUY' },
  SELL: { bg: 'bg-[#EF4444]/15', text: 'text-[#EF4444]', label: 'SELL' },
  HOLD: { bg: 'bg-white/10', text: 'text-slate-300', label: 'HOLD' },
}

function formatHarga(n: number | null) {
  if (n === null || n === undefined) return '-'
  return new Intl.NumberFormat('id-ID').format(n)
}

export default function StockDetail({ ticker }: { ticker: string }) {
  const router = useRouter()
  const supabase = createClient()

  const [user, setUser] = useState<User | null>(null)
  const [stock, setStock] = useState<Stock | null>(null)
  const [signal, setSignal] = useState<Signal | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const [inWatchlist, setInWatchlist] = useState(false)
  const [watchlistLoading, setWatchlistLoading] = useState(false)
  const [watchlistMsg, setWatchlistMsg] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    async function load() {
      const { data: userData } = await supabase.auth.getUser()
      if (active) setUser(userData.user)

      const { data: stockData } = await supabase
        .from('stocks')
        .select('id, ticker, name, sectors ( name )')
        .eq('ticker', ticker)
        .maybeSingle()

      if (!active) return

      if (!stockData) {
        setNotFound(true)
        setLoading(false)
        return
      }

      setStock(stockData as unknown as Stock)

      const { data: signalData } = await supabase
        .from('signals')
        .select(
          'id, direction, entry_price, buy_area_low, buy_area_high, tp1, tp2, stop_loss, confidence_score, status, ai_reasoning, created_at'
        )
        .eq('stock_id', stockData.id)
        .eq('status', 'ACTIVE')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!active) return
      setSignal(signalData as Signal | null)

      if (userData.user) {
        const { data: watchlists } = await supabase
          .from('watchlists')
          .select('id')
          .eq('user_id', userData.user.id)

        if (watchlists && watchlists.length > 0) {
          const ids = watchlists.map((w) => w.id)
          const { data: items } = await supabase
            .from('watchlist_items')
            .select('id')
            .eq('stock_id', stockData.id)
            .in('watchlist_id', ids)

          if (active && items && items.length > 0) setInWatchlist(true)
        }
      }

      if (active) setLoading(false)
    }

    load()
    return () => {
      active = false
    }
  }, [ticker])

  const handleWatchlist = async () => {
    if (!user) {
      router.push('/login')
      return
    }
    if (!stock || inWatchlist) return

    setWatchlistLoading(true)
    setWatchlistMsg(null)

    const { data: watchlists } = await supabase
      .from('watchlists')
      .select('id')
      .eq('user_id', user.id)
      .limit(1)

    let watchlistId = watchlists && watchlists.length > 0 ? watchlists[0].id : null

    if (!watchlistId) {
      const { data: created, error: createError } = await supabase
        .from('watchlists')
        .insert({ user_id: user.id, name: 'Utama' })
        .select('id')
        .single()

      if (createError || !created) {
        setWatchlistMsg('Gagal membuat watchlist.')
        setWatchlistLoading(false)
        return
      }
      watchlistId = created.id
    }

    const { error: insertError } = await supabase
      .from('watchlist_items')
      .insert({ watchlist_id: watchlistId, stock_id: stock.id })

    if (insertError) {
      setWatchlistMsg('Gagal menambahkan ke watchlist.')
    } else {
      setInWatchlist(true)
    }
    setWatchlistLoading(false)
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto">
        <p className="text-slate-500 text-sm">Memuat...</p>
      </main>
    )
  }

  if (notFound || !stock) {
    return (
      <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto">
        <button onClick={() => router.push('/')} className="text-slate-400 text-sm mb-4">
          &larr; Kembali
        </button>
        <p className="text-slate-400 text-sm">Saham tidak ditemukan.</p>
      </main>
    )
  }

  const dir = signal ? directionStyle[signal.direction] : null

  return (
    <main className="min-h-screen bg-[#0F172A] text-white pb-28">
      <div className="sticky top-0 z-10 bg-[#0F172A]/95 backdrop-blur border-b border-white/10 px-4 py-3 max-w-[480px] mx-auto">
        <button onClick={() => router.push('/')} className="text-slate-400 text-sm mb-2">
          &larr; Kembali
        </button>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">{stock.ticker}</h1>
            <p className="text-slate-400 text-xs">{stock.name}</p>
          </div>
          <span className="text-slate-500 text-xs bg-white/5 border border-white/10 rounded-full px-3 py-1">
            {stock.sectors?.name ?? 'Sektor belum diketahui'}
          </span>
        </div>
      </div>

      <div className="px-4 py-4 max-w-[480px] mx-auto space-y-4">
        <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-6 text-center">
          <p className="text-slate-500 text-sm">Data harga menyusul</p>
        </div>

        <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-sm">Sinyal AI</h2>
            {dir && (
              <span className={`text-xs font-bold px-3 py-1 rounded-full ${dir.bg} ${dir.text}`}>
                {dir.label}
              </span>
            )}
          </div>

          {!signal && (
            <p className="text-slate-500 text-sm">Belum ada sinyal aktif untuk {stock.ticker}.</p>
          )}

          {signal && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg bg-white/5 px-3 py-2">
                  <p className="text-slate-500 text-xs">Buy Area</p>
                  <p className="font-medium">
                    {formatHarga(signal.buy_area_low)} - {formatHarga(signal.buy_area_high)}
                  </p>
                </div>
                <div className="rounded-lg bg-white/5 px-3 py-2">
                  <p className="text-slate-500 text-xs">Stop Loss</p>
                  <p className="font-medium text-[#EF4444]">{formatHarga(signal.stop_loss)}</p>
                </div>
                <div className="rounded-lg bg-white/5 px-3 py-2">
                  <p className="text-slate-500 text-xs">Target 1 (TP1)</p>
                  <p className="font-medium text-[#22C55E]">{formatHarga(signal.tp1)}</p>
                </div>
                <div className="rounded-lg bg-white/5 px-3 py-2">
                  <p className="text-slate-500 text-xs">Target 2 (TP2)</p>
                  <p className="font-medium text-[#22C55E]">{formatHarga(signal.tp2)}</p>
                </div>
              </div>

              <div className="rounded-lg bg-white/5 px-3 py-2 text-sm">
                <p className="text-slate-500 text-xs">Confidence</p>
                <p className="font-medium">
                  {signal.confidence_score !== null ? `${signal.confidence_score}%` : 'Data belum cukup'}
                </p>
              </div>

              {signal.ai_reasoning && (
                <div className="space-y-2 text-sm">
                  {signal.ai_reasoning.teknikal && (
                    <div>
                      <p className="text-slate-500 text-xs mb-1">Teknikal</p>
                      <p className="text-slate-300">{signal.ai_reasoning.teknikal}</p>
                    </div>
                  )}
                  {signal.ai_reasoning.fundamental && (
                    <div>
                      <p className="text-slate-500 text-xs mb-1">Fundamental</p>
                      <p className="text-slate-300">{signal.ai_reasoning.fundamental}</p>
                    </div>
                  )}
                  {signal.ai_reasoning.makro && (
                    <div>
                      <p className="text-slate-500 text-xs mb-1">Makro</p>
                      <p className="text-slate-300">{signal.ai_reasoning.makro}</p>
                    </div>
                  )}
                </div>
              )}

              <p className="text-slate-600 text-[11px] pt-1 border-t border-white/10">
                DYOR — sinyal AI bukan jaminan profit.
              </p>
            </div>
          )}
        </div>

        <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-4">
          <h2 className="font-semibold text-sm mb-2">Indikator & Fundamental</h2>
          <p className="text-slate-500 text-sm">Data indikator dan fundamental menyusul.</p>
        </div>

        {watchlistMsg && <p className="text-[#EF4444] text-sm">{watchlistMsg}</p>}
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-[#0F172A]/95 backdrop-blur border-t border-white/10 px-4 py-3">
        <div className="max-w-[480px] mx-auto flex gap-2">
          <button
            onClick={handleWatchlist}
            disabled={watchlistLoading || inWatchlist}
            className="flex-1 rounded-xl border border-white/10 px-4 py-3 text-sm font-medium disabled:opacity-60"
            style={
              inWatchlist
                ? { background: 'rgba(139,92,246,0.15)', color: '#8B5CF6' }
                : {
                    backgroundImage:
                      'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
                    color: '#fff',
                  }
            }
          >
            {inWatchlist
              ? 'Sudah di Watchlist'
              : watchlistLoading
                ? 'Menambahkan...'
                : 'Tambah ke Watchlist'}
          </button>
          <button
            onClick={() => alert('Trading Plan segera hadir.')}
            className="flex-1 rounded-xl border border-white/10 px-4 py-3 text-sm font-medium text-slate-300"
          >
            Lihat Trading Plan
          </button>
        </div>
      </div>
    </main>
  )
}
