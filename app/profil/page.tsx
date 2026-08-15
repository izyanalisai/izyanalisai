'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import { useTheme, useLang, type Lang } from '@/lib/preferences'
import PlexusBackground from '@/components/PlexusBackground'

type Profile = {
  full_name: string | null
  risk_profile: string | null
  is_premium: boolean | null
}

const RISK_LABELS: Record<string, string> = {
  konservatif: 'Konservatif',
  moderat: 'Moderat',
  agresif: 'Agresif',
}

function MenuLink({ label, hint, href }: { label: string; hint?: string; href?: string }) {
  const router = useRouter()
  return (
    <button
      onClick={() => (href ? router.push(href) : alert(`${label} segera hadir.`))}
      className="w-full flex items-center justify-between px-4 py-3.5 text-sm text-slate-200 hover:bg-white/5 transition-colors duration-200"
    >
      <span>{label}</span>
      <span className="text-slate-600 text-xs">{hint ?? '›'}</span>
    </button>
  )
}

function ThemeLangControls() {
  const { choice, setChoice } = useTheme()
  const { lang, setLang, t } = useLang()
  const [open, setOpen] = useState<'tema' | 'bahasa' | null>(null)

  const themeLabel = choice === 'system' ? t('tema_sistem') : choice === 'dark' ? t('tema_gelap') : t('tema_terang')
  const langLabel = lang === 'id' ? 'Indonesia' : 'English'

  return (
    <>
      <button
        onClick={() => setOpen(open === 'tema' ? null : 'tema')}
        className="w-full flex items-center justify-between px-4 py-3.5 text-sm text-slate-200 hover:bg-white/5 transition-colors duration-200"
      >
        <span>{t('profil_menu_tema')}</span>
        <span className="text-slate-600 text-xs">{themeLabel}</span>
      </button>
      {open === 'tema' && (
        <div className="px-4 pb-3 flex gap-2">
          {(['system', 'dark', 'light'] as const).map((opt) => (
            <button
              key={opt}
              onClick={() => setChoice(opt)}
              className={`flex-1 rounded-lg px-2 py-2 text-xs border transition-colors duration-200 ${
                choice === opt
                  ? 'border-[#8B5CF6] bg-[#8B5CF6]/15 text-white'
                  : 'border-white/10 text-slate-400'
              }`}
            >
              {opt === 'system' ? t('tema_sistem') : opt === 'dark' ? t('tema_gelap') : t('tema_terang')}
            </button>
          ))}
        </div>
      )}

      <button
        onClick={() => setOpen(open === 'bahasa' ? null : 'bahasa')}
        className="w-full flex items-center justify-between px-4 py-3.5 text-sm text-slate-200 hover:bg-white/5 transition-colors duration-200"
      >
        <span>{t('profil_menu_bahasa')}</span>
        <span className="text-slate-600 text-xs">{langLabel}</span>
      </button>
      {open === 'bahasa' && (
        <div className="px-4 pb-3 flex gap-2">
          {(['id', 'en'] as Lang[]).map((opt) => (
            <button
              key={opt}
              onClick={() => setLang(opt)}
              className={`flex-1 rounded-lg px-2 py-2 text-xs border transition-colors duration-200 ${
                lang === opt
                  ? 'border-[#8B5CF6] bg-[#8B5CF6]/15 text-white'
                  : 'border-white/10 text-slate-400'
              }`}
            >
              {opt === 'id' ? 'Indonesia' : 'English'}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

export default function ProfilPage() {
  const router = useRouter()
  const supabase = createClient()

  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [watchlistCount, setWatchlistCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [savingName, setSavingName] = useState(false)

  useEffect(() => {
    let active = true

    async function load() {
      const { data: userData } = await supabase.auth.getUser()
      if (!active) return

      if (!userData.user) {
        router.push('/login')
        return
      }
      setUser(userData.user)

      const { data: profileData } = await supabase
        .from('profiles')
        .select('full_name, risk_profile, is_premium')
        .eq('id', userData.user.id)
        .maybeSingle()

      if (!active) return
      setProfile(profileData)
      setNameInput(profileData?.full_name ?? '')

      const { count } = await supabase
        .from('watchlist_items')
        .select('id, watchlists!inner(user_id)', { count: 'exact', head: true })
        .eq('watchlists.user_id', userData.user.id)

      if (!active) return
      setWatchlistCount(count ?? 0)
      setLoading(false)
    }

    load()
    return () => {
      active = false
    }
  }, [])

  const handleSaveName = async () => {
    if (!user || !nameInput.trim()) return
    setSavingName(true)
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: nameInput.trim() })
      .eq('id', user.id)

    if (!error) {
      setProfile((prev) => (prev ? { ...prev, full_name: nameInput.trim() } : prev))
      setEditingName(false)
    }
    setSavingName(false)
  }

  const handleLogout = async () => {
    if (!confirm('Yakin ingin keluar?')) return
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto">
        <p className="text-slate-500 text-sm">Memuat...</p>
      </main>
    )
  }

  if (!user) return null

  const riskLabel = profile?.risk_profile ? RISK_LABELS[profile.risk_profile] : null

  return (
    <main className="min-h-screen relative overflow-hidden bg-[#0F172A] text-white pb-10">
      <PlexusBackground density="subtle" />
      <div className="px-4 py-6 max-w-[480px] mx-auto">
        <div className="flex items-center gap-3">
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-bold shrink-0"
            style={{
              backgroundImage:
                'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
            }}
          >
            {(profile?.full_name || user.email || '?').charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            {editingName ? (
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
                  className="flex-1 rounded-lg bg-white/5 border border-white/10 px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6]"
                />
                <button
                  onClick={handleSaveName}
                  disabled={savingName}
                  className="text-xs font-medium text-[#8B5CF6] disabled:opacity-50"
                >
                  Simpan
                </button>
              </div>
            ) : (
              <>
                <p className="font-semibold text-base truncate">
                  {profile?.full_name || 'Trader IzyAnalisAi'}
                </p>
                <p className="text-slate-400 text-xs truncate">{user.email}</p>
              </>
            )}
          </div>
          {!editingName && (
            <button
              onClick={() => setEditingName(true)}
              className="text-xs font-medium text-slate-400 border border-white/10 rounded-full px-3 py-1.5 shrink-0"
            >
              Edit
            </button>
          )}
        </div>

        <button
          onClick={() => router.push('/berlangganan')}
          className="w-full mt-5 rounded-xl border border-white/10 px-4 py-3 flex items-center justify-between"
          style={
            profile?.is_premium
              ? {
                  backgroundImage:
                    'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
                }
              : { background: 'rgba(255,255,255,0.05)' }
          }
        >
          <span className="text-sm font-medium">
            {profile?.is_premium ? 'Premium' : 'Free'}
          </span>
          <span className="text-xs text-slate-300">
            {profile?.is_premium ? 'Kelola Langganan' : 'Upgrade ke Premium ›'}
          </span>
        </button>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
            <p className="text-slate-500 text-xs">Watchlist</p>
            <p className="font-semibold text-sm mt-0.5">
              {watchlistCount ?? 0} saham
            </p>
          </div>
          <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
            <p className="text-slate-500 text-xs">Profil Risiko</p>
            <p className="font-semibold text-sm mt-0.5">
              {riskLabel ?? 'Belum diatur'}
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-xl bg-white/5 border border-white/10 divide-y divide-white/5 overflow-hidden">
          <MenuLink label="Notifikasi" href="/notifikasi" />
          <MenuLink label="Riwayat Sinyal" href="/riwayat-sinyal" />
          <MenuLink label="Trading Plan" href="/trading-plan" />
          <a
            href="https://wa.me/6285178268451"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full flex items-center justify-between px-4 py-3.5 text-sm text-slate-200 hover:bg-white/5 transition-colors duration-200"
          >
            <span>WhatsApp</span>
            <span className="text-slate-600 text-xs">›</span>
          </a>
          <a
            href="https://t.me/komunitassahamizy"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full flex items-center justify-between px-4 py-3.5 text-sm text-slate-200 hover:bg-white/5 transition-colors duration-200"
          >
            <span>Telegram</span>
            <span className="text-slate-600 text-xs">›</span>
          </a>
          <ThemeLangControls />
          <MenuLink label="Dukungan" href="/dukungan" />
          <MenuLink label="Ajukan Fitur" href="/ajukan-fitur" />
          <MenuLink label="Laporkan Bug" href="/laporkan-bug" />
          <MenuLink label="Beri Nilai" href="/beri-nilai" />
          <MenuLink label="Legal" href="/legal" />
          <MenuLink label="Hapus Akun" href="/hapus-akun" />
        </div>

        <button
          onClick={() => {
            if (navigator.share) {
              navigator.share({ title: 'IzyAnalisAi', text: 'Analisa saham IDX berbasis AI', url: window.location.origin })
            } else {
              navigator.clipboard.writeText(window.location.origin)
              alert('Link aplikasi disalin!')
            }
          }}
          className="w-full mt-5 rounded-xl border border-white/10 px-4 py-3 text-sm font-medium text-slate-200"
        >
          Bagikan Aplikasi
        </button>

        <button
          onClick={handleLogout}
          className="w-full mt-3 rounded-xl border border-white/10 px-4 py-3 text-sm font-medium text-[#EF4444]"
        >
          Keluar
        </button>
      </div>
    </main>
  )
    }
