'use client'

import { createClient } from '@/lib/supabase/client'
import { getPostLoginPath } from '@/lib/auth-flow'
import { useEffect, useState } from 'react'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [accountDeletedNotice, setAccountDeletedNotice] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('accountDeleted') === '1') {
      setAccountDeletedNotice(true)
    }
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const supabase = createClient()
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error || !data.user) {
      setError(error?.message ?? 'Login gagal.')
      setLoading(false)
      return
    }
    const path = await getPostLoginPath(supabase, data.user.id)
    window.location.href = path
  }

  const handleGoogleLogin = async () => {
    setError(null)
    setGoogleLoading(true)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    if (error) {
      setError(error.message)
      setGoogleLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-10 max-w-[480px] mx-auto flex flex-col justify-center">
      <h1
        className="text-3xl font-bold bg-clip-text text-transparent mb-8 text-center"
        style={{ backgroundImage: 'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)' }}
      >
        Masuk
      </h1>

      {accountDeletedNotice && (
        <div className="rounded-xl bg-[#EF4444]/10 border border-[#EF4444]/30 px-4 py-3 mb-4">
          <p className="text-sm text-[#EF4444]">
            Akun ini sudah dalam proses penghapusan. Masih dalam masa pemulihan 30 hari —
            hubungi Dukungan lewat WhatsApp kalau kamu ingin membatalkannya.
          </p>
        </div>
      )}

      <form onSubmit={handleLogin} className="space-y-4">
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
          required
        />

        <div className="text-right -mt-2">
          <a href="/lupa-password" className="text-xs text-slate-400 hover:text-[#3B82F6]">
            Lupa password?
          </a>
        </div>

        {error && <p className="text-[#EF4444] text-sm">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
          style={{ backgroundImage: 'linear-gradient(135deg, #3B82F6 0%, #8B5CF6 50%, #EC4899 100%)' }}
        >
          {loading ? 'Memproses...' : 'Masuk'}
        </button>
      </form>

      <div className="my-5 text-center text-slate-500 text-sm">atau</div>

      <button
        onClick={handleGoogleLogin}
        disabled={googleLoading}
        className="w-full flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-white hover:border-[#8B5CF6] transition-colors disabled:opacity-60"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
          <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
          <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z" />
          <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
        </svg>
        {googleLoading ? 'Menghubungkan...' : 'Masuk dengan Google'}
      </button>

      <p className="mt-5 text-center text-sm text-slate-400">
        Belum punya akun?{' '}
        <a href="/daftar" className="text-[#3B82F6] font-medium">Daftar</a>
      </p>
    </main>
  )
}
