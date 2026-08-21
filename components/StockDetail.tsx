'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import ChartUploadModal from '@/components/ChartUploadModal'

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
  market_time: string | null
}

type SignalTier = 'daily' | 'swing'

type SignalRpcResult = {
  id: string
  direction: 'BUY' | 'SELL'
  status: string
  signal_tier: SignalTier
  created_at: string
  unlocked: boolean
  entry_price?: number | null
  buy_area_low?: number | null
  buy_area_high?: number | null
  support_level?: number | null
  resistance_level?: number | null
  tp1?: number | null
  tp2?: number | null
  stop_loss?: number | null
  ai_reasoning?: { teknikal?: string; fundamental?: string; makro?: string } | null
}

type Wallet = {
  balance: number
  ad_unlock_count: number
}

type Indicator = {
  ema5: number | null
  ema9: number | null
  ema21: number | null
  ema50: number | null
  rsi14: number | null
  macd_line: number | null
  macd_signal: number | null
  macd_hist: number | null
  stoch_k: number | null
  stoch_d: number | null
  volume_avg20: number | null
  updated_at: string | null
}

type Fundamental = {
  pe_ratio: number | null
  pb_ratio: number | null
  net_profit: number | null
  market_cap: number | null
  updated_at: string | null
}

type WatchState = {
  state: string
  reason: string | null
  support_level: number | null
  resistance_level: number | null
  watch_direction: string | null
  watch_zone_low: number | null
  watch_zone_high: number | null
  bias: string | null
  last_close: number | null
  data_source: string | null
  updated_at: string | null
  rsi14: number | null
  ema21: number | null
  ema50: number | null
  macd_line: number | null
  macd_signal: number | null
  volume_avg20: number | null
}

const NETRAL_REASON_LABEL: Record<string, string> = {
  no_timeframe_confluence: 'Timeframe D1 dan W1 belum selaras untuk entry.',
  no_clear_bias: 'Bias arah belum jelas — struktur harga masih sideways.',
  overextended: 'Harga sudah terlalu jauh dari area entry struktural.',
  insufficient_data: 'Data candle belum cukup untuk analisa struktural.',
  setup_invalid: 'Setup tidak memenuhi aturan entry yang valid.',
  data_quality: 'Kualitas data tidak memenuhi syarat untuk generate sinyal.',
}

const directionStyle: Record<string, { bg: string; text: string; label: string }> = {
  BUY: { bg: 'bg-[#22C55E]/15', text: 'text-[#22C55E]', label: 'BUY' },
  SELL: { bg: 'bg-[#EF4444]/15', text: 'text-[#EF4444]', label: 'SELL' },
}

const tierLabel: Record<SignalTier, string> = {
  daily: 'Daily',
  swing: 'Swing',
}

function formatHarga(n: number | null | undefined) {
  if (n === null || n === undefined) return '-'
  return new Intl.NumberFormat('id-ID').format(n)
}

function pctChange(price: number | null, prev: number | null) {
  if (price === null || prev === null || prev === 0) return null
  return ((price - prev) / prev) * 100
}

// Spec v5.0 section 4.5 & 6.1: semua harga wajib berlabel jelas sebagai data EOD,
// tidak boleh terkesan "Real-time"/"Live"/"Terkini" karena sumber data primer adalah
// IDX End-of-Day (fallback Yahoo Finance D1/W1), bukan feed langsung.
function formatLabelHargaEod(marketTime: string | null) {
  if (!marketTime) return 'Harga Penutupan IDX'
  const tanggal = new Date(marketTime).toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
  })
  return `Harga Penutupan IDX — ${tanggal}`
}

function isStale(fetchedAt: string | null) {
  if (!fetchedAt) return true
  const diffMinutes = (Date.now() - new Date(fetchedAt).getTime()) / 60000
  return diffMinutes > 30
}

// Field yang diblur kalau sinyal masih terkunci.
function LockedField({ label }: { label: string }) {
  return (
    <div className="rounded-lg bg-white/5 px-3 py-2">
      <p className="text-slate-500 text-xs">{label}</p>
      <p className="font-medium select-none blur-sm">••••••</p>
    </div>
  )
}

