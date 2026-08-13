'use client'

import { createClient } from '@/lib/supabase/client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

const PROFILES = [
  {
    key: 'konservatif',
    title: 'Konservatif',
    desc: 'Prioritas menjaga modal. Cenderung saham blue-chip, risk-reward ketat, ukuran posisi kecil.',
  },
  {
    key: 'moderat',
    title: 'Moderat',
    desc: 'Seimbang antara pertumbuhan dan risiko. Kombinasi saham blue-chip dan second liner.',
  },
  {
    key: 'agresif',
    title: 'Agresif',
    desc: 'Mengejar potensi return tinggi, siap menerima volatilitas dan risiko lebih besar.',
  },
]

export default function ProfilRisikoPage() {
  const router = useRouter()
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!selected) return
    setError(null)
    setLoading(true)
    const supabase = createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      router.replace('/login')
      return
    }

    const { error } = await supabase
      .from('profiles')
      .update({ risk_profile: selected })
      .eq('id', user.id)

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    router.replace('/')
  }

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-8 max-w-[480px] mx-auto flex flex-col">
      <h1 className="text-xl font-bold mb-1">Profil Risiko Kamu</h1>
      <p className="text-slate-400 text-sm mb-6">Dipakai untuk personalisasi Trading Plan & rekomendasi.</p>

      <div className="space-y-3 mb-6">
        {PROFILES.map((p) => (
          <button
            key={p.key}
            onClick={() => setSelected(p.key)}
            className={`w-full text-left rounded-xl border p-4 transition-colors ${
              selected === p.key ? 'border-[#8B5CF6] bg-white/10' : 'border-white/10 bg-white/5'
            }`}
          >
            <p className="font-semibold text-sm">{p.title}</p>
            <p className="text-slate-400 text-xs mt-1">{p.desc}</p>
          </button>
        ))}
      </div>

      {error && <p className="text-[#EF4444] text-sm mb-3">{error}</p>}

      <button
        onClick={handleSave}
        disabled={!selected || loading}
        className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
        style={{ backgroundImage: 'linear-gradient(135deg, #3B82F6 0%, #8B5CF6 50%, #EC4899 100%)' }}
      >
        {loading ? 'Menyimpan...' : 'Lanjutkan'}
      </button>
    </main>
  )
}
