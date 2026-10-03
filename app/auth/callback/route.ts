import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { getPostLoginPath } from '@/lib/auth-flow'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  const cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[] = []
  const redirectWithCookies = (path: string) => {
    const response = NextResponse.redirect(new URL(path, origin))
    cookiesToSet.forEach(({ name, value, options }) =>
      response.cookies.set(name, value, options as Parameters<typeof response.cookies.set>[2])
    )
    return response
  }

  if (code) {
    // Kumpulin cookie sesi dulu di sini, JANGAN langsung ditempel ke response
    // sementara — soalnya response finalnya baru dibikin setelah kita tau
    // tujuan redirect-nya (getPostLoginPath). Kalau ditempel ke response
    // sementara lalu response-nya diganti objek baru, cookie ikut hilang
    // (ini bug lama yang bikin login Google keliatan gagal terus).


    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
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
      return redirectWithCookies(path)
    }
  }

  return redirectWithCookies('/login?error=auth_callback_failed')
}
