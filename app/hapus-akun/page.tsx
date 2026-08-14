'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { User } from '@supabase/supabase-js'

type Step = 'loading' | 'set-password' | 'confirm'

export default function HapusAkunPage() {
  const router = useRouter()
  const supabase = createClient()

  const [user, setUser] = useState<User | null>(null)
  const [step, setStep] = useState<Step>('loading')

  const [newPassword, setNewPassword] = useState('')
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('')

  const [password, setPassword] = useState('')
  const [reason, setReason] = useState('')
  const [ack, setAck] = useState(false)

  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      const { data } = await supabase.auth.getUser()
      if (!active) return
      if (!data.user) {
        router.push('/login')
        return
      }
      setUser(data.user)
      const identities = data.user.identities ?? []
      const hasEmail = identities.some((i) => i.provider === 'email')
      setStep(hasEmail ? 'confirm' : 'set-password')
    }
    load()
    return () => {
      active = false
    }
  }, [])

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setError('Password minimal 8 karakter, kombinasi huruf dan angka.')
      return
    }
    if (newPassword !== newPasswordConfirm) {
      setError('Konfirmasi password tidak cocok.')
      return
    }
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    setLoading(false)
    if (error) {
      setError(error.message)
      return
    }
    setPassword(newPassword)
    setStep('confirm')
  }

  const handleDelete = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!ack) {
      setError('Centang dulu bahwa kamu paham konsekuensinya.')
      return
    }
    if (!user?.email || !password) {
      setError('Masukkan password untuk konfirmasi.')
      return
    }
    setLoading(true)

    // Verifikasi ulang password (reauthentication) sebelum hapus akun permanen
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password,
    })
    if (verifyError) {
      setLoading(false)
      setError('Password salah.')
      return
    }

    const { error: rpcError } = await supabase.rpc('request_account_deletion', {
      p_reason: reason || null,
    })
    if (rpcError) {
      setLoading(false)
      setError('Gagal memproses, coba lagi.')
      return
    }

    await supabase.auth.signOut()
    router.push('/login?accountDeleted=1')
  }

  if (step === 'loading') {
    return (
      <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto">
        <p className="text-slate-500 text-sm">Memuat...</p>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto pb-16">
      <h1 className="text-xl font-bold mb-1">Hapus Akun</h1>
      <p className="text-slate-400 text-sm mb-6">
        Tindakan ini berbeda dari sekadar berhenti berlangganan.
      </p>

      <div className="rounded-xl bg-[#EF4444]/10 border border-[#EF4444]/30 px-4 py-4 mb-6 space-y-2">
        <p className="text-sm font-semibold text-[#EF4444]">Sebelum lanjut, harap dipahami:</p>
        <ul className="text-xs text-slate-300 space-y-1.5 list-disc pl-4">
          <li>Semua data akun (watchlist, riwayat sinyal, trading plan, token) akan dihapus.</li>
          <li>Langganan Premium yang masih aktif akan dihentikan otomatis (tidak auto-renew lagi).</li>
          <li>Akun masuk masa pemulihan 30 hari — hubungi Dukungan dalam masa itu kalau berubah pikiran.</li>
          <li>Setelah 30 hari, data dihapus permanen dan tidak bisa dikembalikan.</li>
        </ul>
      </div>

      {step === 'set-password' && (
        <form onSubmit={handleSetPassword} className="space-y-4">
          <p className="text-sm text-slate-300">
            Akun kamu terdaftar lewat Google tanpa password. Buat password dulu supaya bisa
            melanjutkan konfirmasi hapus akun.
          </p>
          <input
            type="password"
            placeholder="Password baru"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
            required
          />
          <input
            type="password"
            placeholder="Konfirmasi password baru"
            value={newPasswordConfirm}
            onChange={(e) => setNewPasswordConfirm(e.target.value)}
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
            required
          />
          {error && <p className="text-xs text-[#EF4444]">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-white/10 border border-white/10 px-4 py-3 text-sm font-medium disabled:opacity-50"
          >
            {loading ? 'Menyimpan...' : 'Simpan & Lanjutkan'}
          </button>
        </form>
      )}

      {step === 'confirm' && (
        <form onSubmit={handleDelete} className="space-y-4">
          <textarea
            placeholder="Alasan (opsional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6] resize-none"
          />
          <input
            type="password"
            placeholder="Masukkan password untuk konfirmasi"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
            required
          />
          <label className="flex items-start gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="mt-0.5"
            />
            Saya paham konsekuensi di atas dan tetap ingin menghapus akun ini.
          </label>
          {error && <p className="text-xs text-[#EF4444]">{error}</p>}
          <button
            type="submit"
            disabled={loading || !ack}
            className="w-full rounded-xl bg-[#EF4444] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            {loading ? 'Memproses...' : 'Hapus Akun Permanen'}
          </button>
        </form>
      )}
    </main>
  )
}
