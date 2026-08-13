import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import { getPostLoginPath } from '@/lib/auth-flow'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  if (code) {
    // Kumpulin cookie sesi dulu di sini, JANGAN langsung ditempel ke response
    // sementara — soalnya response finalnya baru dibikin setelah kita tau
    // tujuan redirect-nya (getPostLoginPath). Kalau ditempel ke response
    // sementara lalu response-nya diganti objek baru, cookie ikut hilang
    // (ini bug lama yang bikin login Google keliatan gagal terus).
    const cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[] = []

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
          setAll(list) {
            cookiesToSet.push(...list)
          },
        },
      }
    )

    const { data, error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error && data.user) {
      const path = await getPostLoginPath(supabase, data.user.id)
      const response = NextResponse.redirect(`${origin}${path}`)
      cookiesToSet.forEach(({ name, value, options }) =>
        response.cookies.set(name, value, options as Parameters<typeof response.cookies.set>[2])
      )
      return response
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
