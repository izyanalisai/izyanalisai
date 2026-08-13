'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { User } from '@supabase/supabase-js'

const GRADIENT =
  'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)'

type Profile = { is_premium: boolean | null }
type Subscription = {
  status: string
  plan: string
  period_end: string | null
  cancel_at_period_end: boolean
} | null

const METHODS = [
  { key: 'QRIS', label: 'QRIS' },
  { key: 'VA_BANK', label: 'Virtual Account Bank' },
  { key: 'DANA', label: 'DANA' },
  { key: 'OVO', label: 'OVO' },
  { key: 'GOPAY', label: 'GoPay' },
  { key: 'SHOPEEPAY', label: 'ShopeePay' },
] as const

const PREMIUM_PRICE = 99000 // TODO: pindahkan ke config/DB, jangan hardcode di frontend untuk produksi

const COMPARE_ROWS: [string, string, string][] = [
  ['Token AI per hari', '5', '50'],
  ['Unlock Sinyal', 'Token / Iklan (maks 3/hari)', 'Token (kuota besar)'],
  ['Upload Chart AI', '1x / hari', 'Unlimited'],
  ['Trading Plan', 'Modul 1-3', 'Semua 10 modul'],
  ['Radar Sektor', '—', '✓'],
  ['Sector Rotation (detail)', 'Lihat diagram saja', 'Klik sektor untuk detail'],
  ['AI Task aktif', '3 (Price Alert + Daily Summary)', '20 (semua jenis)'],
  ['Intelligence Network', '—', 'Notifikasi real-time'],
]

function formatRupiah(n: number) {
  return 'Rp ' + n.toLocaleString('id-ID')
}

