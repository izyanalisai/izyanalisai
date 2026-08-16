'use client'

import { createClient } from '@/lib/supabase/client'
import { getPostLoginPath } from '@/lib/auth-flow'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import PlexusBackground from '@/components/PlexusBackground'

const GRADIENT =
  'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)'

type StockRow = {
  id: string
  ticker: string
  name: string
  quotes: { price: number | null; previous_close: number | null; volume: number | null } | null
}

type SignalRow = {
  id: string
  direction: 'BUY' | 'SELL'
  signal_tier: 'daily' | 'swing'
  timeframe: string | null
  created_at: string
  stock_id: string
  stocks: { ticker: string; name: string } | null
}

const tierLabel: Record<string, string> = {
  daily: 'Daily',
  swing: 'Swing',
}

type EconEvent = { id: string; event_name: string; country: string; event_date: string; impact: string | null }
type NewsItem = { id: string; title: string; sentiment: string | null; published_at: string }

function formatHarga(n: number | null | undefined) {
  if (n === null || n === undefined) return '-'
  return new Intl.NumberFormat('id-ID').format(n)
}

function pctChange(price: number | null, prev: number | null) {
  if (price === null || price === undefined || prev === null || prev === undefined || prev === 0) return null
  return ((price - prev) / prev) * 100
}

// Jam bursa IDX (WIB): Sesi 1 09:00-12:00, Sesi 2 13:30-15:00 (hari kerja saja).
function getMarketStatus(nowWIB: Date) {
  const day = nowWIB.getDay() // 0 Minggu - 6 Sabtu
  const minutes = nowWIB.getHours() * 60 + nowWIB.getMinutes()
  const isWeekday = day >= 1 && day <= 5

  const sesi1Open = 9 * 60
  const sesi1Close = 12 * 60
  const sesi2Open = 13 * 60 + 30
  const sesi2Close = 15 * 60

  if (isWeekday && ((minutes >= sesi1Open && minutes < sesi1Close) || (minutes >= sesi2Open && minutes < sesi2Close))) {
    const targetMinutes = minutes < sesi1Close ? sesi1Close : sesi2Close
    const diff = targetMinutes - minutes
    return { open: true, label: 'Bursa Buka', countdownLabel: 'Tutup dalam', diffMinutes: diff }
  }

  let diff: number
  if (isWeekday && minutes < sesi1Open) {
    diff = sesi1Open - minutes
  } else if (isWeekday && minutes >= sesi1Close && minutes < sesi2Open) {
    diff = sesi2Open - minutes
  } else {
    let daysAhead = 1
    let d = day
    if (isWeekday && minutes >= sesi2Close) {
      d = (day + 1) % 7
    } else if (day === 6) {
      daysAhead = 2
      d = (day + 2) % 7
    } else if (day === 0) {
      daysAhead = 1
      d = (day + 1) % 7
    }
    while (d === 0 || d === 6) {
      daysAhead += 1
      d = (d + 1) % 7
    }
    diff = daysAhead * 24 * 60 + sesi1Open - minutes
  }
  return { open: false, label: 'Bursa Tutup', countdownLabel: 'Buka dalam', diffMinutes: Math.max(diff, 0) }
}

function formatCountdown(totalMinutes: number) {
  const h = Math.floor(totalMinutes / 60)
  const m = Math.round(totalMinutes % 60)
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `${d} hari ${h % 24} jam`
  }
  return `${h} jam ${m} menit`
}

const directionStyle: Record<string, { text: string; bg: string }> = {
  BUY: { text: 'text-[#22C55E]', bg: 'bg-[#22C55E]/15' },
  SELL: { text: 'text-[#EF4444]', bg: 'bg-[#EF4444]/15' },
}

