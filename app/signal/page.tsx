'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

type SignalRow = {
  id: string
  direction: 'BUY' | 'SELL'
  status: 'ACTIVE' | 'HIT_TP1'
  signal_tier: 'daily' | 'swing'
  created_at: string
  stock_id: string
  ticker: string
  name: string
  entry_price: number | null
  buy_area_low: number | null
  buy_area_high: number | null
  support_level: number | null
  resistance_level: number | null
  tp1: number | null
  tp2: number | null
  stop_loss: number | null
  current_price: number | null
  unlocked: boolean
}

// Dokumen 5.5: filter Semua, BUY, SELL, Daily, Swing. "Daily"/"Swing" di
// sini adalah signal_tier (dikirim ke RPC via p_tier), bukan direction.
type FilterValue = 'ALL' | 'BUY' | 'SELL' | 'daily' | 'swing'

const directionStyle: Record<string, { bg: string; text: string }> = {
  BUY: { bg: 'bg-[#22C55E]/15', text: 'text-[#22C55E]' },
  SELL: { bg: 'bg-[#EF4444]/15', text: 'text-[#EF4444]' },
}

const tierLabel: Record<string, string> = {
  daily: 'Daily',
  swing: 'Swing',
}

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: 'ALL', label: 'Semua' },
  { value: 'BUY', label: 'BUY' },
  { value: 'SELL', label: 'SELL' },
  { value: 'daily', label: 'Daily' },
  { value: 'swing', label: 'Swing' },
]

function formatHarga(n: number | null | undefined) {
  if (n === null || n === undefined) return '-'
  return new Intl.NumberFormat('id-ID').format(n)
}

// Dokumen 6.4 Progress Bar: ACTIVE menunjukkan posisi harga terkini di
// antara entry dan TP/SL; HIT_TP1 bar hijau sampai TP1.
function computeProgress(s: SignalRow): { pct: number; color: string } {
  if (s.status === 'HIT_TP1') return { pct: 100, color: '#22C55E' }

  const { entry_price, tp1, stop_loss, current_price, direction } = s
  if (entry_price == null || tp1 == null || stop_loss == null || current_price == null) {
    return { pct: 0, color: '#64748B' }
  }

  if (direction === 'BUY') {
    if (current_price <= stop_loss) return { pct: 100, color: '#EF4444' }
    if (current_price >= tp1) return { pct: 100, color: '#22C55E' }
    if (current_price >= entry_price) {
      const pct = ((current_price - entry_price) / (tp1 - entry_price)) * 100
      return { pct: Math.max(0, Math.min(100, pct)), color: '#22C55E' }
    }
    const pct = ((entry_price - current_price) / (entry_price - stop_loss)) * 100
    return { pct: Math.max(0, Math.min(100, pct)), color: '#EF4444' }
  }

  // SELL: arah kebalikan
  if (current_price >= stop_loss) return { pct: 100, color: '#EF4444' }
  if (current_price <= tp1) return { pct: 100, color: '#22C55E' }
  if (current_price <= entry_price) {
    const pct = ((entry_price - current_price) / (entry_price - tp1)) * 100
    return { pct: Math.max(0, Math.min(100, pct)), color: '#22C55E' }
  }
  const pct = ((current_price - entry_price) / (stop_loss - entry_price)) * 100
  return { pct: Math.max(0, Math.min(100, pct)), color: '#EF4444' }
}

