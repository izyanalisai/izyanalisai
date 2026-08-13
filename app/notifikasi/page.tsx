'use client'

import { createClient } from '@/lib/supabase/client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

type Notif = {
  id: string
  category: 'MARKET' | 'SIGNAL' | 'NEWS' | 'ECONOMIC_EVENT' | 'MORNING_BRIEFING' | 'UNUSUAL_ACTIVITY'
  title: string
  body: string | null
  reference_id: string | null
  is_read: boolean
  created_at: string
}

function formatDay(dateStr: string) {
  const d = new Date(dateStr)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, today)) return 'Hari ini'
  if (sameDay(d, yesterday)) return 'Kemarin'
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
}

export default function NotifikasiPage() {
  const supabase = createClient()
  const [notifs, setNotifs] = useState<Notif[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
    setNotifs((data as Notif[]) ?? [])
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    load()
  }, [load])

  const handleMarkAllRead = async () => {
    const { data: userRes } = await supabase.auth.getUser()
    if (!userRes.user) return
    await supabase.from('notifications').update({ is_read: true }).eq('user_id', userRes.user.id).eq('is_read', false)
    load()
  }

  const handleTap = async (n: Notif) => {
    if (!n.is_read) {
      await supabase.from('notifications').update({ is_read: true }).eq('id', n.id)
    }
    if (n.reference_id) {
      const { data: stock } = await supabase.from('stocks').select('ticker').eq('id', n.reference_id).maybeSingle()
      if (stock) {
        window.location.href = `/saham/${stock.ticker}`
        return
      }
    }
    load()
  }

  const grouped = notifs.reduce<Record<string, Notif[]>>((acc, n) => {
    const day = formatDay(n.created_at)
    acc[day] = acc[day] ?? []
    acc[day].push(n)
    return acc
  }, {})

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 pb-16 max-w-[480px] mx-auto lg:max-w-2xl lg:pl-64">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-slate-400">‹</Link>
          <h1 className="text-xl font-bold">Notifikasi</h1>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={handleMarkAllRead} className="text-xs text-[#3B82F6]">
            Tandai semua dibaca
          </button>
          <Link href="/notifikasi/pengaturan" className="text-slate-400 text-lg">⚙</Link>
        </div>
      </div>

      {loading && <p className="text-slate-500 text-sm">Memuat...</p>}
      {!loading && notifs.length === 0 && (
        <p className="text-slate-500 text-sm text-center py-10">Belum ada notifikasi.</p>
      )}

      {Object.entries(grouped).map(([day, items]) => (
        <div key={day} className="mb-4">
          <p className="text-xs text-slate-500 mb-2">{day}</p>
          <div className="space-y-2">
            {items.map((n) => (
              <button
                key={n.id}
                onClick={() => handleTap(n)}
                className={`w-full text-left rounded-xl border px-4 py-3 ${
                  n.is_read ? 'bg-white/5 border-white/10' : 'bg-[#3B82F6]/10 border-[#3B82F6]/30'
                }`}
              >
                <p className="text-sm font-medium">{n.title}</p>
                {n.body && <p className="text-xs text-slate-400 mt-0.5">{n.body}</p>}
                <p className="text-[10px] text-slate-600 mt-1">
                  {new Date(n.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} WIB
                </p>
              </button>
            ))}
          </div>
        </div>
      ))}
    </main>
  )
}
