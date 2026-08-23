import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const PUBLIC_PATHS = [
  '/',
  '/landing',
  '/onboarding',
  '/login',
  '/daftar',
  '/auth',
  '/lupa-password',
  '/reset-password',
  '/legal',
  '/agreement',
]

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname
  const isPublic = PUBLIC_PATHS.some(
    (p) => path === p || path.startsWith(p + '/')
  )

  // Lewati auth check untuk halaman publik, static assets, DAN /api/*.
  // BUG FIX (23 Agustus 2026): route /api/cron/fetch-ipo-calendar (worker
  // Railway, auth pakai header x-worker-secret vs internal_secrets) kena
  // redirect ke /landing oleh middleware ini karena tidak pernah punya user
  // session cookie -- request server-to-server jadi tidak pernah sampai ke
  // handler-nya. Semua /api/* auth-nya masing-masing (worker secret, RLS via
  // service role, dsb), jadi middleware berbasis session cookie ini tidak
  // relevan buat mereka.
  if (isPublic || path.startsWith('/api/')) {
    return NextResponse.next({ request })
  }

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Redirect ke landing kalau belum login
  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/landing'
    return NextResponse.redirect(url)
  }

  // Protect /admin route
  if (path.startsWith('/admin')) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .maybeSingle()

    if (!profile?.is_admin) {
      const url = request.nextUrl.clone()
      url.pathname = '/'
      return NextResponse.redirect(url)
    }
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
