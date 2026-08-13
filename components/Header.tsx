'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { User } from '@supabase/supabase-js'

export default function Header() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user)
      setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })

    return () => {
      listener.subscription.unsubscribe()
    }
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <header className="sticky top-0 z-30 lg:hidden bg-[#0F172A]/95 backdrop-blur">
      <div className="flex items-center justify-between px-4 py-3 max-w-[480px] mx-auto">
        <span className="font-bold text-sm text-white">IzyAnalisAi</span>
        {!loading &&
          (user ? (
            <div className="flex items-center gap-3">
              <span className="text-slate-400 text-xs truncate max-w-[140px]">
                {user.email}
              </span>
              <button
                onClick={handleLogout}
                className="text-xs font-medium text-slate-300 border border-white/10 rounded-full px-3 py-1.5 hover:border-[#8B5CF6] transition-colors duration-200"
              >
                Keluar
              </button>
            </div>
          ) : (
            <a
              href="/login"
              className="text-xs font-medium text-white rounded-full px-3 py-1.5"
              style={{
                backgroundImage:
                  'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
              }}
            >
              Masuk
            </a>
          ))}
      </div>
      <div
        className="h-px w-full opacity-60"
        style={{
          backgroundImage:
            'linear-gradient(90deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
        }}
      />
    </header>
  )
}
