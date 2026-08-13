import { createClient } from '@/lib/supabase/client'

export default async function Home() {
  return (
    <main style={{ padding: 24 }}>
      <h1>IzyAnalisAI</h1>
      <p>Koneksi Supabase siap.</p>
    </main>
  )
}
