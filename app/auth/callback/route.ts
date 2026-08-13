import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'

  if (code) {
    // Buat response redirect DULU, lalu tulis cookie session langsung ke
    // response ini juga (bukan cuma ke cookie store lewat next/headers).
    // Sebelumnya cookie hanya ditulis via cookies().set() di server.ts,
    // yang tidak otomatis ter-attach ke NextResponse.redirect() yang
    // dikembalikan terpisah — jadi middleware di request berikutnya
    // kadang belum melihat session dan melempar balik ke /landing
    // (baru sukses setelah klik ulang / reload).
    const redirectResponse = NextResponse.redirect(`${origin}${next}`)

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

    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return redirectResponse
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
