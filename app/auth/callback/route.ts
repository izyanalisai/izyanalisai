import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import { getPostLoginPath } from '@/lib/auth-flow'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  if (code) {
    let redirectResponse = NextResponse.redirect(`${origin}/`)

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return Array.from(
              request.headers.get('cookie')?.split('; ').filter(Boolean).map((c) => {
                const idx = c.indexOf('=')
                return { name: c.slice(0, idx), value: c.slice(idx + 1) }
              }) ?? []
            )
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              redirectResponse.cookies.set(name, value, options)
            )
          },
        },
      }
    )

    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error && data.user) {
      const path = await getPostLoginPath(supabase, data.user.id)
      redirectResponse = NextResponse.redirect(`${origin}${path}`)
      return redirectResponse
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
