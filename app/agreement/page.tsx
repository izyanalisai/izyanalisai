'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function AgreementPage() {
  const router = useRouter()
  const [agreementId, setAgreementId] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [checks, setChecks] = useState([false, false, false])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from('agreements')
      .select('id, content')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        setAgreementId(data?.id ?? null)
        setContent(data?.content ?? '')
      })
  }, [])

  const allChecked = checks.every(Boolean)

  const handleContinue = async () => {
    if (!agreementId) return
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

    const { error } = await supabase.from('agreement_acceptances').insert({
      user_id: user.id,
      agreement_id: agreementId,
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    router.replace('/profil-risiko')
  }

  const items = [
    'Saya paham sinyal AI adalah alat bantu analisa, bukan jaminan profit.',
    'Saya paham keputusan trading dan risikonya sepenuhnya tanggung jawab saya (DYOR).',
    'Saya sudah membaca dan menyetujui Syarat Penggunaan & Kebijakan Privasi.',
  ]

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-8 max-w-[480px] mx-auto flex flex-col">
      <h1 className="text-xl font-bold mb-3">Sebelum Mulai</h1>
      <div className="rounded-xl bg-white/5 border border-white/10 p-4 text-sm text-slate-300 leading-relaxed mb-5 max-h-64 overflow-y-auto">
        {content || 'Memuat...'}
      </div>

      <div className="space-y-3 mb-6">
        {items.map((label, i) => (
          <label key={i} className="flex items-start gap-3 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={checks[i]}
              onChange={(e) => {
                const next = [...checks]
                next[i] = e.target.checked
                setChecks(next)
              }}
              className="mt-0.5 h-4 w-4 accent-[#8B5CF6]"
            />
            {label}
          </label>
        ))}
      </div>

      {error && <p className="text-[#EF4444] text-sm mb-3">{error}</p>}

      <button
        onClick={handleContinue}
        disabled={!allChecked || loading || !agreementId}
        className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
        style={{ backgroundImage: 'linear-gradient(135deg, #3B82F6 0%, #8B5CF6 50%, #EC4899 100%)' }}
      >
        {loading ? 'Memproses...' : 'Saya Mengerti dan Lanjutkan'}
      </button>
    </main>
  )
}
