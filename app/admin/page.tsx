'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

type Summary = {
  total_users: number
  premium_users: number
  open_bug_reports: number
  open_feature_requests: number
  active_signals: number
  pending_payments: number
  failed_jobs_24h: number
  app_rating_avg: number | null
  app_rating_count: number
}

type BugReport = {
  id: string
  description: string
  status: string
  created_at: string
}

type FeatureRequest = {
  id: string
  description: string
  status: string
  created_at: string
}

const BUG_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX']
const FEATURE_STATUSES = ['OPEN', 'PLANNED', 'SHIPPED', 'DECLINED']

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
      <p className="text-slate-500 text-xs">{label}</p>
      <p className="font-semibold text-lg mt-0.5">{value}</p>
    </div>
  )
}

export default function AdminPage() {
  const router = useRouter()
  const supabase = createClient()

  const [checking, setChecking] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [tab, setTab] = useState<'bug' | 'feature'>('bug')
  const [bugReports, setBugReports] = useState<BugReport[]>([])
  const [featureRequests, setFeatureRequests] = useState<FeatureRequest[]>([])
  const [loadingList, setLoadingList] = useState(false)

  const loadSummary = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_dashboard_summary')
    if (!error) setSummary(data as Summary)
  }, [supabase])

  const loadBugReports = useCallback(async () => {
    setLoadingList(true)
    const { data } = await supabase
      .from('bug_reports')
      .select('id, description, status, created_at')
      .order('created_at', { ascending: false })
      .limit(50)
    setBugReports(data ?? [])
    setLoadingList(false)
  }, [supabase])

  const loadFeatureRequests = useCallback(async () => {
    setLoadingList(true)
    const { data } = await supabase
      .from('feature_requests')
      .select('id, description, status, created_at')
      .order('created_at', { ascending: false })
      .limit(50)
    setFeatureRequests(data ?? [])
    setLoadingList(false)
  }, [supabase])

  useEffect(() => {
    async function check() {
      const { data: userData } = await supabase.auth.getUser()
      if (!userData.user) {
        router.push('/login')
        return
      }
      const { data: profile } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('id', userData.user.id)
        .single()
      if (!profile?.is_admin) {
        router.push('/')
        return
      }
      setIsAdmin(true)
      setChecking(false)
    }
    check()
  }, [supabase, router])

  useEffect(() => {
    if (!isAdmin) return
    loadSummary()
    loadBugReports()
  }, [isAdmin, loadSummary, loadBugReports])

  useEffect(() => {
    if (!isAdmin) return
    if (tab === 'bug') loadBugReports()
    else loadFeatureRequests()
  }, [tab, isAdmin, loadBugReports, loadFeatureRequests])

  const updateBugStatus = async (id: string, status: string) => {
    await supabase.from('bug_reports').update({ status }).eq('id', id)
    loadBugReports()
  }

  const updateFeatureStatus = async (id: string, status: string) => {
    await supabase.from('feature_requests').update({ status }).eq('id', id)
    loadFeatureRequests()
  }

  if (checking) {
    return (
      <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 flex items-center justify-center">
        <p className="text-slate-400 text-sm">Memuat...</p>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[900px] mx-auto pb-16">
      <h1 className="text-xl font-bold mb-1">Admin</h1>
      <p className="text-slate-400 text-sm mb-6">Ringkasan sistem &amp; pengelolaan laporan.</p>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard label="Total User" value={summary.total_users} />
          <StatCard label="Premium" value={summary.premium_users} />
          <StatCard label="Sinyal Aktif" value={summary.active_signals} />
          <StatCard label="Job Gagal (24 jam)" value={summary.failed_jobs_24h} />
          <StatCard label="Bug Report Terbuka" value={summary.open_bug_reports} />
          <StatCard label="Fitur Diajukan Terbuka" value={summary.open_feature_requests} />
          <StatCard label="Pembayaran Pending" value={summary.pending_payments} />
          <StatCard
            label="Rating App"
            value={summary.app_rating_count > 0 ? `${summary.app_rating_avg} ⭐ (${summary.app_rating_count})` : '-'}
          />
        </div>
      )}

      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setTab('bug')}
          className={`px-4 py-2 rounded-xl text-sm ${tab === 'bug' ? 'bg-white/15' : 'bg-white/5 text-slate-400'}`}
        >
          Bug Report
        </button>
        <button
          onClick={() => setTab('feature')}
          className={`px-4 py-2 rounded-xl text-sm ${tab === 'feature' ? 'bg-white/15' : 'bg-white/5 text-slate-400'}`}
        >
          Ajukan Fitur
        </button>
      </div>

      {loadingList && <p className="text-slate-500 text-sm">Memuat...</p>}

      {!loadingList && tab === 'bug' && (
        <div className="space-y-2">
          {bugReports.length === 0 && <p className="text-slate-500 text-sm">Belum ada bug report.</p>}
          {bugReports.map((b) => (
            <div key={b.id} className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
              <p className="text-sm text-slate-200 mb-2">{b.description}</p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">
                  {new Date(b.created_at).toLocaleString('id-ID')}
                </span>
                <select
                  value={b.status}
                  onChange={(e) => updateBugStatus(b.id, e.target.value)}
                  className="bg-white/10 border border-white/10 rounded-lg text-xs px-2 py-1"
                >
                  {BUG_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loadingList && tab === 'feature' && (
        <div className="space-y-2">
          {featureRequests.length === 0 && <p className="text-slate-500 text-sm">Belum ada ajuan fitur.</p>}
          {featureRequests.map((f) => (
            <div key={f.id} className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
              <p className="text-sm text-slate-200 mb-2">{f.description}</p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">
                  {new Date(f.created_at).toLocaleString('id-ID')}
                </span>
                <select
                  value={f.status}
                  onChange={(e) => updateFeatureStatus(f.id, e.target.value)}
                  className="bg-white/10 border border-white/10 rounded-lg text-xs px-2 py-1"
                >
                  {FEATURE_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