export default function SignalPage() {
  const supabase = createClient()

  const [signals, setSignals] = useState<SignalRow[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterValue>('ALL')
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [tokenBalance, setTokenBalance] = useState<number | null>(null)
  const [unlockingId, setUnlockingId] = useState<string | null>(null)
  const [unlockErr, setUnlockErr] = useState<{ id: string; message: string } | null>(null)

  useEffect(() => {
    let active = true

    async function load() {
      const { data: userData } = await supabase.auth.getUser()
      if (active) setUserId(userData.user?.id ?? null)

      const { data } = await supabase.rpc('list_active_signals')
      if (!active) return
      setSignals((data as SignalRow[]) ?? [])
      setLoading(false)

      if (userData.user) {
        const { data: saved } = await supabase
          .from('saved_signals')
          .select('signal_snapshot')
          .eq('user_id', userData.user.id)
        if (active && saved) {
          const ids = new Set(
            saved
              .map((row) => (row.signal_snapshot as { id?: string })?.id)
              .filter((id): id is string => Boolean(id))
          )
          setSavedIds(ids)
        }

        const { data: wallet } = await supabase
          .from('token_wallets')
          .select('balance')
          .eq('user_id', userData.user.id)
          .maybeSingle()
        if (active) setTokenBalance(wallet?.balance ?? null)
      }
    }

    load()

    return () => {
      active = false
    }
  }, [])

  const filtered = useMemo(() => {
    let list = signals

    if (filter === 'BUY' || filter === 'SELL') {
      list = list.filter((s) => s.direction === filter)
    } else if (filter === 'daily' || filter === 'swing') {
      list = list.filter((s) => s.signal_tier === filter)
    }

    if (query) {
      const q = query.toUpperCase()
      list = list.filter(
        (s) => s.ticker.includes(q) || s.name.toUpperCase().includes(q)
      )
    }

    return list
  }, [signals, query, filter])

  async function handleBookmark(s: SignalRow) {
    if (!userId) return
    if (savedIds.has(s.id)) return // sudah tersimpan, snapshot bersifat immutable

    await supabase.from('saved_signals').insert({
      user_id: userId,
      signal_snapshot: s,
    })
    setSavedIds((prev) => new Set(prev).add(s.id))
  }

  // Sama seperti alur unlock di Detail Saham (dokumen 6.5): 1 token per
  // saham unik per hari. RPC ini yang menentukan angka, bukan client.
  async function handleUnlockToken(s: SignalRow) {
    if (!userId) {
      window.location.href = '/login'
      return
    }

    setUnlockingId(s.id)
    setUnlockErr(null)

    const idempotencyKey = crypto.randomUUID()
    const { error } = await supabase.rpc('unlock_signal_with_token', {
      p_stock_id: s.stock_id,
      p_idempotency_key: idempotencyKey,
    })

    if (error) {
      setUnlockErr({
        id: s.id,
        message: error.message.includes('INSUFFICIENT_TOKENS')
          ? 'Token habis. Buka di Detail Saham untuk opsi nonton iklan atau upgrade Premium.'
          : 'Gagal membuka sinyal. Coba lagi.',
      })
      setUnlockingId(null)
      return
    }

    const { data } = await supabase.rpc('list_active_signals')
    setSignals((data as SignalRow[]) ?? [])

    const { data: wallet } = await supabase
      .from('token_wallets')
      .select('balance')
      .eq('user_id', userId)
      .maybeSingle()
    setTokenBalance(wallet?.balance ?? null)

    setUnlockingId(null)
  }

  function handleCopy(s: SignalRow) {
    const text = [
      `${s.ticker} - ${s.direction}`,
      s.buy_area_low != null && s.buy_area_high != null
        ? `Buy Area: ${formatHarga(s.buy_area_low)} - ${formatHarga(s.buy_area_high)}`
        : null,
      s.tp1 != null ? `TP1: ${formatHarga(s.tp1)}` : null,
      s.tp2 != null ? `TP2: ${formatHarga(s.tp2)}` : null,
      s.stop_loss != null ? `Stop Loss: ${formatHarga(s.stop_loss)}` : null,
      s.support_level != null ? `Support: ${formatHarga(s.support_level)}` : null,
      s.resistance_level != null ? `Resistance: ${formatHarga(s.resistance_level)}` : null,
      'DYOR - bukan jaminan profit.',
    ]
      .filter(Boolean)
      .join('\n')

    navigator.clipboard?.writeText(text)
    setCopiedId(s.id)
    setTimeout(() => setCopiedId((id) => (id === s.id ? null : id)), 1500)
  }

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

      <div className="mt-5 space-y-3">
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
            const progress = computeProgress(s)
            const isSaved = savedIds.has(s.id)

            return (
              <div
                key={s.id}
                className="rounded-xl bg-white/5 border border-white/10 px-4 py-3 hover:border-[#8B5CF6] transition-colors duration-200"
              >
                <Link href={`/saham/${s.ticker}`} className="block">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm">{s.ticker}</p>
                      <p className="text-slate-400 text-xs truncate">{s.name}</p>
                    </div>

                    <div className="shrink-0 flex items-center gap-1.5 ml-2">
                      <span className="text-[10px] font-medium px-2 py-1 rounded-full border border-white/10 text-slate-300">
                        {tierLabel[s.signal_tier] ?? s.signal_tier}
                      </span>
                      <span
                        className={`text-xs font-bold px-3 py-1 rounded-full ${dir.bg} ${dir.text}`}
                      >
                        {s.direction}
                      </span>
                    </div>
                  </div>

                  {/* Progress Bar — dokumen 6.4 */}
                  <div className="mt-3 h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
                      style={{ width: `${progress.pct}%`, backgroundColor: progress.color }}
                    />
                  </div>

                  {s.unlocked ? (
                    <div className="mt-2 space-y-1 text-xs">
                      {s.buy_area_low != null && s.buy_area_high != null && (
                        <p className="text-slate-300">
                          Buy Area: <span className="font-medium">{formatHarga(s.buy_area_low)} - {formatHarga(s.buy_area_high)}</span>
                        </p>
                      )}
                      <div className="flex gap-3 text-slate-300">
                        {s.tp1 != null && <span>TP1: <span className="text-[#22C55E] font-medium">{formatHarga(s.tp1)}</span></span>}
                        {s.tp2 != null && <span>TP2: <span className="text-[#22C55E] font-medium">{formatHarga(s.tp2)}</span></span>}
                        {s.stop_loss != null && <span>SL: <span className="text-[#EF4444] font-medium">{formatHarga(s.stop_loss)}</span></span>}
                      </div>
                      {(s.support_level != null || s.resistance_level != null) && (
                        <div className="flex gap-3 text-slate-500">
                          {s.support_level != null && <span>Support: {formatHarga(s.support_level)}</span>}
                          {s.resistance_level != null && <span>Resistance: {formatHarga(s.resistance_level)}</span>}
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-slate-500 text-xs mt-2">
                      Buy Area, TP, SL, Support & Resistance terkunci
                    </p>
                  )}
                </Link>

                {!s.unlocked && (
                  <div className="mt-2 space-y-1.5">
                    <button
                      onClick={() => handleUnlockToken(s)}
                      disabled={unlockingId === s.id}
                      className="w-full rounded-lg py-2 text-xs font-medium text-white disabled:opacity-60"
                      style={{
                        backgroundImage:
                          'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
                      }}
                    >
                      {unlockingId === s.id ? 'Memproses...' : 'Lihat Penjelasan Lengkap (1 Token)'}
                    </button>
                    {userId && tokenBalance !== null && (
                      <p className="text-slate-600 text-[10px] text-center">Sisa token hari ini: {tokenBalance}</p>
                    )}
                    {unlockErr && unlockErr.id === s.id && (
                      <p className="text-[#EF4444] text-[10px] text-center">{unlockErr.message}</p>
                    )}
                  </div>
                )}

                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => handleCopy(s)}
                    className="flex-1 rounded-lg border border-white/10 py-1.5 text-xs text-slate-300 hover:border-[#3B82F6] transition-colors duration-200"
                  >
                    {copiedId === s.id ? 'Tersalin ✓' : 'Copy'}
                  </button>
                  <button
                    onClick={() => handleBookmark(s)}
                    disabled={!userId}
                    className={`flex-1 rounded-lg border py-1.5 text-xs transition-colors duration-200 disabled:opacity-40 ${
                      isSaved
                        ? 'border-[#8B5CF6] text-[#8B5CF6] bg-[#8B5CF6]/10'
                        : 'border-white/10 text-slate-300 hover:border-[#8B5CF6]'
                    }`}
                  >
                    {isSaved ? 'Tersimpan ✓' : 'Bookmark'}
                  </button>
                </div>
              </div>
            )
          })}
      </div>
    </main>
  )
}
