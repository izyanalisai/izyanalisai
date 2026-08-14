'use client'

import { createClient } from '@/lib/supabase/client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

const GRADIENT =
  'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)'

export default function LaporkanBugPage() {
  const router = useRouter()
  const supabase = createClient()
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (description.trim().length < 10) {
      setError('Jelaskan bug-nya sedikit lebih detail ya (minimal 10 karakter).')
      return
    }
    setLoading(true)
    const { data: userData } = await supabase.auth.getUser()
    if (!userData.user) {
      router.push('/login')
      return
    }
    const { error } = await supabase
      .from('bug_reports')
      .insert({ user_id: userData.user.id, description: description.trim() })
    setLoading(false)
    if (error) {
      setError('Gagal mengirim, coba lagi.')
      return
    }
    setDone(true)
  }

  if (done) {
    return (
      <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto flex flex-col items-center justify-center text-center">
        <p className="text-lg font-semibold mb-2">Terima kasih!</p>
        <p className="text-slate-400 text-sm mb-6">
          Laporan bug kamu sudah kami terima dan akan segera dicek tim.
        </p>
        <button
          onClick={() => router.push('/profil')}
          className="rounded-xl bg-white/10 border border-white/10 px-5 py-2.5 text-sm"
        >
          Kembali ke Profil
        </button>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto pb-16">
      <h1 className="text-xl font-bold mb-1">Laporkan Bug</h1>
      <p className="text-slate-400 text-sm mb-6">
        Nemu error, tampilan aneh, atau fitur yang tidak jalan? Kasih tahu kami di sini.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Contoh: tombol Tambah Watchlist di Detail Saham BBRI tidak merespons saat ditekan..."
          rows={6}
          className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6] resize-none"
          required
        />
        {error && <p className="text-xs text-[#EF4444]">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
          style={{ backgroundImage: GRADIENT }}
        >
          {loading ? 'Mengirim...' : 'Kirim Laporan'}
        </button>
      </form>
    </main>
  )
}
