// Logic murni (tanpa I/O) untuk evaluasi status sinyal — dipisah dari index.ts
// supaya bisa di-unit-test dengan Deno.test tanpa perlu koneksi Supabase asli.
/** * Tentukan status baru sebuah sinyal berdasarkan harga terkini. * Urutan prioritas (poin 10.9 & 6.8): expiry > SL > TP2 > TP1. * Return status lama kalau tidak ada perubahan kondisi. */ export function classifySignalStatus(signal, currentPrice, now = new Date()) {
  if (signal.expires_at && new Date(signal.expires_at) < now) {
    return 'EXPIRED';
  }
  if (signal.direction === 'BUY') {
    if (signal.stop_loss != null && currentPrice <= signal.stop_loss) return 'HIT_SL';
    if (signal.tp2 != null && currentPrice >= signal.tp2) return 'HIT_TP2';
    if (signal.tp1 != null && currentPrice >= signal.tp1 && signal.status !== 'HIT_TP1') return 'HIT_TP1';
  } else if (signal.direction === 'SELL') {
    if (signal.stop_loss != null && currentPrice >= signal.stop_loss) return 'HIT_SL';
    if (signal.tp2 != null && currentPrice <= signal.tp2) return 'HIT_TP2';
    if (signal.tp1 != null && currentPrice <= signal.tp1 && signal.status !== 'HIT_TP1') return 'HIT_TP1';
  }
  return signal.status;
}