export default function BerlanggananPage() {
  const router = useRouter()
  const supabase = createClient()

  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [subscription, setSubscription] = useState<Subscription>(null)
  const [loading, setLoading] = useState(true)
  const [method, setMethod] = useState<(typeof METHODS)[number]['key'] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    async function load() {
      const { data: userData } = await supabase.auth.getUser()
      if (!active) return
      if (!userData.user) {
        router.push('/login')
        return
      }
      setUser(userData.user)

      const { data: profileData } = await supabase
        .from('profiles')
        .select('is_premium')
        .eq('id', userData.user.id)
        .single()
      if (active) setProfile(profileData)

      const { data: subData } = await supabase
        .from('subscriptions')
        .select('status, plan, period_end, cancel_at_period_end')
        .eq('user_id', userData.user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (active) setSubscription(subData)

      if (active) setLoading(false)
    }
    load()
    return () => {
      active = false
    }
  }, [router, supabase])

  async function handleCancel() {
    if (!user) return
    if (!confirm('Batalkan langganan? Premium tetap aktif sampai akhir periode berjalan.')) return
    setSubmitting(true)
    setError(null)
    const { error: updErr } = await supabase
      .from('subscriptions')
      .update({ cancel_at_period_end: true, status: 'pending_cancel' })
      .eq('user_id', user.id)
      .eq('status', 'active')
    setSubmitting(false)
    if (updErr) {
      setError('Gagal membatalkan langganan. Coba lagi.')
      return
    }
    setSubscription((s) => (s ? { ...s, cancel_at_period_end: true, status: 'pending_cancel' } : s))
  }

  async function handleCheckout() {
    if (!user || !method) return
    setSubmitting(true)
    setError(null)

    // NOTE PRODUKSI: pembuatan payment "pending" ini hanya draft order.
    // Aktivasi Premium TIDAK BOLEH terjadi dari sini. Subscription hanya
    // boleh berubah status setelah verified webhook Midtrans masuk ke
    // backend (lihat dokumen 7.5 & 13). Endpoint create-payment + webhook
    // handler Midtrans belum dibuat — ini baru placeholder UI checkout.
    const { data, error: insErr } = await supabase
      .from('payments')
      .insert({
        user_id: user.id,
        amount: PREMIUM_PRICE,
        method,
        status: 'pending',
      })
      .select('id')
      .single()

    setSubmitting(false)
    if (insErr || !data) {
      setError('Gagal membuat pesanan. Coba lagi.')
      return
    }

    alert(
      'Integrasi Midtrans belum tersambung di backend, jadi pembayaran belum bisa diproses beneran. Order draft sudah tersimpan (status pending).'
    )
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto">
        <p className="text-slate-500 text-sm">Memuat...</p>
      </main>
    )
  }

  const isPremium = !!profile?.is_premium

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 pb-16 max-w-[480px] mx-auto lg:max-w-2xl lg:pl-64">
      <div className="flex items-center gap-3 mb-4">
        <Link href="/profil" className="text-sm text-slate-400">‹</Link>
        <h1 className="text-xl font-bold">Berlangganan</h1>
      </div>

      {isPremium ? (
        <div className="rounded-2xl p-5 mb-6" style={{ backgroundImage: GRADIENT }}>
          <p className="text-xs uppercase tracking-wide text-white/70">Status Langganan</p>
          <p className="text-lg font-bold mt-1">Premium Aktif</p>
          {subscription?.period_end && (
            <p className="text-xs text-white/80 mt-1">
              {subscription.cancel_at_period_end
                ? `Aktif sampai ${new Date(subscription.period_end).toLocaleDateString('id-ID')}, tidak diperpanjang otomatis.`
                : `Perpanjangan otomatis pada ${new Date(subscription.period_end).toLocaleDateString('id-ID')}.`}
            </p>
          )}
          {!subscription?.cancel_at_period_end && (
            <button
              onClick={handleCancel}
              disabled={submitting}
              className="mt-4 w-full rounded-xl bg-black/30 py-2.5 text-sm font-medium disabled:opacity-50"
            >
              Batalkan Langganan
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-2xl p-5 mb-6" style={{ backgroundImage: GRADIENT }}>
          <p className="text-xs uppercase tracking-wide text-white/70">Premium Bulanan</p>
          <p className="text-2xl font-bold mt-1">{formatRupiah(PREMIUM_PRICE)}<span className="text-sm font-normal">/bulan</span></p>
        </div>
      )}

      <p className="text-sm font-semibold mb-2">Perbandingan Free vs Premium</p>
      <div className="rounded-xl border border-white/10 overflow-hidden mb-6">
        <div className="grid grid-cols-3 bg-white/5 text-[11px] text-slate-400 px-3 py-2">
          <span>Fitur</span>
          <span className="text-center">Free</span>
          <span className="text-center">Premium</span>
        </div>
        {COMPARE_ROWS.map(([feat, free, premium]) => (
          <div key={feat} className="grid grid-cols-3 px-3 py-2.5 text-xs border-t border-white/5">
            <span className="text-slate-300">{feat}</span>
            <span className="text-center text-slate-500">{free}</span>
            <span className="text-center text-slate-100 font-medium">{premium}</span>
          </div>
        ))}
      </div>

      {!isPremium && (
        <>
          <p className="text-sm font-semibold mb-2">Pilih Metode Pembayaran</p>
          <div className="grid grid-cols-2 gap-2 mb-4">
            {METHODS.map((m) => (
              <button
                key={m.key}
                onClick={() => setMethod(m.key)}
                className={`rounded-xl border px-4 py-3 text-sm text-left transition-colors duration-200 ${
                  method === m.key
                    ? 'border-transparent text-white'
                    : 'border-white/10 text-slate-300 bg-white/5'
                }`}
                style={method === m.key ? { backgroundImage: GRADIENT } : undefined}
              >
                {m.label}
              </button>
            ))}
          </div>

          {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

          <button
            onClick={handleCheckout}
            disabled={!method || submitting}
            className="w-full rounded-xl py-3.5 text-sm font-semibold text-white disabled:opacity-40"
            style={{ backgroundImage: GRADIENT }}
          >
            {submitting ? 'Memproses...' : 'Bayar Sekarang'}
          </button>

          <p className="text-[11px] text-slate-500 mt-3 text-center">
            Dengan melanjutkan, kamu setuju dengan Terms dan Privacy Policy.
          </p>
        </>
      )}
    </main>
  )
}
