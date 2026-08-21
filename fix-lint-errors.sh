#!/usr/bin/env bash
# Jalankan dari root repo izyanalisai (folder yang ada package.json-nya)
set -e

python3 - << 'PYEOF'
import sys

def patch(path, old, new, label):
    with open(path, encoding="utf-8") as f:
        content = f.read()
    if new in content:
        print(f"[skip] {label} (sudah dipatch)")
        return
    if old not in content:
        print(f"[GAGAL] pola tidak ketemu di {path} -> {label}")
        sys.exit(1)
    content = content.replace(old, new, 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"[OK] {label}")

# ---------- lib/preferences.tsx ----------
patch(
    "lib/preferences.tsx",
    """export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>('system')
  const [resolved, setResolved] = useState<ResolvedTheme>('dark')

  useEffect(() => {
    const stored = (localStorage.getItem(THEME_STORAGE_KEY) as ThemeChoice | null) ?? 'system'
    setChoiceState(stored)
    setResolved(resolveTheme(stored))
  }, [])

  useEffect(() => {""",
    """function readStoredChoice(): ThemeChoice {
  if (typeof window === 'undefined') return 'system'
  return (localStorage.getItem(THEME_STORAGE_KEY) as ThemeChoice | null) ?? 'system'
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readStoredChoice())
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readStoredChoice()))

  useEffect(() => {""",
    "preferences.tsx: theme lazy-init",
)

patch(
    "lib/preferences.tsx",
    """export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('id')

  useEffect(() => {
    const stored = localStorage.getItem(LANG_STORAGE_KEY) as Lang | null
    if (stored === 'id' || stored === 'en') setLangState(stored)
  }, [])

  const setLang = useCallback((next: Lang) => {""",
    """function readStoredLang(): Lang {
  if (typeof window === 'undefined') return 'id'
  const stored = localStorage.getItem(LANG_STORAGE_KEY) as Lang | null
  return stored === 'id' || stored === 'en' ? stored : 'id'
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readStoredLang())

  const setLang = useCallback((next: Lang) => {""",
    "preferences.tsx: lang lazy-init",
)

# ---------- components/StockDetail.tsx ----------
patch(
    "components/StockDetail.tsx",
    """  useEffect(() => {
    if (stock) {
      loadSignal(stock.id, signalTier)
    }
  }, [signalTier, stock, loadSignal])""",
    """  useEffect(() => {
    if (!stock) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch async ke Supabase saat ganti tier, bukan setState sinkron
    loadSignal(stock.id, signalTier)
  }, [signalTier, stock, loadSignal])""",
    "StockDetail.tsx: reload sinyal per tier",
)

# ---------- app/admin/page.tsx ----------
patch(
    "app/admin/page.tsx",
    """  useEffect(() => {
    if (!isAdmin) return
    loadSummary()
    loadBugReports()
  }, [isAdmin, loadSummary, loadBugReports])

  useEffect(() => {
    if (!isAdmin) return
    if (tab === 'bug') loadBugReports()""",
    """  useEffect(() => {
    if (!isAdmin) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch data admin async, bukan setState sinkron
    loadSummary()
    loadBugReports()
  }, [isAdmin, loadSummary, loadBugReports])

  useEffect(() => {
    if (!isAdmin) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch data sesuai tab aktif, bukan setState sinkron
    if (tab === 'bug') loadBugReports()""",
    "admin/page.tsx",
)

# ---------- app/ai-task/page.tsx ----------
patch(
    "app/ai-task/page.tsx",
    """  useEffect(() => {
    load()
  }, [load])

  const activeCount""",
    """  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch data async, bukan setState sinkron
    load()
  }, [load])

  const activeCount""",
    "ai-task/page.tsx",
)

# ---------- app/api/cron/fetch-ipo-calendar/route.ts ----------
patch(
    "app/api/cron/fetch-ipo-calendar/route.ts",
    "type AnyClient = SupabaseClient<any, any, any>",
    "// eslint-disable-next-line @typescript-eslint/no-explicit-any\ntype AnyClient = SupabaseClient<any, any, any>",
    "fetch-ipo-calendar: type AnyClient",
)
patch(
    "app/api/cron/fetch-ipo-calendar/route.ts",
    "  const supabase: AnyClient = createClient<any>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)",
    "  // eslint-disable-next-line @typescript-eslint/no-explicit-any\n  const supabase: AnyClient = createClient<any>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)",
    "fetch-ipo-calendar: createClient<any>",
)

# ---------- app/chat/page.tsx ----------
patch(
    "app/chat/page.tsx",
    """  useEffect(() => {
    loadWallet()
  }, [loadWallet])""",
    """  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch saldo token async, bukan setState sinkron
    loadWallet()
  }, [loadWallet])""",
    "chat/page.tsx",
)

# ---------- app/daftar/page.tsx ----------
patch(
    "app/daftar/page.tsx",
    """  const [lockUntil, setLockUntil] = useState<number | null>(null)
  const inputsRef = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  const locked = lockUntil !== null && Date.now() < lockUntil""",
    """  const [lockUntil, setLockUntil] = useState<number | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())
  const inputsRef = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  useEffect(() => {
    if (lockUntil === null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [lockUntil])

  const locked = lockUntil !== null && now < lockUntil""",
    "daftar/page.tsx: purity fix Date.now()",
)

# ---------- app/landing/page.tsx ----------
patch(
    "app/landing/page.tsx",
    """    if (!seen) {
      router.replace('/onboarding')
    } else {
      setChecked(true)
    }
  }, [router])""",
    """    if (!seen) {
      router.replace('/onboarding')
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sinkronisasi status onboarding dari localStorage
      setChecked(true)
    }
  }, [router])""",
    "landing/page.tsx",
)

