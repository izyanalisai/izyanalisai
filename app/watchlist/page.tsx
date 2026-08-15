'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { User } from '@supabase/supabase-js'

const MAX_ITEMS_PER_FOLDER = 50

type WatchlistFolder = { id: string; name: string }

type WatchlistItem = {
  id: string
  stock_id: string
  stocks: {
    ticker: string
    name: string
    quotes: { price: number | null; previous_close: number | null } | null
  } | null
}

type StockSearchResult = { id: string; ticker: string; name: string }

type SavedSignalSnapshot = {
  id: string
  ticker: string
  name: string
  direction: 'BUY' | 'SELL'
  entry_price: number | null
  tp1: number | null
  tp2: number | null
  stop_loss: number | null
}

type SavedSignalRow = { id: string; created_at: string; signal_snapshot: SavedSignalSnapshot }

function formatHarga(n: number | null) {
  if (n === null || n === undefined) return '-'
  return new Intl.NumberFormat('id-ID').format(n)
}

function pctChange(price: number | null, prev: number | null) {
  if (price === null || prev === null || prev === 0) return null
  return ((price - prev) / prev) * 100
}

export default function WatchlistPage() {
  const router = useRouter()
  const supabase = createClient()

  const [user, setUser] = useState<User | null>(null)
  const [authChecked, setAuthChecked] = useState(false)

  const [folders, setFolders] = useState<WatchlistFolder[]>([])
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)
  const [items, setItems] = useState<WatchlistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const [creating, setCreating] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [folderMsg, setFolderMsg] = useState<string | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [addQuery, setAddQuery] = useState('')
  const [addResults, setAddResults] = useState<StockSearchResult[]>([])
  const [addMsg, setAddMsg] = useState<string | null>(null)

  // Sinyal Tersimpan dipisahkan dari daftar saham biasa (spec 5.7) — snapshot
  // statis, tidak berubah walau sinyal asli sudah expired/di-update.
  const [tab, setTab] = useState<'SAHAM' | 'SINYAL'>('SAHAM')
  const [savedSignals, setSavedSignals] = useState<SavedSignalRow[]>([])
  const [savedLoading, setSavedLoading] = useState(true)

  useEffect(() => {
    let active = true
    supabase.auth.getUser().then(({ data }) => {
      if (!active) return
      setUser(data.user)
      setAuthChecked(true)
      if (!data.user) router.push('/login')
    })
    return () => {
      active = false
    }
  }, [])

  const loadFolders = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from('watchlists')
      .select('id, name')
      .eq('user_id', userId)
      .order('created_at')

    setFolders(data ?? [])
    if (data && data.length > 0) {
      setActiveFolderId((current) => current ?? data[0].id)
    } else {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!user) return
    async function run() {
      await loadFolders(user!.id)
    }
    run()
  }, [user, loadFolders])

  const loadItems = useCallback(async (folderId: string) => {
    setLoading(true)
    const { data } = await supabase
      .from('watchlist_items')
      .select('id, stock_id, stocks ( ticker, name, quotes ( price, previous_close ) )')
      .eq('watchlist_id', folderId)
      .order('created_at', { ascending: false })

    setItems((data as unknown as WatchlistItem[]) ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!activeFolderId) return
    loadItems(activeFolderId)
  }, [activeFolderId, loadItems])

  useEffect(() => {
    if (!user) return
    let active = true
    setSavedLoading(true)
    supabase
      .from('saved_signals')
      .select('id, created_at, signal_snapshot')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (!active) return
        setSavedSignals((data as unknown as SavedSignalRow[]) ?? [])
        setSavedLoading(false)
      })
    return () => {
      active = false
    }
  }, [user])

  const handleUnsaveSignal = async (id: string) => {
    setSavedSignals((prev) => prev.filter((s) => s.id !== id))
    await supabase.from('saved_signals').delete().eq('id', id)
  }

  const handleRemove = async (itemId: string) => {
    setRemovingId(itemId)
    const { error } = await supabase.from('watchlist_items').delete().eq('id', itemId)
    if (!error) {
      setItems((prev) => prev.filter((i) => i.id !== itemId))
    }
    setRemovingId(null)
  }

  const handleCreateFolder = async () => {
    if (!user || !newFolderName.trim()) return
    if (folders.length >= 10) {
      setFolderMsg('Maksimal 10 folder watchlist.')
      return
    }
    const { data, error } = await supabase
      .from('watchlists')
      .insert({ user_id: user.id, name: newFolderName.trim() })
      .select('id, name')
      .single()

    if (error || !data) {
      setFolderMsg('Gagal membuat watchlist.')
      return
    }
    setFolders((prev) => [...prev, data])
    setActiveFolderId(data.id)
    setNewFolderName('')
    setCreating(false)
    setFolderMsg(null)
  }

  useEffect(() => {
    if (!addOpen || addQuery.trim().length < 1) {
      setAddResults([])
      return
    }
    let active = true
    const q = addQuery.toUpperCase()
    supabase
      .from('stocks')
      .select('id, ticker, name')
      .eq('is_active', true)
      .or(`ticker.ilike.%${q}%,name.ilike.%${q}%`)
      .limit(15)
      .then(({ data }) => {
        if (active) setAddResults(data ?? [])
      })
    return () => {
      active = false
    }
  }, [addQuery, addOpen])

  const existingStockIds = useMemo(() => new Set(items.map((i) => i.stock_id)), [items])

  const handleAddStock = async (stock: StockSearchResult) => {
    if (!activeFolderId) return
    if (items.length >= MAX_ITEMS_PER_FOLDER) {
      setAddMsg(`Maksimal ${MAX_ITEMS_PER_FOLDER} saham per folder.`)
      return
    }
    if (existingStockIds.has(stock.id)) {
      setAddMsg(`${stock.ticker} sudah ada di folder ini.`)
      return
    }

    const { error } = await supabase
      .from('watchlist_items')
      .insert({ watchlist_id: activeFolderId, stock_id: stock.id })

    if (error) {
      setAddMsg('Gagal menambahkan saham.')
      return
    }

    setAddMsg(null)
    setAddQuery('')
    setAddOpen(false)
    loadItems(activeFolderId)
  }

  if (!authChecked) {
    return (
      <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto">
        <p className="text-slate-500 text-sm">Memuat...</p>
      </main>
    )
  }

  if (!user) return null

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Watchlist</h1>
        {tab === 'SAHAM' && activeFolderId && folders.length > 0 && (
          <button
            onClick={() => {
              setAddOpen((v) => !v)
              setAddMsg(null)
            }}
            className="text-xs font-medium text-white rounded-full px-3 py-1.5"
            style={{
              backgroundImage:
                'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
            }}
          >
            + Tambah Kode
          </button>
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <button
          onClick={() => setTab('SAHAM')}
          className="flex-1 rounded-xl px-4 py-2 text-xs font-medium border transition-colors duration-200"
          style={
            tab === 'SAHAM'
              ? {
                  backgroundImage:
                    'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
                  color: '#fff',
                  borderColor: 'transparent',
                }
              : { color: '#94A3B8', borderColor: 'rgba(255,255,255,0.1)' }
          }
        >
          Daftar Saham
        </button>
        <button
          onClick={() => setTab('SINYAL')}
          className="flex-1 rounded-xl px-4 py-2 text-xs font-medium border transition-colors duration-200"
          style={
            tab === 'SINYAL'
              ? {
                  backgroundImage:
                    'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
                  color: '#fff',
                  borderColor: 'transparent',
                }
              : { color: '#94A3B8', borderColor: 'rgba(255,255,255,0.1)' }
          }
        >
          Sinyal Tersimpan{savedSignals.length > 0 ? ` (${savedSignals.length})` : ''}
        </button>
      </div>

      {tab === 'SINYAL' && (
        <div className="mt-5 space-y-2">
          {savedLoading && <p className="text-slate-500 text-sm">Memuat...</p>}
          {!savedLoading && savedSignals.length === 0 && (
            <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-8 text-center">
              <p className="text-slate-400 text-sm mb-3">Belum ada sinyal tersimpan</p>
              <Link
                href="/signal"
                className="inline-block text-xs font-medium text-white rounded-full px-4 py-2"
                style={{
                  backgroundImage:
                    'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
                }}
              >
                Lihat Sinyal
              </Link>
            </div>
          )}
          {!savedLoading &&
            savedSignals.map((row) => {
              const snap = row.signal_snapshot
              const up = snap.direction === 'BUY'
              return (
                <div
                  key={row.id}
                  className="rounded-xl bg-white/5 border border-white/10 px-4 py-3"
                >
                  <div className="flex items-center justify-between">
                    <Link href={`/saham/${snap.ticker}`} className="min-w-0">
                      <p className="font-semibold text-sm">
                        {snap.ticker}{' '}
                        <span className={up ? 'text-[#22C55E]' : 'text-[#EF4444]'}>
                          {snap.direction}
                        </span>
                      </p>
                      <p className="text-slate-400 text-xs truncate">{snap.name}</p>
                    </Link>
                    <button
                      onClick={() => handleUnsaveSignal(row.id)}
                      className="text-slate-500 hover:text-[#EF4444] transition-colors duration-200 text-xs font-medium px-2 py-1 shrink-0"
                    >
                      Hapus
                    </button>
                  </div>
                  <div className="mt-2 flex gap-3 text-[11px] text-slate-400">
                    {snap.entry_price != null && <span>Entry {formatHarga(snap.entry_price)}</span>}
                    {snap.tp1 != null && <span>TP1 {formatHarga(snap.tp1)}</span>}
                    {snap.stop_loss != null && <span>SL {formatHarga(snap.stop_loss)}</span>}
                  </div>
                  <p className="text-slate-600 text-[10px] mt-1">
                    Snapshot statis — disimpan {new Date(row.created_at).toLocaleDateString('id-ID')}
                  </p>
                </div>
              )
            })}
        </div>
      )}

      {tab === 'SAHAM' && (
      <>
      <div className="mt-4 flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {folders.map((f) => {
          const active = f.id === activeFolderId
          return (
            <button
              key={f.id}
              onClick={() => setActiveFolderId(f.id)}
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
              {f.name}
            </button>
          )
        })}

        {!creating && folders.length < 10 && (
          <button
            onClick={() => setCreating(true)}
            className="shrink-0 rounded-full px-4 py-2 text-xs font-medium border border-dashed border-white/20 text-slate-400"
          >
            + Folder
          </button>
        )}
      </div>

      {creating && (
        <div className="mt-3 flex gap-2">
          <input
            autoFocus
            type="text"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
            placeholder="Nama folder"
            className="flex-1 rounded-xl bg-white/5 border border-white/10 px-4 py-2.5 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
          />
          <button
            onClick={handleCreateFolder}
            className="rounded-xl px-4 py-2.5 text-sm font-medium text-white"
            style={{
              backgroundImage:
                'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
            }}
          >
            Simpan
          </button>
        </div>
      )}

      {folderMsg && <p className="text-[#EF4444] text-xs mt-2">{folderMsg}</p>}

      {addOpen && (
        <div className="mt-3 rounded-xl bg-white/5 border border-white/10 p-3">
          <input
            autoFocus
            type="text"
            value={addQuery}
            onChange={(e) => setAddQuery(e.target.value)}
            placeholder="Cari kode atau nama saham"
            className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
          />
          {addMsg && <p className="text-[#EF4444] text-xs mt-2">{addMsg}</p>}
          <div className="mt-2 max-h-64 overflow-y-auto space-y-1">
            {addResults.map((s) => (
              <button
                key={s.id}
                onClick={() => handleAddStock(s)}
                className="w-full text-left flex items-center justify-between rounded-lg px-3 py-2 hover:bg-white/5"
              >
                <div>
                  <p className="text-sm font-medium">{s.ticker}</p>
                  <p className="text-slate-400 text-xs truncate">{s.name}</p>
                </div>
                {existingStockIds.has(s.id) && (
                  <span className="text-slate-600 text-[11px]">Sudah ada</span>
                )}
              </button>
            ))}
            {addQuery.trim().length > 0 && addResults.length === 0 && (
              <p className="text-slate-500 text-xs px-3 py-2">Saham tidak ditemukan.</p>
            )}
          </div>
        </div>
      )}

      <div className="mt-5 space-y-2">
        {loading && <p className="text-slate-500 text-sm">Memuat...</p>}

        {!loading && folders.length === 0 && (
          <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-8 text-center">
            <p className="text-slate-400 text-sm mb-3">Belum ada saham di watchlist</p>
            <Link
              href="/"
              className="inline-block text-xs font-medium text-white rounded-full px-4 py-2"
              style={{
                backgroundImage:
                  'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
              }}
            >
              Cari Saham
            </Link>
          </div>
        )}

        {!loading && folders.length > 0 && items.length === 0 && (
          <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-8 text-center">
            <p className="text-slate-400 text-sm mb-3">Belum ada saham di folder ini</p>
            <button
              onClick={() => setAddOpen(true)}
              className="inline-block text-xs font-medium text-white rounded-full px-4 py-2"
              style={{
                backgroundImage:
                  'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
              }}
            >
              Cari Saham
            </button>
          </div>
        )}

        {!loading && items.length > 0 && (
          <p className="text-slate-600 text-[11px] text-right">
            {items.length}/{MAX_ITEMS_PER_FOLDER} saham
          </p>
        )}

        {!loading &&
          items.map((item) => {
            const price = item.stocks?.quotes?.price ?? null
            const prev = item.stocks?.quotes?.previous_close ?? null
            const pct = pctChange(price, prev)
            const up = pct !== null && pct >= 0

            return (
              <div
                key={item.id}
                className="flex items-center justify-between rounded-xl bg-white/5 border border-white/10 px-4 py-3"
              >
                <Link href={`/saham/${item.stocks?.ticker}`} className="flex-1 min-w-0">
                  <p className="font-semibold text-sm">{item.stocks?.ticker ?? '-'}</p>
                  <p className="text-slate-400 text-xs truncate">{item.stocks?.name ?? ''}</p>
                </Link>
                <div className="flex items-center gap-3 shrink-0">
                  {price !== null && (
                    <div className="text-right">
                      <p className="text-sm font-medium">{formatHarga(price)}</p>
                      {pct !== null && (
                        <p className={`text-xs ${up ? 'text-[#22C55E]' : 'text-[#EF4444]'}`}>
                          {up ? '+' : ''}
                          {pct.toFixed(2)}%
                        </p>
                      )}
                    </div>
                  )}
                  <button
                    onClick={() => handleRemove(item.id)}
                    disabled={removingId === item.id}
                    className="text-slate-500 hover:text-[#EF4444] transition-colors duration-200 text-xs font-medium px-2 py-1 disabled:opacity-50"
                  >
                    {removingId === item.id ? '...' : 'Hapus'}
                  </button>
                </div>
              </div>
            )
          })}
      </div>
      </>
      )}
    </main>
  )
}
