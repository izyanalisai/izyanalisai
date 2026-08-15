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

type UserRow = {
  id: string
  full_name: string | null
  is_premium: boolean
  is_admin: boolean
  is_active: boolean
  created_at: string
  subscriptions: { status: string; plan: string; period_end: string | null }[] | null
}

type ActiveSignal = {
  id: string
  direction: string
  status: string
  created_at: string
  stocks: { ticker: string; name: string } | null
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
  const [tab, setTab] = useState<'bug' | 'feature' | 'users' | 'signals'>('bug')
  const [bugReports, setBugReports] = useState<BugReport[]>([])
  const [featureRequests, setFeatureRequests] = useState<FeatureRequest[]>([])
  const [users, setUsers] = useState<UserRow[]>([])
  const [activeSignals, setActiveSignals] = useState<ActiveSignal[]>([])
  const [overridingId, setOverridingId] = useState<string | null>(null)
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

  // RLS profiles_select & subscriptions_select sudah mengizinkan admin baca
  // semua baris (is_current_user_admin()), jadi query langsung aman dipakai.
  const loadUsers = useCallback(async () => {
    setLoadingList(true)
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, is_premium, is_admin, is_active, created_at, subscriptions(status, plan, period_end)')
      .order('created_at', { ascending: false })
      .limit(100)
    setUsers((data as unknown as UserRow[]) ?? [])
    setLoadingList(false)
  }, [supabase])

  const loadActiveSignals = useCallback(async () => {
    setLoadingList(true)
    const { data } = await supabase
      .from('signals')
      .select('id, direction, status, created_at, stocks(ticker, name)')
      .eq('status', 'ACTIVE')
      .is('superseded_by', null)
      .order('created_at', { ascending: false })
      .limit(100)
    setActiveSignals((data as unknown as ActiveSignal[]) ?? [])
    setLoadingList(false)
  }, [supabase])

  const overrideSignal = async (signalId: string) => {
    const reason = window.prompt('Alasan override sinyal ini (wajib diisi):')
    if (!reason || !reason.trim()) return

    setOverridingId(signalId)
    const { error } = await supabase.rpc('admin_invalidate_signal', {
      p_signal_id: signalId,
      p_reason: reason.trim(),
    })
    if (error) {
      window.alert(`Gagal override: ${error.message}`)
    } else {
      await loadActiveSignals()
      await loadSummary()
    }
    setOverridingId(null)
  }

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
    else if (tab === 'feature') loadFeatureRequests()
    else if (tab === 'users') loadUsers()
    else if (tab === 'signals') loadActiveSignals()
  }, [tab, isAdmin, loadBugReports, loadFeatureRequests, loadUsers, loadActiveSignals])

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
        <button
          onClick={() => setTab('users')}
          className={`px-4 py-2 rounded-xl text-sm ${tab === 'users' ? 'bg-white/15' : 'bg-white/5 text-slate-400'}`}
        >
          User &amp; Subscription
        </button>
        <button
          onClick={() => setTab('signals')}
          className={`px-4 py-2 rounded-xl text-sm ${tab === 'signals' ? 'bg-white/15' : 'bg-white/5 text-slate-400'}`}
        >
          Sinyal Aktif
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

      {!loadingList && tab === 'users' && (
        <div className="space-y-2">
          {users.length === 0 && <p className="text-slate-500 text-sm">Belum ada user.</p>}
          {users.map((u) => {
            const sub = u.subscriptions?.[0]
            return (
              <div key={u.id} className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-200">{u.full_name || '(tanpa nama)'}</p>
                  <div className="flex gap-1.5">
                    {u.is_admin && <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#8B5CF6]/20 text-[#8B5CF6]">Admin</span>}
                    {u.is_premium && <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#F43F5E]/20 text-[#F43F5E]">Premium</span>}
                    {!u.is_active && <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-slate-400">Nonaktif</span>}
                  </div>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Daftar {new Date(u.created_at).toLocaleDateString('id-ID')}
                  {sub && ` · Subscription: ${sub.plan} (${sub.status})`}
                  {sub?.period_end && ` · berakhir ${new Date(sub.period_end).toLocaleDateString('id-ID')}`}
                </p>
              </div>
            )
          })}
        </div>
      )}

      {!loadingList && tab === 'signals' && (
        <div className="space-y-2">
          {activeSignals.length === 0 && <p className="text-slate-500 text-sm">Tidak ada sinyal aktif.</p>}
          {activeSignals.map((s) => (
            <div key={s.id} className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{s.stocks?.ticker} <span className="text-slate-500 font-normal">{s.stocks?.name}</span></p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {s.direction} · dibuat {new Date(s.created_at).toLocaleString('id-ID')}
                  </p>
                </div>
                <button
                  onClick={() => overrideSignal(s.id)}
                  disabled={overridingId === s.id}
                  className="text-xs px-3 py-1.5 rounded-lg border border-[#EF4444]/40 text-[#EF4444] hover:bg-[#EF4444]/10 disabled:opacity-50"
                >
                  {overridingId === s.id ? 'Memproses...' : 'Override'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
