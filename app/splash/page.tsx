'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { getPostLoginPath } from '@/lib/auth-flow'

// Dokumen 4.1 Splash:
// - Logo fade + scale, tagline, loading text crossfade, ~2 detik atau
//   sampai pengecekan login selesai.
// - Redirect: first open -> Onboarding. Onboarding selesai tapi belum
//   login -> Landing. Sudah login -> Home.
export default function SplashPage() {
  const router = useRouter()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    setVisible(true)

    const check = async () => {
      const onboardingDone = localStorage.getItem('izy_onboarding_done')
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()

      let destination = '/onboarding'
      if (onboardingDone) {
        destination = user ? await getPostLoginPath(supabase, user.id) : '/landing'
      }

      const elapsed = Date.now() - start
      const remaining = Math.max(0, 2000 - elapsed)
      setTimeout(() => {
        sessionStorage.setItem('izy_splash_shown', '1')
        router.replace(destination)
      }, remaining)
    }

    const start = Date.now()
    check()
  }, [router])

  return (
    <main className="min-h-screen relative overflow-hidden flex flex-col items-center justify-center text-white max-w-[480px] mx-auto">
      <div className="absolute inset-0 -z-10 animate-gradient-flow" />

      <div
        className={`flex flex-col items-center gap-4 transition-all duration-[1200ms] ease-out motion-reduce:transition-none ${
          visible ? 'opacity-100 scale-100' : 'opacity-0 scale-90'
        }`}
      >
        <div className="w-20 h-20 rounded-2xl bg-white/10 backdrop-blur flex items-center justify-center text-3xl font-bold">
          Iz
        </div>
        <p className="text-lg font-semibold tracking-wide">IzyAnalisAi</p>
        <p className="text-sm text-white/70">Ingat Saham, Ingat IzyAnalisAi.</p>
      </div>

      <p
        key={visible ? 'loading' : 'idle'}
        className="absolute bottom-14 text-xs text-white/50 transition-opacity duration-500 motion-reduce:transition-none"
      >
        Memuat…
      </p>
    </main>
  )
}
