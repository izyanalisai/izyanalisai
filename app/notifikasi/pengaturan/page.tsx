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

// FITUR BARU (15 Agustus 2026): Push Notification.
// Sebelumnya toggle di halaman ini cuma nyimpen preferensi kategori --
// tidak ada mekanisme yang bikin notifikasi beneran nyampe ke HP/browser
// user saat app tertutup. Sekarang ditambah tombol "Aktifkan Notifikasi
// Push" yang minta izin browser, subscribe ke Push API, dan simpan
// endpoint-nya ke tabel push_subscriptions supaya backend bisa kirim lewat
// edge function send-web-push.
//
// WAJIB: set NEXT_PUBLIC_VAPID_PUBLIC_KEY di environment variable Vercel
// (nilai publiknya sama dengan yang disimpan sebagai `vapid_public_key`
// di tabel internal_secrets Supabase -- key PUBLIC ini aman ditaruh di
// frontend/client, bukan yang private).
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ''

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

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

function PushNotificationCard() {
  const supabase = createClient()
  const [status, setStatus] = useState<'unsupported' | 'checking' | 'off' | 'on' | 'denied'>('checking')
  const [busy, setBusy] = useState(false)

  const checkStatus = useCallback(async () => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setStatus('unsupported')
      return
    }
    if (Notification.permission === 'denied') {
      setStatus('denied')
      return
    }
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      setStatus(sub ? 'on' : 'off')
    } catch {
      setStatus('off')
    }
  }, [])

  useEffect(() => {
    checkStatus()
  }, [checkStatus])

  const handleEnable = async () => {
    if (!VAPID_PUBLIC_KEY) {
      alert('NEXT_PUBLIC_VAPID_PUBLIC_KEY belum diset di environment variable.')
      return
    }
    setBusy(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'denied' : 'off')
        return
      }

      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })

      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
      const { data: userRes } = await supabase.auth.getUser()
      if (!userRes.user || !json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error('Gagal ambil data subscription')
      }

      const { error } = await supabase.from('push_subscriptions').upsert({
        user_id: userRes.user.id,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        user_agent: navigator.userAgent,
      }, { onConflict: 'user_id,endpoint' })

      if (error) throw error
      setStatus('on')
    } catch (err) {
      console.error('[push] gagal subscribe:', err)
      alert('Gagal mengaktifkan notifikasi push. Coba lagi.')
    } finally {
      setBusy(false)
    }
  }

  const handleDisable = async () => {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        const endpoint = sub.endpoint
        await sub.unsubscribe()
        const { data: userRes } = await supabase.auth.getUser()
        if (userRes.user) {
          await supabase.from('push_subscriptions').delete().eq('user_id', userRes.user.id).eq('endpoint', endpoint)
        }
      }
      setStatus('off')
    } catch (err) {
      console.error('[push] gagal unsubscribe:', err)
    } finally {
      setBusy(false)
    }
  }

  if (status === 'unsupported') {
    return (
      <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-3.5 mb-4">
        <p className="text-sm font-semibold">Notifikasi Push</p>
        <p className="text-xs text-slate-500 mt-1">Browser/perangkat ini tidak mendukung notifikasi push.</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-3.5 mb-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">Notifikasi Push</p>
          <p className="text-xs text-slate-500 mt-0.5">
            {status === 'on' && 'Aktif di perangkat ini.'}
            {status === 'off' && 'Belum aktif — nyalakan supaya notifikasi masuk walau app tertutup.'}
            {status === 'denied' && 'Diblokir dari pengaturan browser. Ubah izin notifikasi di browser dulu.'}
            {status === 'checking' && 'Memeriksa status...'}
          </p>
        </div>
        {status === 'on' ? (
          <button
            onClick={handleDisable}
            disabled={busy}
            className="text-xs font-medium text-slate-400 border border-white/10 rounded-full px-3 py-1.5 shrink-0 disabled:opacity-50"
          >
            Matikan
          </button>
        ) : (
          <button
            onClick={handleEnable}
            disabled={busy || status === 'denied'}
            className="text-xs font-medium text-white rounded-full px-3 py-1.5 shrink-0 disabled:opacity-50"
            style={{ backgroundImage: 'linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%)' }}
          >
            Aktifkan
          </button>
        )}
      </div>
    </div>
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

      <PushNotificationCard />

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
