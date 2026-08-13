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
    <header style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '12px 24px',
      borderBottom: '1px solid #333',
    }}>
      <strong>IzyAnalisAI</strong>
      {!loading && (
        user ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span>{user.email}</span>
            <button onClick={handleLogout} style={{ padding: '6px 12px' }}>
              Keluar
            </button>
          </div>
        ) : (
          <a href="/login" style={{ padding: '6px 12px' }}>
            Masuk
          </a>
        )
      )}
    </header>
  )
}
