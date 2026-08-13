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

type Quote = {
  price: number | null
  previous_close: number | null
  day_high: number | null
  day_low: number | null
  volume: number | null
  quality: string | null
  updated_at: string | null
}

type Signal = {
  id: string
  direction: 'BUY' | 'SELL' | 'HOLD'
  entry_price?: number | null
  buy_area_low?: number | null
  buy_area_high?: number | null
  tp1?: number | null
  tp2?: number | null
  stop_loss?: number | null
  confidence_score?: number | null
  status: string
  ai_reasoning?: { teknikal?: string; fundamental?: string; makro?: string } | null
  created_at: string
  unlocked: boolean
}

type Wallet = {
  balance: number
  ad_unlock_count: number
}

const UNLOCK_ERROR_MESSAGE: Record<string, string> = {
  INSUFFICIENT_TOKENS: 'Token kamu habis untuk hari ini.',
  AD_LIMIT_REACHED: 'Batas nonton iklan hari ini sudah tercapai (maks 3).',
  PREMIUM_NO_ADS_NEEDED: 'Akun Premium tidak perlu nonton iklan.',
  NOT_AUTHENTICATED: 'Silakan login terlebih dahulu.',
}

function unlockErrorMessage(error: { message?: string } | null) {
  if (!error?.message) return 'Gagal membuka sinyal. Coba lagi.'
  const code = Object.keys(UNLOCK_ERROR_MESSAGE).find((k) => error.message?.includes(k))
  return code ? UNLOCK_ERROR_MESSAGE[code] : 'Gagal membuka sinyal. Coba lagi.'
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

function pctChange(price: number | null, prev: number | null) {
  if (price === null || prev === null || prev === 0) return null
  return ((price - prev) / prev) * 100
}

function isStale(fetchedAt: string | null) {
  if (!fetchedAt) return true
  const diffMinutes = (Date.now() - new Date(fetchedAt).getTime()) / 60000
  return diffMinutes > 30
}

export default function StockDetail({ ticker }: { ticker: string }) {
  const router = useRouter()
  const supabase = createClient()

  const [user, setUser] = useState<User | null>(null)
  const [stock, setStock] = useState<Stock | null>(null)
  const [quote, setQuote] = useState<Quote | null>(null)
  const [signal, setSignal] = useState<Signal | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const [inWatchlist, setInWatchlist] = useState(false)
  const [watchlistLoading, setWatchlistLoading] = useState(false)
  const [watchlistMsg, setWatchlistMsg] = useState<string | null>(null)

  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [unlockLoading, setUnlockLoading] = useState<'token' | 'ad' | null>(null)
  const [unlockMsg, setUnlockMsg] = useState<string | null>(null)

  const loadSignal = async (stockId: string) => {
    const { data: signalData } = await supabase.rpc('get_signal_for_stock', {
      p_stock_id: stockId,
    })
    setSignal((signalData as Signal | null) ?? null)
  }

  const loadWallet = async () => {
    const { data: walletData } = await supabase.rpc('get_my_wallet')
    if (walletData) {
      setWallet({ balance: walletData.balance, ad_unlock_count: walletData.ad_unlock_count })
    }
  }

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

      const { data: quoteData } = await supabase
        .from('quotes')
        .select('price, previous_close, day_high, day_low, volume, quality, updated_at')
        .eq('stock_id', stockData.id)
        .maybeSingle()

      if (active) setQuote(quoteData)

      await loadSignal(stockData.id)
      if (!active) return

      if (userData.user) {
        await loadWallet()

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

  const handleUnlockWithToken = async () => {
    if (!user) {
      router.push('/login')
      return
    }
    if (!stock) return

    setUnlockLoading('token')
    setUnlockMsg(null)

    const idempotencyKey =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`

    const { error } = await supabase.rpc('unlock_signal_with_token', {
      p_stock_id: stock.id,
      p_idempotency_key: idempotencyKey,
    })

    if (error) {
      setUnlockMsg(unlockErrorMessage(error))
    } else {
      await loadSignal(stock.id)
      await loadWallet()
    }
    setUnlockLoading(null)
  }

  const handleUnlockWithAd = async () => {
    if (!user) {
      router.push('/login')
      return
    }
    if (!stock) return

    setUnlockLoading('ad')
    setUnlockMsg(null)

    // TODO: di production, panggil ini hanya setelah backend menerima
    // callback reward terverifikasi dari Google AdMob (bukan langsung
    // setelah video selesai di client).
    const { error } = await supabase.rpc('unlock_signal_with_ad', {
      p_stock_id: stock.id,
    })

    if (error) {
      setUnlockMsg(unlockErrorMessage(error))
    } else {
      await loadSignal(stock.id)
      await loadWallet()
    }
    setUnlockLoading(null)
  }

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

    if (watchlistId) {
      const { count } = await supabase
        .from('watchlist_items')
        .select('id', { count: 'exact', head: true })
        .eq('watchlist_id', watchlistId)

      if ((count ?? 0) >= 50) {
        setWatchlistMsg('Folder watchlist sudah penuh (maksimal 50 saham).')
        setWatchlistLoading(false)
        return
      }
    }

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
        {quote?.price != null ? (
          <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-5">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-2xl font-bold">{formatHarga(quote.price)}</p>
                <p
                  className={`text-sm font-medium mt-0.5 ${
                    (pctChange(quote.price, quote.previous_close) ?? 0) >= 0 ? 'text-[#22C55E]' : 'text-[#EF4444]'
                  }`}
                >
                  {(pctChange(quote.price, quote.previous_close) ?? 0) >= 0 ? '+' : ''}
                  {pctChange(quote.price, quote.previous_close)?.toFixed(2) ?? '0.00'}%
                </p>
              </div>
              <div className="text-right text-xs text-slate-500 space-y-0.5">
                <p>H: {formatHarga(quote.day_high)}</p>
                <p>L: {formatHarga(quote.day_low)}</p>
              </div>
            </div>
            {isStale(quote.updated_at) && (
              <p className="text-slate-600 text-[11px] mt-2">
                Data tertunda — terakhir diperbarui{' '}
                {quote.updated_at
                  ? new Date(quote.updated_at).toLocaleTimeString('id-ID', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : '-'}{' '}
                WIB
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-6 text-center">
            <p className="text-slate-500 text-sm">Data harga menyusul</p>
          </div>
        )}

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

          {signal && signal.unlocked && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg bg-white/5 px-3 py-2">
                  <p className="text-slate-500 text-xs">Buy Area</p>
                  <p className="font-medium">
                    {formatHarga(signal.buy_area_low ?? null)} - {formatHarga(signal.buy_area_high ?? null)}
                  </p>
                </div>
                <div className="rounded-lg bg-white/5 px-3 py-2">
                  <p className="text-slate-500 text-xs">Stop Loss</p>
                  <p className="font-medium text-[#EF4444]">{formatHarga(signal.stop_loss ?? null)}</p>
                </div>
                <div className="rounded-lg bg-white/5 px-3 py-2">
                  <p className="text-slate-500 text-xs">Target 1 (TP1)</p>
                  <p className="font-medium text-[#22C55E]">{formatHarga(signal.tp1 ?? null)}</p>
                </div>
                <div className="rounded-lg bg-white/5 px-3 py-2">
                  <p className="text-slate-500 text-xs">Target 2 (TP2)</p>
                  <p className="font-medium text-[#22C55E]">{formatHarga(signal.tp2 ?? null)}</p>
                </div>
              </div>

              <div className="rounded-lg bg-white/5 px-3 py-2 text-sm">
                <p className="text-slate-500 text-xs">Confidence</p>
                <p className="font-medium">
                  {signal.confidence_score != null ? `${signal.confidence_score}%` : 'Data belum cukup'}
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

          {signal && !signal.unlocked && (
            <div className="space-y-3">
              <div className="relative rounded-lg overflow-hidden">
                <div aria-hidden className="grid grid-cols-2 gap-2 text-sm blur-sm select-none pointer-events-none">
                  <div className="rounded-lg bg-white/5 px-3 py-2">
                    <p className="text-slate-500 text-xs">Buy Area</p>
                    <p className="font-medium">0.000 - 0.000</p>
                  </div>
                  <div className="rounded-lg bg-white/5 px-3 py-2">
                    <p className="text-slate-500 text-xs">Stop Loss</p>
                    <p className="font-medium">0.000</p>
                  </div>
                  <div className="rounded-lg bg-white/5 px-3 py-2">
                    <p className="text-slate-500 text-xs">Target 1 (TP1)</p>
                    <p className="font-medium">0.000</p>
                  </div>
                  <div className="rounded-lg bg-white/5 px-3 py-2">
                    <p className="text-slate-500 text-xs">Target 2 (TP2)</p>
                    <p className="font-medium">0.000</p>
                  </div>
                </div>
                <div className="absolute inset-0 flex items-center justify-center bg-[#0F172A]/40">
                  <p className="text-xs text-slate-300 font-medium">Buy Area · TP · SL · Confidence terkunci</p>
                </div>
              </div>

              {wallet && (
                <p className="text-slate-500 text-xs">
                  Sisa token hari ini: <span className="text-white font-medium">{wallet.balance}</span>
                  {' · '}Iklan tersisa: {Math.max(0, 3 - wallet.ad_unlock_count)}/3
                </p>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleUnlockWithToken}
                  disabled={unlockLoading !== null}
                  className="flex-1 rounded-lg px-3 py-2.5 text-xs font-semibold disabled:opacity-60 transition-opacity duration-200"
                  style={{
                    backgroundImage:
                      'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
                    color: '#fff',
                  }}
                >
                  {unlockLoading === 'token' ? 'Membuka...' : 'Lihat Penjelasan Lengkap (1 token)'}
                </button>
                <button
                  onClick={handleUnlockWithAd}
                  disabled={unlockLoading !== null}
                  className="flex-1 rounded-lg border border-white/10 px-3 py-2.5 text-xs font-medium text-slate-300 disabled:opacity-60"
                >
                  {unlockLoading === 'ad' ? 'Memuat iklan...' : 'Tonton Iklan untuk Buka'}
                </button>
              </div>

              {unlockMsg && <p className="text-[#EF4444] text-xs">{unlockMsg}</p>}
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
