import type { SupabaseClient } from '@supabase/supabase-js'

// Menentukan halaman tujuan setelah login/OTP sukses:
// belum accept agreement aktif -> /agreement
// sudah accept tapi belum pilih risk profile -> /profil-risiko
// sudah lengkap -> '/'
export async function getPostLoginPath(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const { data: agreement } = await supabase
    .from('agreements')
    .select('id')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (agreement) {
    const { data: acceptance } = await supabase
      .from('agreement_acceptances')
      .select('id')
      .eq('user_id', userId)
      .eq('agreement_id', agreement.id)
      .maybeSingle()

    if (!acceptance) return '/agreement'
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('risk_profile')
    .eq('id', userId)
    .maybeSingle()

  if (!profile?.risk_profile) return '/profil-risiko'

  return '/'
}
