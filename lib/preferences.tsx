'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

// ---------- Theme (dokumen 3.1 & 8.1: default ikut sistem, user bisa ganti manual dari Profil) ----------

type ThemeChoice = 'system' | 'dark' | 'light'
type ResolvedTheme = 'dark' | 'light'

type ThemeContextValue = {
  choice: ThemeChoice
  resolved: ResolvedTheme
  setChoice: (choice: ThemeChoice) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)
const THEME_STORAGE_KEY = 'izy_theme'

function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'dark' || choice === 'light') return choice
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>('system')
  const [resolved, setResolved] = useState<ResolvedTheme>('dark')

  useEffect(() => {
    const stored = (localStorage.getItem(THEME_STORAGE_KEY) as ThemeChoice | null) ?? 'system'
    setChoiceState(stored)
    setResolved(resolveTheme(stored))
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('dark', 'light')
    root.classList.add(resolved)
    root.style.colorScheme = resolved
  }, [resolved])

  useEffect(() => {
    if (choice !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => setResolved(resolveTheme('system'))
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [choice])

  const setChoice = useCallback((next: ThemeChoice) => {
    localStorage.setItem(THEME_STORAGE_KEY, next)
    setChoiceState(next)
    setResolved(resolveTheme(next))
  }, [])

  const value = useMemo(() => ({ choice, resolved, setChoice }), [choice, resolved, setChoice])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme harus dipakai di dalam ThemeProvider')
  return ctx
}

// ---------- Language (dokumen 8.1: toggle Indonesia/English, hanya label UI & teks statis) ----------

export type Lang = 'id' | 'en'

const DICT = {
  id: {
    nav_home: 'Home',
    nav_screener: 'Screener',
    nav_signal: 'Signal',
    nav_watchlist: 'Watchlist',
    nav_ai_task: 'AI Task',
    nav_profil: 'Profil',
    profil_menu_notifikasi: 'Notifikasi',
    profil_menu_riwayat: 'Riwayat Sinyal',
    profil_menu_trading_plan: 'Trading Plan',
    profil_menu_bahasa: 'Bahasa',
    profil_menu_tema: 'Tema',
    profil_menu_dukungan: 'Dukungan',
    profil_menu_ajukan_fitur: 'Ajukan Fitur',
    profil_menu_laporkan_bug: 'Laporkan Bug',
    profil_menu_beri_nilai: 'Beri Nilai',
    profil_menu_legal: 'Legal',
    tema_sistem: 'Ikuti Sistem',
    tema_gelap: 'Gelap',
    tema_terang: 'Terang',
  },
  en: {
    nav_home: 'Home',
    nav_screener: 'Screener',
    nav_signal: 'Signal',
    nav_watchlist: 'Watchlist',
    nav_ai_task: 'AI Task',
    nav_profil: 'Profile',
    profil_menu_notifikasi: 'Notifications',
    profil_menu_riwayat: 'Signal History',
    profil_menu_trading_plan: 'Trading Plan',
    profil_menu_bahasa: 'Language',
    profil_menu_tema: 'Theme',
    profil_menu_dukungan: 'Support',
    profil_menu_ajukan_fitur: 'Request Feature',
    profil_menu_laporkan_bug: 'Report Bug',
    profil_menu_beri_nilai: 'Rate App',
    profil_menu_legal: 'Legal',
    tema_sistem: 'Follow System',
    tema_gelap: 'Dark',
    tema_terang: 'Light',
  },
} as const

export type DictKey = keyof typeof DICT.id

type LangContextValue = {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: DictKey) => string
}

const LangContext = createContext<LangContextValue | null>(null)
const LANG_STORAGE_KEY = 'izy_lang'

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('id')

  useEffect(() => {
    const stored = localStorage.getItem(LANG_STORAGE_KEY) as Lang | null
    if (stored === 'id' || stored === 'en') setLangState(stored)
  }, [])

  const setLang = useCallback((next: Lang) => {
    localStorage.setItem(LANG_STORAGE_KEY, next)
    setLangState(next)
  }, [])

  const t = useCallback((key: DictKey) => DICT[lang][key], [lang])

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}

export function useLang() {
  const ctx = useContext(LangContext)
  if (!ctx) throw new Error('useLang harus dipakai di dalam LanguageProvider')
  return ctx
}
