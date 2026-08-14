'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useLang, type DictKey } from '@/lib/preferences'

const GRADIENT =
  'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)'

type NavItem = {
  href: string
  labelKey: DictKey
  icon: (active: boolean) => ReactNode
}

function iconProps(active: boolean) {
  return {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: active ? '#fff' : 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
}

const NAV_ITEMS: NavItem[] = [
  {
    href: '/',
    labelKey: 'nav_home',
    icon: (active) => (
      <svg {...iconProps(active)}>
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
      </svg>
    ),
  },
  {
    href: '/screener',
    labelKey: 'nav_screener',
    icon: (active) => (
      <svg {...iconProps(active)}>
        <rect x="3" y="12" width="4" height="8" rx="1" />
        <rect x="10" y="7" width="4" height="13" rx="1" />
        <rect x="17" y="3" width="4" height="17" rx="1" />
      </svg>
    ),
  },
  {
    href: '/signal',
    labelKey: 'nav_signal',
    icon: (active) => (
      <svg {...iconProps(active)}>
        <path d="M3 12h4l2-7 4 14 2-7h6" />
      </svg>
    ),
  },
  {
    href: '/watchlist',
    labelKey: 'nav_watchlist',
    icon: (active) => (
      <svg {...iconProps(active)}>
        <path d="M12 4.5c-4-3-9 0-9 4.8 0 4 3.5 6.6 9 11.2 5.5-4.6 9-7.2 9-11.2 0-4.8-5-7.8-9-4.8Z" />
      </svg>
    ),
  },
  {
    href: '/ai-task',
    labelKey: 'nav_ai_task',
    icon: (active) => (
      <svg {...iconProps(active)}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5v5l3 2" />
      </svg>
    ),
  },
  {
    href: '/profil',
    labelKey: 'nav_profil',
    icon: (active) => (
      <svg {...iconProps(active)}>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M4.5 20c1.6-3.6 4.6-5.5 7.5-5.5s5.9 1.9 7.5 5.5" />
      </svg>
    ),
  },
]

// Halaman yang TIDAK boleh nampilin app shell (Header + BottomNav):
// semua alur pre-auth (landing, login, daftar, onboarding, agreement,
// profil-risiko, lupa/reset password) + halaman dalam yang sudah full-screen.
export const NO_SHELL_PREFIXES = [
  '/splash', '/landing', '/login', '/daftar', '/onboarding', '/agreement',
  '/profil-risiko', '/lupa-password', '/reset-password', '/auth',
]

const HIDDEN_PREFIXES = [
  ...NO_SHELL_PREFIXES,
  '/saham/', '/notifikasi', '/kalender', '/berita', '/riwayat-sinyal',
  '/trading-plan', '/chat', '/berlangganan',
  '/hapus-akun', '/legal', '/dukungan', '/ajukan-fitur', '/laporkan-bug',
]

export default function BottomNav() {
  const pathname = usePathname()
  const { t } = useLang()

  if (HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) {
    return null
  }

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href)

  return (
    <nav
      aria-label="Navigasi utama"
      className="
        fixed z-40 bg-[#0F172A]/95 backdrop-blur border-white/10
        bottom-0 left-0 right-0 border-t px-2 pb-[env(safe-area-inset-bottom)]
        lg:top-0 lg:bottom-0 lg:right-auto lg:w-60 lg:border-t-0 lg:border-r lg:px-3 lg:py-6 lg:pb-6
      "
    >
      <ul className="flex justify-between lg:flex-col lg:gap-1 lg:justify-start">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href)
          return (
            <li key={item.href} className="flex-1 lg:flex-none">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className="
                  group relative flex flex-col items-center gap-1 py-2.5
                  lg:flex-row lg:gap-3 lg:rounded-xl lg:px-3 lg:py-2.5
                  transition-colors duration-200 ease-out
                "
              >
                <span
                  className="
                    flex items-center justify-center rounded-full
                    w-9 h-9 transition-[background,transform] duration-[250ms]
                    [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]
                    motion-reduce:transition-none
                    lg:w-8 lg:h-8
                  "
                  style={{
                    backgroundImage: active ? GRADIENT : undefined,
                    color: active ? '#fff' : '#64748B',
                  }}
                >
                  {item.icon(active)}
                </span>
                <span
                  className={`text-[11px] lg:text-sm ${
                    active ? 'text-white font-medium' : 'text-slate-500'
                  }`}
                >
                  {t(item.labelKey)}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
