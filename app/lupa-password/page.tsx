'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'

export default function LupaPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    const supabase = createClient()
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    setSent(true)
    setCooldown(60)
    setLoading(false)
  }

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-10 max-w-[480px] mx-auto flex flex-col justify-center">
      <h1 className="text-2xl font-bold mb-2 text-center">Lupa Password</h1>
      <p className="text-slate-400 text-sm text-center mb-6">
        Masukkan email kamu, kami kirim link untuk buat password baru.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
          required
        />

        {sent && (
          <p className="text-[#22C55E] text-sm">
            Jika email terdaftar, link reset sudah dikirim. Cek inbox atau folder spam.
          </p>
        )}

        <button
          type="submit"
          disabled={loading || cooldown > 0}
          className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
          style={{ backgroundImage: 'linear-gradient(135deg, #3B82F6 0%, #8B5CF6 50%, #EC4899 100%)' }}
        >
          {cooldown > 0 ? `Kirim ulang (${cooldown}s)` : loading ? 'Mengirim...' : 'Kirim Link Reset'}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-slate-400">
        <a href="/login" className="text-[#3B82F6] font-medium">Kembali ke Masuk</a>
      </p>
    </main>
  )
}