# ---------- app/login/page.tsx ----------
patch(
    "app/login/page.tsx",
    "import { useEffect, useState } from 'react'",
    "import { useState } from 'react'",
    "login/page.tsx: hapus import useEffect",
)
patch(
    "app/login/page.tsx",
    """  const [accountDeletedNotice, setAccountDeletedNotice] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('accountDeleted') === '1') {
      setAccountDeletedNotice(true)
    }
  }, [])""",
    """  const [accountDeletedNotice] = useState(() => {
    if (typeof window === 'undefined') return false
    const params = new URLSearchParams(window.location.search)
    return params.get('accountDeleted') === '1'
  })""",
    "login/page.tsx: lazy-init accountDeletedNotice",
)

# ---------- app/notifikasi/page.tsx ----------
patch(
    "app/notifikasi/page.tsx",
    """import { createClient } from '@/lib/supabase/client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'""",
    """import { createClient } from '@/lib/supabase/client'
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'""",
    "notifikasi/page.tsx: import useRouter",
)
patch(
    "app/notifikasi/page.tsx",
    """export default function NotifikasiPage() {
  const supabase = createClient()""",
    """export default function NotifikasiPage() {
  const supabase = createClient()
  const router = useRouter()""",
    "notifikasi/page.tsx: init router",
)
patch(
    "app/notifikasi/page.tsx",
    """  useEffect(() => {
    load()
  }, [load])""",
    """  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch notifikasi async, bukan setState sinkron
    load()
  }, [load])""",
    "notifikasi/page.tsx: load()",
)
patch(
    "app/notifikasi/page.tsx",
    """      if (stock) {
        window.location.href = `/saham/${stock.ticker}`
        return
      }""",
    """      if (stock) {
        router.push(`/saham/${stock.ticker}`)
        return
      }""",
    "notifikasi/page.tsx: router.push ganti window.location.href",
)

# ---------- app/notifikasi/pengaturan/page.tsx ----------
patch(
    "app/notifikasi/pengaturan/page.tsx",
    """  useEffect(() => {
    checkStatus()
  }, [checkStatus])""",
    """  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- cek status push notif async, bukan setState sinkron
    checkStatus()
  }, [checkStatus])""",
    "notifikasi/pengaturan/page.tsx: checkStatus()",
)
patch(
    "app/notifikasi/pengaturan/page.tsx",
    """  useEffect(() => {
    load()
  }, [load])""",
    """  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch preferensi notifikasi async, bukan setState sinkron
    load()
  }, [load])""",
    "notifikasi/pengaturan/page.tsx: load()",
)

# ---------- app/riwayat-sinyal/page.tsx ----------
patch(
    "app/riwayat-sinyal/page.tsx",
    """  useEffect(() => {
    load()
  }, [load])""",
    """  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch riwayat sinyal async, bukan setState sinkron
    load()
  }, [load])""",
    "riwayat-sinyal/page.tsx",
)

# ---------- app/signal/page.tsx ----------
patch(
    "app/signal/page.tsx",
    """import { createClient } from '@/lib/supabase/client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'""",
    """import { createClient } from '@/lib/supabase/client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'""",
    "signal/page.tsx: import useRouter",
)
patch(
    "app/signal/page.tsx",
    """export default function SignalPage() {
  const supabase = createClient()""",
    """export default function SignalPage() {
  const supabase = createClient()
  const router = useRouter()""",
    "signal/page.tsx: init router",
)
patch(
    "app/signal/page.tsx",
    """    if (!userId) {
      window.location.href = '/login'
      return
    }""",
    """    if (!userId) {
      router.push('/login')
      return
    }""",
    "signal/page.tsx: router.push ganti window.location.href",
)

# ---------- app/splash/page.tsx ----------
patch(
    "app/splash/page.tsx",
    """  useEffect(() => {
    setVisible(true)""",
    """  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- trigger animasi fade-in saat mount
    setVisible(true)""",
    "splash/page.tsx",
)

# ---------- app/trading-plan/page.tsx ----------
patch(
    "app/trading-plan/page.tsx",
    """  useEffect(() => {
    load()
  }, [load])""",
    """  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch trading plan async, bukan setState sinkron
    load()
  }, [load])""",
    "trading-plan/page.tsx",
)

# ---------- app/watchlist/page.tsx ----------
patch(
    "app/watchlist/page.tsx",
    """  useEffect(() => {
    if (!activeFolderId) return
    loadItems(activeFolderId)
  }, [activeFolderId, loadItems])""",
    """  useEffect(() => {
    if (!activeFolderId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch item watchlist async, bukan setState sinkron
    loadItems(activeFolderId)
  }, [activeFolderId, loadItems])""",
    "watchlist/page.tsx: loadItems()",
)
patch(
    "app/watchlist/page.tsx",
    """    if (!user) return
    let active = true
    setSavedLoading(true)
    supabase""",
    """    if (!user) return
    let active = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- tandai loading sebelum fetch saved_signals async
    setSavedLoading(true)
    supabase""",
    "watchlist/page.tsx: setSavedLoading()",
)
patch(
    "app/watchlist/page.tsx",
    """  useEffect(() => {
    if (!addOpen || addQuery.trim().length < 1) {
      setAddResults([])
      return
    }""",
    """  useEffect(() => {
    if (!addOpen || addQuery.trim().length < 1) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset hasil pencarian saat query kosong
      setAddResults([])
      return
    }""",
    "watchlist/page.tsx: setAddResults([])",
)

print("\nSEMUA PATCH SELESAI DITERAPKAN.")
PYEOF
