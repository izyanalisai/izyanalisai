import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// DEPRECATED 21 Agustus 2026: fungsi ini digantikan generate-signals-mtf.
// Versi lama ini punya bug getExpiry() hardcode 15:30 WIB (sudah pernah
// menyebabkan 0 sinyal ACTIVE). Tidak dipanggil dari cron/frontend manapun
// per audit 21 Agustus 2026. Dikosongkan agar tidak bisa ke-trigger tidak
// sengaja. Hapus folder ini dari repo GitHub juga.
Deno.serve(async (_req)=>{
  return new Response(JSON.stringify({
    error: 'deprecated: use generate-signals-mtf instead'
  }), {
    status: 410,
    headers: {
      'Content-Type': 'application/json'
    }
  });
});
