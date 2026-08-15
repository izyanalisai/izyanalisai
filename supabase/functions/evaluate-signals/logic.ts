// Logic murni (tanpa I/O) untuk evaluasi status sinyal — dipisah dari index.ts
// supaya bisa di-unit-test dengan Deno.test tanpa perlu koneksi Supabase asli.

export type SignalDirection = 'BUY' | 'SELL' | 'HOLD'
export type SignalStatus = 'ACTIVE' | 'HIT_TP1' | 'HIT_TP2' | 'HIT_SL' | 'EXPIRED' | 'INVALIDATED'

export type SignalInput = {
  direction: SignalDirection
  tp1: number | null
  tp2: number | null
  stop_loss: number | null
  status: SignalStatus
  expires_at: string | null
}

/** * Tentukan status baru sebuah sinyal berdasarkan harga terkini. * Urutan prioritas (poin 10.9 & 6.8): expiry > SL > TP2 > TP1. * Return status lama kalau tidak ada perubahan kondisi. */
export function classifySignalStatus( signal: SignalInput, currentPrice: number, now: Date = new Date(), ): SignalStatus {
  if (signal.expires_at && new Date(signal.expires_at) < now) {
    return 'EXPIRED'
  }

  if (signal.direction === 'BUY') {
    if (signal.stop_loss != null && currentPrice <= signal.stop_loss) return 'HIT_SL'
    if (signal.tp2 != null && currentPrice >= signal.tp2) return 'HIT_TP2'
    if (signal.tp1 != null && currentPrice >= signal.tp1 && signal.status !== 'HIT_TP1') return 'HIT_TP1'
  } else if (signal.direction === 'SELL') {
    if (signal.stop_loss != null && currentPrice >= signal.stop_loss) return 'HIT_SL'
    if (signal.tp2 != null && currentPrice <= signal.tp2) return 'HIT_TP2'
    if (signal.tp1 != null && currentPrice <= signal.tp1 && signal.status !== 'HIT_TP1') return 'HIT_TP1'
  }

  return signal.status
                                    }