export default function StockDetail({ ticker }: { ticker: string }) {
  const router = useRouter()
  const supabase = createClient()

  const [user, setUser] = useState<User | null>(null)
  const [stock, setStock] = useState<Stock | null>(null)
  const [quote, setQuote] = useState<Quote | null>(null)
  const [signal, setSignal] = useState<SignalRpcResult | null>(null)
  const [signalTier, setSignalTier] = useState<SignalTier>('daily')
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const [inWatchlist, setInWatchlist] = useState(false)
  const [watchlistLoading, setWatchlistLoading] = useState(false)
  const [watchlistMsg, setWatchlistMsg] = useState<string | null>(null)

  const [unlockLoading, setUnlockLoading] = useState(false)
  const [unlockMsg, setUnlockMsg] = useState<string | null>(null)
  const [showChartUpload, setShowChartUpload] = useState(false)
  const [indicator, setIndicator] = useState<Indicator | null>(null)
  const [fundamental, setFundamental] = useState<Fundamental | null>(null)
  const [watchState, setWatchState] = useState<WatchState | null>(null)

  const loadSignal = useCallback(async (stockId: string, tier: SignalTier) => {
    const { data, error } = await supabase.rpc('get_signal_for_stock', { p_stock_id: stockId, p_tier: tier })
    if (!error) setSignal(data as SignalRpcResult | null)
    // Selalu load watch state juga (untuk NETRAL display)
    const { data: wsData } = await supabase.rpc('get_watch_state_for_stock', { p_stock_id: stockId, p_tier: tier })
    if (wsData) setWatchState(wsData as WatchState)
  }, [supabase])

  const loadWallet = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_my_wallet')
    if (!error && data) setWallet(data as Wallet)
  }, [supabase])

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
        .select('price, previous_close, day_high, day_low, volume, quality, updated_at, market_time')
        .eq('stock_id', stockData.id)
        .maybeSingle()

      if (active) setQuote(quoteData)

      await loadSignal(stockData.id, signalTier)

      // Fetch indikator teknikal (D1 terbaru)
      const { data: indData } = await supabase
        .from('indicators')
        .select('ema5, ema9, ema21, ema50, rsi14, macd_line, macd_signal, macd_hist, stoch_k, stoch_d, volume_avg20, updated_at')
        .eq('stock_id', stockData.id)
        .eq('timeframe', 'D1')
        .order('ts', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (active && indData) setIndicator(indData as Indicator)

      // Fetch fundamental
      const { data: fundData } = await supabase
        .from('fundamentals')
        .select('pe_ratio, pb_ratio, net_profit, market_cap, updated_at')
        .eq('stock_id', stockData.id)
        .maybeSingle()
      if (active && fundData) setFundamental(fundData as Fundamental)

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

  // Reload sinyal saat user toggle Daily/Swing (dokumen 6.2: keduanya
  // berjalan independen, saham bisa punya sinyal di kedua tier sekaligus).
  useEffect(() => {
    if (stock) {
      loadSignal(stock.id, signalTier)
    }
  }, [signalTier, stock, loadSignal])

  const handleUnlockToken = async () => {
    if (!user) {
      router.push('/login')
      return
    }
    if (!stock) return

    setUnlockLoading(true)
    setUnlockMsg(null)

    const idempotencyKey = crypto.randomUUID()
    const { data, error } = await supabase.rpc('unlock_signal_with_token', {
      p_stock_id: stock.id,
      p_idempotency_key: idempotencyKey,
    })

    if (error) {
      if (error.message.includes('INSUFFICIENT_TOKENS')) {
        setUnlockMsg('Token habis. Tonton iklan atau upgrade Premium.')
      } else {
        setUnlockMsg('Gagal membuka sinyal. Coba lagi.')
      }
      setUnlockLoading(false)
      return
    }

    void data
    await loadSignal(stock.id, signalTier)
    await loadWallet()
    setUnlockLoading(false)
  }

  // CATATAN: unlock_signal_with_ad sudah di-REVOKE dari role authenticated di
  // database (lihat migration fix_signals_paywall_leak_and_harden_rpc dan
  // revoke_unlock_signal_with_ad_direct_access) supaya tidak ada jalan
  // unlock gratis tanpa bukti iklan selesai ditonton. Unlock via iklan yang
  // valid HANYA boleh terjadi lewat alur: SDK AdMod rewarded -> callback
  // onUserEarnedReward -> Google mengirim Server-Side Verification ke edge
  // function admob-ssv -> admob-ssv memanggil credit_ad_unlock_verified
  // (service role only). Sampai SDK AdMob web/native benar-benar terpasang
  // di halaman ini, tombolnya dinonaktifkan supaya tidak error membingungkan
  // atau (kalau suatu saat RPC lama ke-restore tanpa sengaja) tidak bisa
  // dipakai untuk unlock gratis. Jangan sambungkan tombol ini ke RPC
  // apa pun secara langsung dari client.
  const adUnlockReady = false

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
  const locked = signal && !signal.unlocked

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
            <p className="text-slate-500 text-[11px] font-medium tracking-wide mb-2">
              {formatLabelHargaEod(quote.market_time)}
            </p>
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

        <button
          onClick={() => setShowChartUpload(true)}
          className="w-full rounded-xl bg-white/5 border border-white/10 py-3 text-sm font-medium flex items-center justify-center gap-2"
        >
          Upload Chart untuk Analisis AI
        </button>

        <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-sm">Sinyal AI</h2>
            {dir && (
              <span className={`text-xs font-bold px-3 py-1 rounded-full ${dir.bg} ${dir.text}`}>
                {dir.label}
              </span>
            )}
          </div>

          <div className="flex gap-2 mb-3">
            {(['daily', 'swing'] as SignalTier[]).map((t) => (
              <button
                key={t}
                onClick={() => setSignalTier(t)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors duration-200 ${
                  signalTier === t
                    ? 'bg-[#8B5CF6]/20 border-[#8B5CF6] text-white'
                    : 'border-white/10 text-slate-400'
                }`}
              >
                {tierLabel[t]}
              </button>
            ))}
          </div>

          {!signal && (
            <div className="space-y-3">
              {/* Badge NETRAL */}
              <div className="flex items-center gap-2">
                <span className="px-3 py-1 rounded-full text-xs font-bold bg-slate-500/20 text-slate-400 border border-slate-500/30">
                  NETRAL
                </span>
                <span className="text-slate-500 text-xs">Analisa Struktur</span>
              </div>

              {/* Alasan */}
              {watchState?.reason && (
                <div className="rounded-lg bg-white/5 px-3 py-2 border border-white/5">
                  <p className="text-slate-500 text-xs mb-1">Kondisi Pasar</p>
                  <p className="text-sm text-slate-300">
                    {NETRAL_REASON_LABEL[watchState.reason] ?? watchState.reason}
                  </p>
                </div>
              )}

              {/* Support & Resistance */}
              {(watchState?.support_level || watchState?.resistance_level) && (
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-lg bg-white/5 px-3 py-2">
                    <p className="text-slate-500 text-xs">Support Terdekat</p>
                    <p className="font-medium text-[#22C55E]">{formatHarga(watchState.support_level)}</p>
                  </div>
                  <div className="rounded-lg bg-white/5 px-3 py-2">
                    <p className="text-slate-500 text-xs">Resistance Terdekat</p>
                    <p className="font-medium text-[#EF4444]">{formatHarga(watchState.resistance_level)}</p>
                  </div>
                </div>
              )}

              {/* Potensi Entry Bersyarat */}
              {watchState?.watch_direction && watchState?.watch_zone_low && (
                <div className="rounded-lg bg-white/5 px-3 py-2 border border-white/5">
                  <p className="text-slate-500 text-xs mb-1">Potensi Entry Bersyarat</p>
                  <p className="text-sm text-slate-300">
                    {watchState.watch_direction === 'BUY'
                      ? `Jika harga koreksi ke area ${formatHarga(watchState.watch_zone_low)}–${formatHarga(watchState.watch_zone_high)}, setup BUY berpotensi terbentuk.`
                      : `Jika harga breakdown di bawah ${formatHarga(watchState.watch_zone_low)}, setup SELL berpotensi terbentuk.`}
                  </p>
                </div>
              )}

              {/* Indikator Teknikal */}
              {(watchState?.rsi14 || indicator?.rsi14) && (
                <div className="space-y-1">
                  <p className="text-slate-500 text-xs uppercase tracking-wide">Indikator Teknikal</p>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div className="rounded-lg bg-white/5 px-3 py-2">
                      <p className="text-slate-500 text-xs">RSI 14</p>
                      <p className={`font-medium ${
                        (watchState?.rsi14 ?? indicator?.rsi14 ?? 50) > 70 ? 'text-[#EF4444]' :
                        (watchState?.rsi14 ?? indicator?.rsi14 ?? 50) < 30 ? 'text-[#22C55E]' : 'text-white'
                      }`}>
                        {(watchState?.rsi14 ?? indicator?.rsi14)?.toFixed(1) ?? '-'}
                      </p>
                    </div>
                    <div className="rounded-lg bg-white/5 px-3 py-2">
                      <p className="text-slate-500 text-xs">EMA 21</p>
                      <p className="font-medium">{formatHarga(watchState?.ema21 ?? indicator?.ema21)}</p>
                    </div>
                    <div className="rounded-lg bg-white/5 px-3 py-2">
                      <p className="text-slate-500 text-xs">EMA 50</p>
                      <p className="font-medium">{formatHarga(watchState?.ema50 ?? indicator?.ema50)}</p>
                    </div>
                  </div>
                  {(watchState?.volume_avg20 ?? indicator?.volume_avg20) && (
                    <div className="rounded-lg bg-white/5 px-3 py-2 text-sm">
                      <p className="text-slate-500 text-xs">Volume Avg 20</p>
                      <p className="font-medium">{formatHarga(watchState?.volume_avg20 ?? indicator?.volume_avg20)}</p>
                    </div>
                  )}
                </div>
              )}

              {/* Fallback jika tidak ada watch state sama sekali */}
              {!watchState && (
                <p className="text-slate-500 text-sm">Data struktur belum tersedia untuk {stock.ticker} — akan diperbarui malam ini.</p>
              )}

              {/* DYOR */}
              <p className="text-slate-600 text-xs pt-1">
                NETRAL bukan berarti tidak ada analisa. Pantau kembali setelah update berikutnya. DYOR.
              </p>
            </div>
          )}

          {signal && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                {locked ? (
                  <>
                    <LockedField label="Buy Area" />
                    <LockedField label="Stop Loss" />
                    <LockedField label="Target 1 (TP1)" />
                    <LockedField label="Target 2 (TP2)" />
                  </>
                ) : (
                  <>
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
                  </>
                )}
              </div>

              {locked ? (
                <div className="grid grid-cols-2 gap-2">
                  <LockedField label="Support" />
                  <LockedField label="Resistance" />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-lg bg-white/5 px-3 py-2">
                    <p className="text-slate-500 text-xs">Support</p>
                    <p className="font-medium">{formatHarga(signal.support_level)}</p>
                  </div>
                  <div className="rounded-lg bg-white/5 px-3 py-2">
                    <p className="text-slate-500 text-xs">Resistance</p>
                    <p className="font-medium">{formatHarga(signal.resistance_level)}</p>
                  </div>
                </div>
              )}

              {!locked && signal.ai_reasoning && (
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

              {locked && (
                <div className="space-y-2 pt-1">
                  {user && wallet && (
                    <p className="text-slate-500 text-[11px]">
                      Sisa token hari ini: {wallet.balance} · Iklan tersisa: {Math.max(0, 3 - wallet.ad_unlock_count)}x
                    </p>
                  )}
                  <button
                    onClick={handleUnlockToken}
                    disabled={unlockLoading}
                    className="w-full rounded-xl py-2.5 text-sm font-medium text-white disabled:opacity-60"
                    style={{
                      backgroundImage:
                        'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
                    }}
                  >
                    {unlockLoading ? 'Memproses...' : 'Lihat Penjelasan Lengkap (1 Token)'}
                  </button>
                  <button
                    disabled={!adUnlockReady}
                    title="Fitur nonton iklan akan aktif setelah integrasi AdMob rampung"
                    className="w-full rounded-xl py-2.5 text-sm font-medium border border-white/10 text-slate-500 opacity-50 cursor-not-allowed"
                  >
                    Tonton Iklan untuk Buka (Segera Hadir)
                  </button>
                  {unlockMsg && <p className="text-[#EF4444] text-xs text-center">{unlockMsg}</p>}
                </div>
              )}

              <p className="text-slate-600 text-[11px] pt-1 border-t border-white/10">
                DYOR — sinyal AI bukan jaminan profit.
              </p>
            </div>
          )}
        </div>

        <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-4">
          <h2 className="font-semibold text-sm mb-3">Indikator & Fundamental</h2>

          {!indicator && !fundamental && (
            <p className="text-slate-500 text-sm">Data belum tersedia.</p>
          )}

          {indicator && (
            <div className="mb-4">
              <p className="text-xs text-slate-500 mb-2 font-medium uppercase tracking-wide">Teknikal (D1)</p>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'RSI 14', value: indicator.rsi14?.toFixed(1),
                    color: indicator.rsi14 != null ? (indicator.rsi14 > 70 ? 'text-[#EF4444]' : indicator.rsi14 < 30 ? 'text-[#22C55E]' : 'text-white') : '' },
                  { label: 'EMA 50', value: indicator.ema50 != null ? formatHarga(Math.round(indicator.ema50)) : null, color: 'text-white' },
                  { label: 'EMA 21', value: indicator.ema21 != null ? formatHarga(Math.round(indicator.ema21)) : null, color: 'text-white' },
                  { label: 'MACD', value: indicator.macd_line?.toFixed(2),
                    color: indicator.macd_line != null ? (indicator.macd_line > 0 ? 'text-[#22C55E]' : 'text-[#EF4444]') : '' },
                  { label: 'Stoch %K', value: indicator.stoch_k?.toFixed(1),
                    color: indicator.stoch_k != null ? (indicator.stoch_k > 80 ? 'text-[#EF4444]' : indicator.stoch_k < 20 ? 'text-[#22C55E]' : 'text-white') : '' },
                  { label: 'Vol Avg20', value: indicator.volume_avg20 != null ? (indicator.volume_avg20 / 1_000_000).toFixed(1) + 'M' : null, color: 'text-white' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="rounded-lg bg-white/5 px-2.5 py-2">
                    <p className="text-slate-500 text-[10px]">{label}</p>
                    <p className={`text-sm font-medium ${color}`}>{value ?? '-'}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {fundamental && (
            <div>
              <p className="text-xs text-slate-500 mb-2 font-medium uppercase tracking-wide">Fundamental</p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'P/E Ratio', value: fundamental.pe_ratio != null ? Number(fundamental.pe_ratio).toFixed(2) + 'x' : null },
                  { label: 'P/B Ratio', value: fundamental.pb_ratio != null ? Number(fundamental.pb_ratio).toFixed(2) + 'x' : null },
                  { label: 'Net Profit', value: fundamental.net_profit != null ? 'Rp ' + (Number(fundamental.net_profit) / 1_000_000_000).toFixed(1) + 'B' : null },
                  { label: 'Market Cap', value: fundamental.market_cap != null ? 'Rp ' + (Number(fundamental.market_cap) / 1_000_000_000_000).toFixed(2) + 'T' : null },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded-lg bg-white/5 px-2.5 py-2">
                    <p className="text-slate-500 text-[10px]">{label}</p>
                    <p className="text-sm font-medium">{value ?? '-'}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
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
            onClick={() => (window.location.href = '/trading-plan')}
            className="flex-1 rounded-xl border border-white/10 px-4 py-3 text-sm font-medium text-slate-300"
          >
            Lihat Trading Plan
          </button>
        </div>
      </div>

      <ChartUploadModal
        open={showChartUpload}
        onClose={() => setShowChartUpload(false)}
        defaultTicker={stock.ticker}
      />
    </main>
  )
}
