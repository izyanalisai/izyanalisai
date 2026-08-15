'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import PlexusBackground from '@/components/PlexusBackground'

export default function LandingPage() {
  const router = useRouter()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    const seen = localStorage.getItem('izy_onboarding_done')
    if (!seen) {
      router.replace('/onboarding')
    } else {
      setChecked(true)
    }
  }, [router])

  if (!checked) return null

  return (
    <main className="min-h-screen relative overflow-hidden text-white px-6 py-10 max-w-[480px] mx-auto flex flex-col justify-center">
      <div className="absolute inset-0 -z-10 animate-gradient-flow" />
      <PlexusBackground density="normal" />

      <span className="inline-block self-center rounded-full bg-white/10 border border-white/10 px-4 py-1.5 text-xs text-slate-300 mb-6">
        Analisa Saham Berbasis AI
      </span>

      <h1 className="text-3xl font-bold text-center leading-tight mb-3">
        Ingat Saham,<br />Ingat IzyAnalisAi.
      </h1>
      <p className="text-slate-400 text-sm text-center mb-8">
        Sinyal trading AI, analisa sektor, dan asisten pasar IDX dalam genggaman.
      </p>

      <div className="space-y-3 mb-8">
        <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
          <p className="font-semibold text-sm">Sinyal AI</p>
          <p className="text-slate-400 text-xs mt-0.5">Entry, target, dan stop loss yang jelas untuk tiap saham.</p>
        </div>
        <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
          <p className="font-semibold text-sm">Smart Money</p>
          <p className="text-slate-400 text-xs mt-0.5">Pantau rotasi sektor dan aliran dana pasar.</p>
        </div>
        <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
          <p className="font-semibold text-sm">Sentimen</p>
          <p className="text-slate-400 text-xs mt-0.5">Ringkasan berita dan sentimen pasar tiap hari.</p>
        </div>
      </div>

      <Link
        href="/login"
        className="w-full text-center rounded-xl px-4 py-3 text-sm font-semibold text-white mb-3"
        style={{ backgroundImage: 'linear-gradient(135deg, #3B82F6 0%, #8B5CF6 50%, #EC4899 100%)' }}
      >
        Masuk Sekarang
      </Link>
      <Link
        href="/daftar"
        className="w-full text-center rounded-xl px-4 py-3 text-sm font-semibold text-white border border-white/10"
      >
        Daftar Gratis
      </Link>
    </main>
  )
}
