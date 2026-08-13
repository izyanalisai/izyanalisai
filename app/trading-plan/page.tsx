'use client'

import { createClient } from '@/lib/supabase/client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

type PlanRow = {
  module_1: string | null
  module_2: string | null
  module_3: string | null
  module_4: string | null
  module_5: string | null
  module_6: string | null
  module_7: string | null
  module_8: string | null
  module_9: string | null
  module_10: string | null
}

const MODULES: { key: keyof PlanRow; title: string; placeholder: string }[] = [
  { key: 'module_1', title: '1. Tujuan & Gaya Trading', placeholder: 'Contoh: swing trading, target 10% per bulan...' },
  { key: 'module_2', title: '2. Kriteria Entry', placeholder: 'Kondisi apa yang harus terpenuhi sebelum entry...' },
  { key: 'module_3', title: '3. Money Management', placeholder: 'Contoh: maksimal 1-2% modal per posisi...' },
  { key: 'module_4', title: '4. Risk-Reward Ratio', placeholder: 'Contoh: minimal 1:2 atau 1:3...' },
  { key: 'module_5', title: '5. Stop Loss & Take Profit', placeholder: 'Aturan penempatan SL dan TP...' },
  { key: 'module_6', title: '6. Kriteria Exit selain SL/TP', placeholder: 'Kondisi lain untuk keluar posisi...' },
  { key: 'module_7', title: '7. Trading Journal', placeholder: 'Catatan evaluasi trading...' },
  { key: 'module_8', title: '8. Aturan Psikologis/Emosional', placeholder: 'Contoh: stop trading setelah 3x loss beruntun...' },
  { key: 'module_9', title: '9. Analisa Kondisi Pasar', placeholder: 'Cara membaca kondisi pasar sebelum entry...' },
  { key: 'module_10', title: '10. Rencana Kontinjensi/Skenario Alternatif', placeholder: 'Rencana kalau market bergerak di luar ekspektasi...' },
]

const FREE_MODULES = ['module_1', 'module_2', 'module_3']

export default function TradingPlanPage() {
  const supabase = createClient()
  const [plan, setPlan] = useState<PlanRow>({
    module_1: '', module_2: '', module_3: '', module_4: '', module_5: '',
    module_6: '', module_7: '', module_8: '', module_9: '', module_10: '',
  })
  const [isPremium, setIsPremium] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data: userRes } = await supabase.auth.getUser()
    if (!userRes.user) return

    const { data: profile } = await supabase
      .from('profiles')
      .select('is_premium')
      .eq('id', userRes.user.id)
      .single()
    setIsPremium(!!profile?.is_premium)

    const { data } = await supabase
      .from('trading_plans')
      .select('*')
      .eq('user_id', userRes.user.id)
      .maybeSingle()

    if (data) {
      setPlan({
        module_1: data.module_1 ?? '', module_2: data.module_2 ?? '', module_3: data.module_3 ?? '',
        module_4: data.module_4 ?? '', module_5: data.module_5 ?? '', module_6: data.module_6 ?? '',
        module_7: data.module_7 ?? '', module_8: data.module_8 ?? '', module_9: data.module_9 ?? '',
        module_10: data.module_10 ?? '',
      })
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    load()
  }, [load])

  const handleSave = async (key: keyof PlanRow) => {
    const { data: userRes } = await supabase.auth.getUser()
    if (!userRes.user) return
    setSaving(key)
    setSavedMsg(null)

    const { error } = await supabase.from('trading_plans').upsert({
      user_id: userRes.user.id,
      ...plan,
    })

    setSaving(null)
    if (error) {
      setSavedMsg('Gagal menyimpan: ' + error.message)
    } else {
      setSavedMsg('Tersimpan.')
      setTimeout(() => setSavedMsg(null), 2000)
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto">
        <p className="text-slate-500 text-sm">Memuat...</p>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 pb-16 max-w-[480px] mx-auto lg:max-w-2xl lg:pl-64">
      <div className="flex items-center gap-3 mb-1">
        <Link href="/profil" className="text-sm text-slate-400">‹</Link>
        <h1 className="text-xl font-bold">Trading Plan</h1>
      </div>
      <p className="text-slate-400 text-sm mb-4">
        {isPremium ? 'Semua 10 modul dapat diedit.' : 'Free: modul 1-3 dapat diedit. Modul 4-10 khusus Premium.'}
      </p>

      <div className="space-y-3">
        {MODULES.map((m) => {
          const locked = !isPremium && !FREE_MODULES.includes(m.key)
          return (
            <div key={m.key} className="rounded-xl bg-white/5 border border-white/10 p-4">
              <p className="text-sm font-semibold mb-2 flex items-center justify-between">
                {m.title}
                {locked && <span className="text-[10px] text-slate-500">🔒 Premium</span>}
              </p>
              {locked ? (
                <Link
                  href="/berlangganan"
                  className="block text-center text-xs rounded-lg py-2.5"
                  style={{
                    backgroundImage:
                      'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
                  }}
                >
                  Upgrade Premium untuk buka modul ini
                </Link>
              ) : (
                <>
                  <textarea
                    value={plan[m.key] ?? ''}
                    onChange={(e) => setPlan((p) => ({ ...p, [m.key]: e.target.value }))}
                    placeholder={m.placeholder}
                    rows={3}
                    className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6] resize-none"
                  />
                  <button
                    onClick={() => handleSave(m.key)}
                    disabled={saving === m.key}
                    className="mt-2 text-xs text-slate-400 border border-white/10 rounded-lg px-3 py-1.5 disabled:opacity-50"
                  >
                    {saving === m.key ? 'Menyimpan...' : 'Simpan'}
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>

      {savedMsg && (
        <p className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-[#22C55E]/90 text-xs px-4 py-2 rounded-full">
          {savedMsg}
        </p>
      )}
    </main>
  )
}
