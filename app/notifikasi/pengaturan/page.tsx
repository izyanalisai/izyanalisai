'use client'

import { createClient } from '@/lib/supabase/client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

type Prefs = {
  master_enabled: boolean
  market_alerts: boolean
  signal_alerts: boolean
  news_updates: boolean
  economic_events: boolean
  morning_briefing: boolean
  unusual_activity_alert: boolean
}

const TOGGLES: { key: keyof Prefs; label: string }[] = [
  { key: 'market_alerts', label: 'Peringatan Pasar' },
  { key: 'signal_alerts', label: 'Peringatan Sinyal' },
  { key: 'news_updates', label: 'Pembaruan Berita' },
  { key: 'economic_events', label: 'Economic Events' },
  { key: 'morning_briefing', label: 'Morning Briefing' },
  { key: 'unusual_activity_alert', label: 'Alert Volume Tidak Wajar' },
]

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={`w-11 h-6 rounded-full relative transition-colors duration-200 ${
        checked ? 'bg-[#3B82F6]' : 'bg-white/10'
      } ${disabled ? 'opacity-40' : ''}`}
    >
      <span
        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-200 ${
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

export default function PengaturanNotifikasiPage() {
  const supabase = createClient()
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data: userRes } = await supabase.auth.getUser()
    if (!userRes.user) return
    const { data } = await supabase
      .from('notification_preferences')
      .select('*')
      .eq('user_id', userRes.user.id)
      .maybeSingle()

    if (data) {
      setPrefs(data as Prefs)
    } else {
      setPrefs({
        master_enabled: true, market_alerts: true, signal_alerts: true,
        news_updates: true, economic_events: true, morning_briefing: true,
        unusual_activity_alert: true,
      })
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    load()
  }, [load])

  const handleToggle = async (key: keyof Prefs) => {
    if (!prefs) return
    const next = { ...prefs, [key]: !prefs[key] }
    setPrefs(next)

    const { data: userRes } = await supabase.auth.getUser()
    if (!userRes.user) return
    await supabase.from('notification_preferences').upsert({ user_id: userRes.user.id, ...next })
  }

  if (loading || !prefs) {
    return (
      <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto">
        <p className="text-slate-500 text-sm">Memuat...</p>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 pb-16 max-w-[480px] mx-auto lg:max-w-2xl lg:pl-64">
      <div className="flex items-center gap-3 mb-4">
        <Link href="/notifikasi" className="text-sm text-slate-400">‹</Link>
        <h1 className="text-xl font-bold">Pengaturan Notifikasi</h1>
      </div>

      <div className="rounded-xl bg-white/5 border border-white/10 divide-y divide-white/10">
        <div className="flex items-center justify-between px-4 py-3.5">
          <span className="text-sm font-semibold">Master Toggle</span>
          <Toggle checked={prefs.master_enabled} onChange={() => handleToggle('master_enabled')} />
        </div>
        {TOGGLES.map((t) => (
          <div key={t.key} className="flex items-center justify-between px-4 py-3.5">
            <span className={`text-sm ${!prefs.master_enabled ? 'text-slate-600' : 'text-slate-200'}`}>
              {t.label}
            </span>
            <Toggle
              checked={prefs[t.key]}
              onChange={() => handleToggle(t.key)}
              disabled={!prefs.master_enabled}
            />
          </div>
        ))}
      </div>
    </main>
  )
}
