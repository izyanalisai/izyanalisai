'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { User } from '@supabase/supabase-js'

type WatchlistFolder = { id: string; name: string }

type WatchlistItem = {
  id: string
  stock_id: string
  stocks: { ticker: string; name: string } | null
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

  useEffect(() => {
    if (!activeFolderId) return
    let active = true

    async function loadItems() {
      setLoading(true)
      const { data } = await supabase
        .from('watchlist_items')
        .select('id, stock_id, stocks ( ticker, name )')
        .eq('watchlist_id', activeFolderId)
        .order('created_at', { ascending: false })

      if (!active) return
      setItems((data as unknown as WatchlistItem[]) ?? [])
      setLoading(false)
    }

    loadItems()

    return () => {
      active = false
    }
  }, [activeFolderId])

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
      <h1 className="text-xl font-bold">Watchlist</h1>

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

        {!loading &&
          items.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between rounded-xl bg-white/5 border border-white/10 px-4 py-3"
            >
              <Link href={`/saham/${item.stocks?.ticker}`} className="flex-1 min-w-0">
                <p className="font-semibold text-sm">{item.stocks?.ticker ?? '-'}</p>
                <p className="text-slate-400 text-xs truncate">{item.stocks?.name ?? ''}</p>
              </Link>
              <button
                onClick={() => handleRemove(item.id)}
                disabled={removingId === item.id}
                className="text-slate-500 hover:text-[#EF4444] transition-colors duration-200 text-xs font-medium px-2 py-1 disabled:opacity-50"
              >
                {removingId === item.id ? '...' : 'Hapus'}
              </button>
            </div>
          ))}
      </div>
    </main>
  )
}
