// Logic murni (tanpa I/O) untuk evaluasi status sinyal — dipisah dari index.ts
// supaya bisa di-unit-test dengan Deno.test tanpa perlu koneksi Supabase asli.

// FIX (25 Agustus 2026, CI test-edge-functions.yml pertama kali jalan): sebelumnya
// signal/currentPrice tidak punya type annotation -- lolos di lokal (kalau pernah
// dites tanpa `deno check`), tapi `deno test` di CI melakukan type-check default
// dan gagal TS7006 "implicitly has an 'any' type". Ditambahkan interface minimal
// sesuai field yang benar-benar dipakai fungsi ini -- tidak mengubah logic sama
// sekali, murni anotasi tipe.
export interface EvaluatedSignal {
  direction: 'BUY' | 'SELL';
  status: string;
  stop_loss?: number | null;
  tp1?: number | null;
  tp2?: number | null;
  expires_at?: string | null;
}

/** * Tentukan status baru sebuah sinyal berdasarkan harga terkini. * Urutan prioritas (poin 10.9 & 6.8): expiry > SL > TP2 > TP1. * Return status lama kalau tidak ada perubahan kondisi. */ export function classifySignalStatus(signal: EvaluatedSignal, currentPrice: number, now: Date = new Date()) {
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
