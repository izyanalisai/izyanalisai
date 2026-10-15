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

  // Supabase may rotate or clear cookies during getUser(). Preserve them on redirects.
  const redirectWithCookies = (pathname: string) => {
    // pathname may contain a fixed, intentional query (e.g. accountDeleted).
    // Assigning that whole value to url.pathname percent-encodes '?' and
    // drops the query; construct a same-origin destination instead.
    if (!pathname.startsWith('/') || pathname.startsWith('//')) {
      throw new Error('UNSAFE_REDIRECT_TARGET')
    }
    const url = new URL(pathname, request.nextUrl.origin)
    url.hash = ''
    const redirect = NextResponse.redirect(url)
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie))
    return redirect
  }

  // Redirect ke landing kalau belum login
  if (!user) {
    return redirectWithCookies('/landing')
  }

  // Every authenticated page enforces account deletion, not just OAuth login.
  // A stale cookie or a failed sign-out must never grant access to deleted users.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('deleted_at, is_admin')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError) {
    return redirectWithCookies('/login?error=profile_unavailable')
  }
  if (profile?.deleted_at) {
    try {
      await supabase.auth.signOut()
    } catch {
      // The profile gate still denies this request if remote sign-out fails.
    }
    return redirectWithCookies('/login?accountDeleted=1')
  }

  // Guard the /admin path segment, not unrelated names like /administrator.
  if ((path === '/admin' || path.startsWith('/admin/')) && !profile?.is_admin) {
    return redirectWithCookies('/')
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
