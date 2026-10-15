import type { SupabaseClient } from '@supabase/supabase-js'

// Menentukan halaman tujuan setelah login/OTP sukses:
// belum accept agreement aktif -> /agreement
// sudah accept tapi belum pilih risk profile -> /profil-risiko
// sudah lengkap -> '/'
export async function getPostLoginPath(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('risk_profile, deleted_at')
    .eq('id', userId)
    .maybeSingle()

  if (profileError) throw new Error('POST_LOGIN_PROFILE_UNAVAILABLE')

  // Akun yang sudah minta hapus akun tidak boleh dipakai login lagi,
  // meski masih dalam masa pemulihan 30 hari.
  if (profile?.deleted_at) {
    const { error: signOutError } = await supabase.auth.signOut()
    if (signOutError) throw new Error('POST_LOGIN_DELETED_ACCOUNT_SIGNOUT_FAILED')
    return '/login?accountDeleted=1'
  }

  const { data: agreement, error: agreementError } = await supabase
    .from('agreements')
    .select('id')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (agreementError) throw new Error('POST_LOGIN_AGREEMENT_UNAVAILABLE')

  if (agreement) {
    const { data: acceptance, error: acceptanceError } = await supabase
      .from('agreement_acceptances')
      .select('id')
      .eq('user_id', userId)
      .eq('agreement_id', agreement.id)
      .maybeSingle()

    if (acceptanceError) throw new Error('POST_LOGIN_ACCEPTANCE_UNAVAILABLE')
    if (!acceptance) return '/agreement'
  }

  if (!profile?.risk_profile) return '/profil-risiko'

  return '/'
}
