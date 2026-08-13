'use client'

import { createClient } from '@/lib/supabase/client'
import { useCallback, useEffect, useState } from 'react'

type TaskType = 'PRICE_ALERT' | 'LEVEL_RETEST' | 'DAILY_SUMMARY' | 'UNUSUAL_VOLUME'
type TaskStatus = 'ACTIVE' | 'PAUSED' | 'DONE' | 'FAILED'

type AiTask = {
  id: string
  task_type: TaskType
  prompt_text: string
  parameters: Record<string, string>
  is_active: boolean
  status: TaskStatus
  last_run: string | null
  created_at: string
}

const TASK_LABEL: Record<TaskType, string> = {
  PRICE_ALERT: 'Price Alert',
  LEVEL_RETEST: 'Level Retest',
  DAILY_SUMMARY: 'Ringkasan Harian',
  UNUSUAL_VOLUME: 'Volume Tidak Wajar',
}

export default function AiTaskPage() {
  const supabase = createClient()
  const [tasks, setTasks] = useState<AiTask[]>([])
  const [loading, setLoading] = useState(true)
  const [isPremium, setIsPremium] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [formType, setFormType] = useState<TaskType>('PRICE_ALERT')
  const [ticker, setTicker] = useState('')
  const [targetPrice, setTargetPrice] = useState('')
  const [direction, setDirection] = useState<'above' | 'below'>('above')
  const [level, setLevel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

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
      .from('ai_tasks')
      .select('*')
      .order('created_at', { ascending: false })
    setTasks((data as AiTask[]) ?? [])
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    load()
  }, [load])

  const activeCount = tasks.filter((t) => t.is_active).length
  const maxTasks = isPremium ? 20 : 3

  const handleCreate = async () => {
    setError(null)
    const { data: userRes } = await supabase.auth.getUser()
    if (!userRes.user) return

    let parameters: Record<string, string> = {}
    let promptText = ''

    if (formType === 'PRICE_ALERT') {
      if (!ticker || !targetPrice) return setError('Isi kode saham dan target harga.')
      parameters = { ticker: ticker.toUpperCase(), target_price: targetPrice, direction }
      promptText = `Alert saya kalau ${ticker.toUpperCase()} ${direction === 'above' ? 'di atas' : 'di bawah'} ${targetPrice}`
    } else if (formType === 'LEVEL_RETEST') {
      if (!ticker || !level) return setError('Isi kode saham dan level.')
      parameters = { ticker: ticker.toUpperCase(), level, tolerance_pct: '1' }
      promptText = `Kasih tahu kalau ${ticker.toUpperCase()} retest ${level}`
    } else if (formType === 'DAILY_SUMMARY') {
      parameters = {}
      promptText = 'Kirim ringkasan IHSG setiap pagi'
    } else if (formType === 'UNUSUAL_VOLUME') {
      parameters = ticker ? { ticker: ticker.toUpperCase() } : {}
      promptText = ticker
        ? `Deteksi volume tidak wajar untuk ${ticker.toUpperCase()}`
        : 'Deteksi saham dengan volume tidak wajar'
    }

    setSubmitting(true)
    const { error: insertErr } = await supabase.from('ai_tasks').insert({
      user_id: userRes.user.id,
      task_type: formType,
      prompt_text: promptText,
      parameters,
      is_active: true,
      status: 'ACTIVE',
    })
    setSubmitting(false)

    if (insertErr) {
      if (insertErr.message.includes('AI_TASK_LIMIT_REACHED')) {
        setError(`Maksimal ${maxTasks} tugas aktif tercapai.`)
      } else if (insertErr.message.includes('AI_TASK_TYPE_REQUIRES_PREMIUM')) {
        setError('Jenis tugas ini khusus Premium.')
      } else {
        setError('Gagal membuat tugas.')
      }
      return
    }

    setShowForm(false)
    setTicker('')
    setTargetPrice('')
    setLevel('')
    load()
  }

  const handlePauseResume = async (task: AiTask) => {
    await supabase
      .from('ai_tasks')
      .update({ is_active: !task.is_active, status: !task.is_active ? 'ACTIVE' : 'PAUSED' })
      .eq('id', task.id)
    load()
  }

  const handleDelete = async (id: string) => {
    await supabase.from('ai_tasks').delete().eq('id', id)
    load()
  }

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 pb-28 max-w-[480px] mx-auto lg:max-w-2xl lg:pl-64">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold">AI Task</h1>
        <span className="text-xs text-slate-400">
          {activeCount}/{maxTasks} aktif
        </span>
      </div>
      <p className="text-slate-400 text-sm mb-4">Tugas otomatis pantau saham.</p>

      <button
        onClick={() => setShowForm((v) => !v)}
        className="w-full rounded-xl py-3 text-sm font-medium mb-4"
        style={{
          backgroundImage:
            'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
        }}
      >
        {showForm ? 'Batal' : '+ Buat Tugas Baru'}
      </button>

      {showForm && (
        <div className="rounded-xl bg-white/5 border border-white/10 p-4 mb-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(TASK_LABEL) as TaskType[]).map((t) => {
              const locked = !isPremium && t !== 'PRICE_ALERT' && t !== 'DAILY_SUMMARY'
              return (
                <button
                  key={t}
                  onClick={() => !locked && setFormType(t)}
                  className={`rounded-lg py-2 text-xs border ${
                    formType === t
                      ? 'border-[#8B5CF6] bg-[#8B5CF6]/20 text-white'
                      : 'border-white/10 text-slate-400'
                  } ${locked ? 'opacity-40' : ''}`}
                >
                  {TASK_LABEL[t]}
                  {locked ? ' 🔒' : ''}
                </button>
              )
            })}
          </div>

          {(formType === 'PRICE_ALERT' || formType === 'LEVEL_RETEST' || formType === 'UNUSUAL_VOLUME') && (
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="Kode saham (mis. BBRI)"
              className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
            />
          )}

          {formType === 'PRICE_ALERT' && (
            <div className="flex gap-2">
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as 'above' | 'below')}
                className="rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-sm"
              >
                <option value="above">Di atas</option>
                <option value="below">Di bawah</option>
              </select>
              <input
                value={targetPrice}
                onChange={(e) => setTargetPrice(e.target.value)}
                placeholder="Target harga"
                inputMode="numeric"
                className="flex-1 rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
              />
            </div>
          )}

          {formType === 'LEVEL_RETEST' && (
            <input
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              placeholder="Level harga (mis. 4500)"
              inputMode="numeric"
              className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
            />
          )}

          {error && <p className="text-[#EF4444] text-xs">{error}</p>}

          <button
            onClick={handleCreate}
            disabled={submitting}
            className="w-full rounded-lg bg-[#3B82F6] py-2.5 text-sm font-medium disabled:opacity-50"
          >
            {submitting ? 'Menyimpan...' : 'Simpan Tugas'}
          </button>
        </div>
      )}

      <div className="space-y-2">
        {loading && <p className="text-slate-500 text-sm">Memuat...</p>}
        {!loading && tasks.length === 0 && (
          <p className="text-slate-500 text-sm text-center py-8">
            Belum ada tugas. Buat tugas AI pertamamu!
          </p>
        )}
        {tasks.map((t) => (
          <div key={t.id} className="rounded-xl bg-white/5 border border-white/10 p-3">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-slate-400">{TASK_LABEL[t.task_type]}</p>
                <p className="text-sm font-medium mt-0.5">{t.prompt_text}</p>
              </div>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full ${
                  t.status === 'ACTIVE'
                    ? 'bg-[#22C55E]/15 text-[#22C55E]'
                    : t.status === 'DONE'
                      ? 'bg-[#3B82F6]/15 text-[#3B82F6]'
                      : 'bg-white/10 text-slate-400'
                }`}
              >
                {t.status}
              </span>
            </div>
            <div className="flex gap-2 mt-2">
              {t.status !== 'DONE' && (
                <button
                  onClick={() => handlePauseResume(t)}
                  className="text-xs text-slate-400 border border-white/10 rounded-lg px-3 py-1.5"
                >
                  {t.is_active ? 'Pause' : 'Aktifkan'}
                </button>
              )}
              <button
                onClick={() => handleDelete(t.id)}
                className="text-xs text-[#EF4444] border border-[#EF4444]/30 rounded-lg px-3 py-1.5"
              >
                Hapus
              </button>
            </div>
          </div>
        ))}
      </div>
    </main>
  )
}
