'use client'

import { createClient } from '@/lib/supabase/client'
import { getPostLoginPath } from '@/lib/auth-flow'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import PlexusBackground from '@/components/PlexusBackground'

const MAX_ATTEMPTS = 5
const LOCK_MS = 15 * 60 * 1000

export default function DaftarPage() {
  const router = useRouter()
  const [step, setStep] = useState<'form' | 'otp'>('form')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [attempts, setAttempts] = useState(0)
  const [lockUntil, setLockUntil] = useState<number | null>(null)
  const inputsRef = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  const locked = lockUntil !== null && Date.now() < lockUntil

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const supabase = createClient()
    const { error } = await supabase.auth.signUp({ email, password })
    setLoading(false)
    if (error) {
      setError(error.message)
      return
    }
    setStep('otp')
    setCooldown(60)
  }

  const handleResend = async () => {
    setError(null)
    const supabase = createClient()
    await supabase.auth.resend({ type: 'signup', email })
    setCooldown(60)
  }

  const handleOtpChange = (i: number, val: string) => {
    if (!/^[0-9]?$/.test(val)) return
    const next = [...otp]
    next[i] = val
    setOtp(next)
    if (val && i < 5) inputsRef.current[i + 1]?.focus()
  }

  const handleVerify = async () => {
    if (locked) return
    const token = otp.join('')
    if (token.length !== 6) return
    setError(null)
    setLoading(true)
    const supabase = createClient()
    const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'signup' })
    setLoading(false)

    if (error || !data.user) {
      const nextAttempts = attempts + 1
      setAttempts(nextAttempts)
      setOtp(['', '', '', '', '', ''])
      inputsRef.current[0]?.focus()
      if (nextAttempts >= MAX_ATTEMPTS) {
        setLockUntil(Date.now() + LOCK_MS)
        setError('Terlalu banyak percobaan salah. Coba lagi dalam 15 menit.')
      } else {
        setError('Kode OTP salah. Coba lagi.')
      }
      return
    }

    const path = await getPostLoginPath(supabase, data.user.id)
    router.replace(path)
  }

  const handleGoogleSignUp = async () => {
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

  if (step === 'otp') {
    return (
      <main className="min-h-screen relative overflow-hidden bg-[#0F172A] text-white px-4 py-10 max-w-[480px] mx-auto flex flex-col justify-center">
        <PlexusBackground density="normal" />
        <h1 className="text-2xl font-bold mb-2 text-center">Verifikasi Email</h1>
        <p className="text-slate-400 text-sm text-center mb-6">
          Masukkan 6 digit kode yang dikirim ke {email}
        </p>

        <div className="flex justify-center gap-2 mb-5">
          {otp.map((digit, i) => (
            <input
              key={i}
              ref={(el) => {
                inputsRef.current[i] = el
              }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              disabled={locked}
              onChange={(e) => handleOtpChange(i, e.target.value)}
              className="w-11 h-13 text-center text-lg rounded-xl bg-white/5 border border-white/10 focus:outline-none focus:border-[#3B82F6] disabled:opacity-40"
            />
          ))}
        </div>

        {error && <p className="text-[#EF4444] text-sm text-center mb-3">{error}</p>}

        <button
          onClick={handleVerify}
          disabled={loading || locked || otp.join('').length !== 6}
          className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-40 mb-3"
          style={{ backgroundImage: 'linear-gradient(135deg, #3B82F6 0%, #8B5CF6 50%, #EC4899 100%)' }}
        >
          {loading ? 'Memverifikasi...' : 'Verifikasi'}
        </button>

        <button
          onClick={handleResend}
          disabled={cooldown > 0 || locked}
          className="w-full text-center text-sm text-slate-400 disabled:opacity-40"
        >
          {cooldown > 0 ? `Kirim ulang kode (${cooldown}s)` : 'Kirim Ulang Kode'}
        </button>
      </main>
    )
  }

  return (
    <main className="min-h-screen relative overflow-hidden bg-[#0F172A] text-white px-4 py-10 max-w-[480px] mx-auto flex flex-col justify-center">
      <PlexusBackground density="normal" />
      <h1
        className="text-3xl font-bold bg-clip-text text-transparent mb-8 text-center"
        style={{ backgroundImage: 'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)' }}
      >
        Daftar
      </h1>

      <form onSubmit={handleSignUp} className="space-y-4">
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
          placeholder="Password (min 8 karakter)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
          required
          minLength={8}
        />

        {error && <p className="text-[#EF4444] text-sm">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
          style={{ backgroundImage: 'linear-gradient(135deg, #3B82F6 0%, #8B5CF6 50%, #EC4899 100%)' }}
        >
          {loading ? 'Memproses...' : 'Daftar'}
        </button>
      </form>

      <div className="my-5 text-center text-slate-500 text-sm">atau</div>

      <button
        onClick={handleGoogleSignUp}
        disabled={googleLoading}
        className="w-full flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-white hover:border-[#8B5CF6] transition-colors disabled:opacity-60"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
          <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
          <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z" />
          <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
        </svg>
        {googleLoading ? 'Menghubungkan...' : 'Daftar dengan Google'}
      </button>

      <p className="mt-5 text-center text-sm text-slate-400">
        Sudah punya akun?{' '}
        <a href="/login" className="text-[#3B82F6] font-medium">Masuk</a>
      </p>
    </main>
  )
      }
