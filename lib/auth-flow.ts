import type { SupabaseClient } from '@supabase/supabase-js'

// Menentukan halaman tujuan setelah login/OTP sukses:
// belum accept agreement aktif -> /agreement
// sudah accept tapi belum pilih risk profile -> /profil-risiko
// sudah lengkap -> '/'
export async function getPostLoginPath(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('risk_profile, deleted_at')
    .eq('id', userId)
    .maybeSingle()

  // Akun yang sudah minta hapus akun tidak boleh dipakai login lagi,
  // meski masih dalam masa pemulihan 30 hari.
  if (profile?.deleted_at) {
    await supabase.auth.signOut()
    return '/login?accountDeleted=1'
  }

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

  if (!profile?.risk_profile) return '/profil-risiko'

  return '/'
}
