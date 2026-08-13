'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

function strength(pw: string): 'lemah' | 'cukup' | 'kuat' {
  if (pw.length >= 10 && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) return 'kuat'
  if (pw.length >= 8 && /[0-9]/.test(pw) && /[A-Za-z]/.test(pw)) return 'cukup'
  return 'lemah'
}

export default function ResetPasswordPage() {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setReady(true)
    })
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true)
      else setTimeout(() => setInvalid((prev) => (ready ? prev : true)), 2000)
    })
    return () => sub.subscription.unsubscribe()
  }, [ready])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      setError('Password minimal 8 karakter, kombinasi huruf dan angka.')
      return
    }
    if (password !== confirm) {
      setError('Konfirmasi password tidak cocok.')
      return
    }
    setLoading(true)
    const supabase = createClient()
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }
    router.replace('/login?reset=success')
  }

  if (invalid) {
    return (
      <main className="min-h-screen bg-[#0F172A] text-white px-4 py-10 max-w-[480px] mx-auto flex flex-col justify-center text-center">
        <p className="text-lg font-semibold mb-2">Link tidak berlaku</p>
        <p className="text-slate-400 text-sm mb-6">Link reset sudah kedaluwarsa atau sudah dipakai.</p>
        <a href="/lupa-password" className="text-[#3B82F6] font-medium text-sm">Kirim Ulang</a>
      </main>
    )
  }

  if (!ready) {
    return (
      <main className="min-h-screen bg-[#0F172A] text-white px-4 py-10 max-w-[480px] mx-auto flex items-center justify-center">
        <p className="text-slate-400 text-sm">Memverifikasi link...</p>
      </main>
    )
  }

  const s = strength(password)
  const strengthColor = s === 'kuat' ? 'text-[#22C55E]' : s === 'cukup' ? 'text-yellow-400' : 'text-[#EF4444]'

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-10 max-w-[480px] mx-auto flex flex-col justify-center">
      <h1 className="text-2xl font-bold mb-6 text-center">Buat Password Baru</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <input
            type="password"
            placeholder="Password baru"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
            required
          />
          {password && <p className={`text-xs mt-1 ${strengthColor}`}>Kekuatan: {s}</p>}
        </div>
        <input
          type="password"
          placeholder="Konfirmasi password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
          required
        />

        {error && <p className="text-[#EF4444] text-sm">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
          style={{ backgroundImage: 'linear-gradient(135deg, #3B82F6 0%, #8B5CF6 50%, #EC4899 100%)' }}
        >
          {loading ? 'Menyimpan...' : 'Simpan Password'}
        </button>
      </form>
    </main>
  )
}
