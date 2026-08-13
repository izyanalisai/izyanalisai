'use client'

import { createClient } from '@/lib/supabase/client'
import { useState } from 'react'

export default function DaftarPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setMessage(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signUp({ email, password })
    if (error) {
      setError(error.message)
    } else {
      setMessage('Cek email kamu untuk konfirmasi pendaftaran.')
    }
  }

  return (
    <main style={{ padding: 24, maxWidth: 400 }}>
      <h1>Daftar</h1>
      <form onSubmit={handleSignUp}>
        <div style={{ marginBottom: 12 }}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: '100%', padding: 8 }}
            required
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <input
            type="password"
            placeholder="Password (min 8 karakter)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: '100%', padding: 8 }}
            required
            minLength={8}
          />
        </div>
        {error && <p style={{ color: 'red' }}>{error}</p>}
        {message && <p style={{ color: 'green' }}>{message}</p>}
        <button type="submit" style={{ padding: '8px 16px' }}>Daftar</button>
      </form>
      <p style={{ marginTop: 12 }}>
        Sudah punya akun? <a href="/login">Masuk</a>
      </p>
    </main>
  )
}