export default function Home() {
  const router = useRouter()
  const [fullName, setFullName] = useState<string | null>(null)
  const [unreadCount, setUnreadCount] = useState(0)
  const [avatarHref, setAvatarHref] = useState('/login')

  const [ihsg, setIhsg] = useState<{ value: number | null; previous_close: number | null; quality: string | null } | null>(null)
  const [stocks, setStocks] = useState<StockRow[]>([])
  const [signals, setSignals] = useState<SignalRow[]>([])
  const [econEvents, setEconEvents] = useState<EconEvent[]>([])
  const [news, setNews] = useState<NewsItem[]>([])
  const [aiInput, setAiInput] = useState('')
  const [tokenBalance, setTokenBalance] = useState<number | null>(null)

  const [now, setNow] = useState<Date | null>(null)
  const [loading, setLoading] = useState(true)

  // Dokumen 4.1: setiap buka app pertama kali dalam sesi browser, gerbang
  // lewat Splash dulu (yang lalu redirect ke Onboarding/Landing/Home sesuai
  // status). Setelah itu (dalam sesi yang sama) tidak diulang lagi.
  useEffect(() => {
    if (typeof window !== 'undefined' && !sessionStorage.getItem('izy_splash_shown')) {
      router.replace('/splash')
    }
  }, [router])

  useEffect(() => {
    const tick = () => {
      const wib = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }))
      setNow(wib)
    }
    tick()
    const id = setInterval(tick, 30000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const supabase = createClient()

    async function load() {
      const { data: userData } = await supabase.auth.getUser()
      const user = userData.user

      if (user) {
        setAvatarHref('/profil')
        const path = await getPostLoginPath(supabase, user.id)
        if (path !== '/') {
          window.location.href = path
          return
        }

        const [{ data: profile }, { count }, { data: wallet }] = await Promise.all([
          supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
          supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('is_read', false),
          supabase.from('token_wallets').select('balance').eq('user_id', user.id).maybeSingle(),
        ])
        setFullName(profile?.full_name ?? null)
        setUnreadCount(count ?? 0)
        setTokenBalance(wallet?.balance ?? null)
      }

      const [{ data: idx }, { data: stockData }, { data: signalData }, { data: econData }, { data: newsData }] =
        await Promise.all([
          supabase.from('market_index').select('value, previous_close, quality').eq('ticker', '^JKSE').maybeSingle(),
          supabase
            .from('stocks')
            .select('id, ticker, name, quotes ( price, previous_close, volume )')
            .eq('is_active', true),
          supabase
            .from('signals_public')
            .select('id, direction, signal_tier, timeframe, created_at, stock_id')
            .eq('status', 'ACTIVE')
            .is('superseded_by', null)
            .order('created_at', { ascending: false })
            .limit(3),
          supabase
            .from('economic_events')
            .select('id, event_name, country, event_date, impact')
            .gte('event_date', new Date().toISOString().slice(0, 10))
            .order('event_date', { ascending: true })
            .limit(3),
          supabase.from('news').select('id, title, sentiment, published_at').order('published_at', { ascending: false }).limit(3),
        ])

      const stockList = (stockData as unknown as StockRow[]) ?? []
      const stockById = new Map(stockList.map((s) => [s.id, s]))
      const enrichedSignals = ((signalData as unknown as SignalRow[]) ?? []).map((s) => ({
        ...s,
        stocks: stockById.has(s.stock_id)
          ? { ticker: stockById.get(s.stock_id)!.ticker, name: stockById.get(s.stock_id)!.name }
          : null,
      }))

      setIhsg(idx ?? null)
      setStocks(stockList)
      setSignals(enrichedSignals)
      setEconEvents(econData ?? [])
      setNews(newsData ?? [])
      setLoading(false)
    }

    load()
  }, [])

  const marketStatus = useMemo(() => (now ? getMarketStatus(now) : null), [now])

  const breadth = useMemo(() => {
    let up = 0
    let down = 0
    let flat = 0
    for (const s of stocks) {
      const pct = pctChange(s.quotes?.price ?? null, s.quotes?.previous_close ?? null)
      if (pct === null) continue
      if (pct > 0) up++
      else if (pct < 0) down++
      else flat++
    }
    const total = up + down + flat
    const advancingPct = total > 0 ? (up / total) * 100 : 0
    return { up, down, flat, total, advancingPct }
  }, [stocks])

  const topMovers = useMemo(() => {
    const withPct = stocks
      .map((s) => ({ ...s, pct: pctChange(s.quotes?.price ?? null, s.quotes?.previous_close ?? null) }))
      .filter((s) => s.pct !== null) as (StockRow & { pct: number })[]
    const gainers = [...withPct].sort((a, b) => b.pct - a.pct).slice(0, 5)
    const losers = [...withPct].sort((a, b) => a.pct - b.pct).slice(0, 5)
    return { gainers, losers }
  }, [stocks])

  const ihsgPct = pctChange(ihsg?.value ?? null, ihsg?.previous_close ?? null)

  function handleAskAI(e: React.FormEvent) {
    e.preventDefault()
    const q = aiInput.trim()
    router.push(q ? `/chat?q=${encodeURIComponent(q)}` : '/chat')
  }

  return (
    <main className="min-h-screen relative overflow-hidden bg-[#0F172A] text-white px-4 py-4 max-w-[480px] mx-auto">
      {/* Plexus subtle di belakang kartu-kartu — jangan naikkan opacity/density,
          Home padat data (IHSG, breadth, sinyal) dan butuh tetap kebaca cepat. */}
      <PlexusBackground density="subtle" />

      {/* Header: avatar, sapaan, notifikasi */}
      <div className="flex items-center justify-between">
        <Link href={avatarHref} className="flex items-center gap-2.5">
          <span
            className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
            style={{ backgroundImage: GRADIENT }}
          >
            {fullName ? fullName.charAt(0).toUpperCase() : '?'}
          </span>
          <div>
            <p className="text-[11px] text-slate-400 leading-none">Halo,</p>
            <p className="text-sm font-semibold leading-tight">{fullName ?? 'Trader'}</p>
          </div>
        </Link>
        <Link href="/notifikasi" className="relative w-9 h-9 flex items-center justify-center rounded-full bg-white/5 border border-white/10">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 8a6 6 0 1 1 12 0c0 4.5 1.5 6 2 6.5H4c.5-.5 2-2 2-6.5Z" />
            <path d="M10 19a2 2 0 0 0 4 0" />
          </svg>
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-[#F43F5E] text-[9px] flex items-center justify-center font-bold">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Link>
      </div>

      {/* Status Pasar */}
      <div className="mt-4 flex items-center justify-between rounded-xl bg-white/5 border border-white/10 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full transition-colors duration-300"
            style={{ backgroundColor: marketStatus?.open ? '#22C55E' : '#EF4444' }}
          />
          <span className="text-xs font-medium">{marketStatus?.label ?? 'Memuat...'}</span>
        </div>
        {marketStatus && (
          <span className="text-[11px] text-slate-400">
            {marketStatus.countdownLabel} {formatCountdown(marketStatus.diffMinutes)}
          </span>
        )}
      </div>

      {/* Kartu IHSG */}
      <div className="mt-3 rounded-2xl bg-white/5 border border-white/10 px-4 py-3.5">
        <p className="text-[11px] text-slate-400">IHSG</p>
        <div className="flex items-end justify-between mt-1">
          <p className="text-2xl font-bold tabular-nums transition-all duration-500 ease-out">
            {formatHarga(ihsg?.value ?? null)}
          </p>
          {ihsgPct !== null && (
            <div className={`text-right ${ihsgPct >= 0 ? 'text-[#22C55E]' : 'text-[#EF4444]'}`}>
              <p className="text-sm font-medium tabular-nums">
                {ihsgPct >= 0 ? '+' : ''}
                {ihsgPct.toFixed(2)}%
              </p>
            </div>
          )}
        </div>
        {ihsg?.quality && ihsg.quality !== 'FRESH' && (
          <p className="text-[10px] text-amber-400 mt-1">Data tertunda</p>
        )}
      </div>

      {/* Market Breadth. Foreign Flow disembunyikan sementara: tabel foreign_flow
          belum ada worker pengisi (Yahoo Finance tidak menyediakan data net
          buy/sell asing). Tampilkan lagi setelah ada sumber data resmi. */}
      <div className="mt-3">
        <div className="rounded-2xl bg-white/5 border border-white/10 px-4 py-3">
          <p className="text-[11px] text-slate-400">Market Breadth</p>
          <p className="text-sm mt-1.5">
            <span className="text-[#22C55E] font-semibold">{breadth.up} naik</span>{' '}
            <span className="text-slate-500">/</span>{' '}
            <span className="text-[#EF4444] font-semibold">{breadth.down} turun</span>
          </p>
          <p className="text-[10px] text-slate-500 mt-0.5">{breadth.flat} tidak berubah · {breadth.advancingPct.toFixed(0)}% advancing</p>
        </div>
      </div>

      {/* Tanya AI */}
      <form onSubmit={handleAskAI} className="mt-3 rounded-2xl bg-white/5 border border-white/10 px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-slate-300">Tanya AI</p>
          {tokenBalance !== null && <p className="text-[10px] text-slate-500">Sisa token: {tokenBalance}</p>}
        </div>
        <div className="flex gap-2">
          <input
            value={aiInput}
            onChange={(e) => setAiInput(e.target.value)}
            placeholder="Tanya apa saja soal saham atau pasar"
            className="flex-1 rounded-xl bg-black/20 border border-white/10 px-3 py-2 text-xs placeholder:text-slate-500 focus:outline-none focus:border-[#8B5CF6]"
          />
          <button
            type="submit"
            className="rounded-xl px-4 py-2 text-xs font-semibold shrink-0"
            style={{ backgroundImage: GRADIENT }}
          >
            Kirim
          </button>
        </div>
      </form>

      {/* Sinyal Terbaru */}
      <section className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">Sinyal Terbaru</h2>
          <Link href="/signal" className="text-[11px] text-slate-400">
            Lihat Semua ›
          </Link>
        </div>
        {signals.length === 0 && !loading && (
          <p className="text-xs text-slate-500">Belum ada sinyal aktif.</p>
        )}
        <div className="space-y-2">
          {signals.map((s) => {
            const style = directionStyle[s.direction] ?? directionStyle.SELL
            return (
              <Link
                key={s.id}
                href={`/saham/${s.stocks?.ticker ?? ''}`}
                className="flex items-center justify-between rounded-xl bg-white/5 border border-white/10 px-4 py-2.5"
              >
                <div>
                  <p className="text-sm font-semibold">{s.stocks?.ticker}</p>
                  <p className="text-[11px] text-slate-500">{s.stocks?.name}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-medium px-2 py-1 rounded-full border border-white/10 text-slate-300">
                    {tierLabel[s.signal_tier] ?? s.signal_tier}
                  </span>
                  <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${style.bg} ${style.text}`}>
                    {s.direction}
                  </span>
                </div>
              </Link>
            )
          })}
        </div>
      </section>

      {/* Kalender Ekonomi */}
      <section className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">Kalender Ekonomi</h2>
          <Link href="/kalender" className="text-[11px] text-slate-400">
            Lihat Semua ›
          </Link>
        </div>
        {econEvents.length === 0 && !loading && (
          <p className="text-xs text-slate-500">Tidak ada event pada rentang ini.</p>
        )}
        <div className="space-y-2">
          {econEvents.map((e) => (
            <div key={e.id} className="flex items-center justify-between rounded-xl bg-white/5 border border-white/10 px-4 py-2.5">
              <div>
                <p className="text-sm">{e.event_name}</p>
                <p className="text-[11px] text-slate-500">{e.country} · {new Date(e.event_date).toLocaleDateString('id-ID')}</p>
              </div>
              {e.impact && (
                <span className="text-[10px] uppercase text-slate-400">{e.impact}</span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Ringkasan Berita */}
      <section className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">Ringkasan Berita</h2>
          <Link href="/berita" className="text-[11px] text-slate-400">
            Semua Berita ›
          </Link>
        </div>
        {news.length === 0 && !loading && (
          <p className="text-xs text-slate-500">Sedang tidak ada berita.</p>
        )}
        <div className="space-y-2">
          {news.map((n) => (
            <div key={n.id} className="rounded-xl bg-white/5 border border-white/10 px-4 py-2.5">
              <p className="text-sm">{n.title}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Top Movers */}
      <section className="mt-4">
        <h2 className="text-sm font-semibold mb-2">Top Movers</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[11px] text-[#22C55E] font-medium mb-1.5">Gainer</p>
            <div className="space-y-1.5">
              {topMovers.gainers.map((s) => (
                <Link key={s.id} href={`/saham/${s.ticker}`} className="flex items-center justify-between rounded-lg bg-white/5 border border-white/10 px-2.5 py-1.5">
                  <span className="text-[11px] font-medium">{s.ticker}</span>
                  <span className="text-[11px] text-[#22C55E]">+{s.pct.toFixed(2)}%</span>
                </Link>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[11px] text-[#EF4444] font-medium mb-1.5">Loser</p>
            <div className="space-y-1.5">
              {topMovers.losers.map((s) => (
                <Link key={s.id} href={`/saham/${s.ticker}`} className="flex items-center justify-between rounded-lg bg-white/5 border border-white/10 px-2.5 py-1.5">
                  <span className="text-[11px] font-medium">{s.ticker}</span>
                  <span className="text-[11px] text-[#EF4444]">{s.pct.toFixed(2)}%</span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Shortcut */}
      <section className="mt-4 mb-6">
        <div className="grid grid-cols-4 gap-2">
          {[
            { href: '/screener', label: 'Screener' },
            { href: '/watchlist', label: 'Watchlist' },
            { href: '/trading-plan', label: 'Trading Plan' },
            { href: '/ai-task', label: 'AI Task' },
          ].map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="rounded-xl bg-white/5 border border-white/10 px-2 py-3 text-center text-[10px] font-medium text-slate-300 hover:border-[#8B5CF6] transition-colors duration-200"
            >
              {s.label}
            </Link>
          ))}
        </div>
      </section>
    </main>
  )
}
