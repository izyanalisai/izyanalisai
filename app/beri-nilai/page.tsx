'use client'

import { createClient } from '@/lib/supabase/client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

const GRADIENT =
  'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)'

export default function BeriNilaiPage() {
  const router = useRouter()
  const supabase = createClient()
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const handleSubmit = async () => {
    setError(null)
    if (rating < 1) {
      setError('Pilih bintang dulu ya.')
      return
    }
    setLoading(true)
    const { data: userData } = await supabase.auth.getUser()
    if (!userData.user) {
      setLoading(false)
      router.push('/login')
      return
    }
    const { error } = await supabase
      .from('app_ratings')
      .insert({ user_id: userData.user.id, rating, comment: comment.trim() || null })
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
        <p className="text-slate-400 text-sm mb-6">Penilaianmu sangat membantu kami.</p>
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
      <h1 className="text-xl font-bold mb-1">Beri Nilai</h1>
      <p className="text-slate-400 text-sm mb-6">Gimana pengalamanmu pakai IzyAnalisAi?</p>

      <div className="flex justify-center gap-2 mb-6">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onClick={() => setRating(n)}
            className="text-3xl"
            aria-label={`${n} bintang`}
          >
            {n <= rating ? '★' : '☆'}
          </button>
        ))}
      </div>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Komentar (opsional)"
        rows={4}
        className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6] resize-none mb-3"
      />
      {error && <p className="text-xs text-[#EF4444] mb-3">{error}</p>}
      <button
        onClick={handleSubmit}
        disabled={loading}
        className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
        style={{ backgroundImage: GRADIENT }}
      >
        {loading ? 'Mengirim...' : 'Kirim Penilaian'}
      </button>
    </main>
  )
}
