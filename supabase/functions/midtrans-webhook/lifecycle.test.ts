// Test transisi status lifecycle sinyal (classifySignalStatus di logic.ts).
// Spec v6.1 section 4 prioritas #5: transisi status tidak boleh berubah diam-diam
// (harus mengikuti prioritas expiry > SL > TP2 > TP1, dan tidak boleh regresi
// mundur -- misal dari HIT_TP1 balik jadi ACTIVE kalau harga retrace).
// Jalankan: deno test lifecycle.test.ts

import { assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { classifySignalStatus } from './logic.ts';

function buySignal(overrides = {}) {
  return {
    direction: 'BUY',
    status: 'ACTIVE',
    stop_loss: 100,
    tp1: 120,
    tp2: 140,
    expires_at: null,
    ...overrides,
  };
}

function sellSignal(overrides = {}) {
  return {
    direction: 'SELL',
    status: 'ACTIVE',
    stop_loss: 140,
    tp1: 120,
    tp2: 100,
    expires_at: null,
    ...overrides,
  };
}

// --- Progresi normal BUY: ACTIVE -> HIT_TP1 -> HIT_TP2 ---

Deno.test('BUY - harga belum menyentuh apapun -> tetap ACTIVE', () => {
  const s = buySignal();
  assertEquals(classifySignalStatus(s, 110), 'ACTIVE');
});

Deno.test('BUY - harga sentuh TP1 -> HIT_TP1', () => {
  const s = buySignal();
  assertEquals(classifySignalStatus(s, 121), 'HIT_TP1');
});

Deno.test('BUY - sudah HIT_TP1, harga lanjut ke TP2 -> HIT_TP2', () => {
  const s = buySignal({ status: 'HIT_TP1' });
  assertEquals(classifySignalStatus(s, 145), 'HIT_TP2');
});

Deno.test('BUY - sudah HIT_TP1, harga RETRACE turun lagi -> TIDAK boleh regresi balik ke ACTIVE, tetap HIT_TP1', () => {
  const s = buySignal({ status: 'HIT_TP1' });
  assertEquals(classifySignalStatus(s, 105), 'HIT_TP1');
});

Deno.test('BUY - sudah HIT_TP1, dipanggil ulang dengan harga masih di rentang TP1 -> tidak diklasifikasi ulang jadi HIT_TP1 (tidak infinite re-trigger, tapi hasil akhir tetap benar)', () => {
  const s = buySignal({ status: 'HIT_TP1' });
  assertEquals(classifySignalStatus(s, 125), 'HIT_TP1');
});

Deno.test('BUY - harga langsung tembus SL -> HIT_SL', () => {
  const s = buySignal();
  assertEquals(classifySignalStatus(s, 95), 'HIT_SL');
});

// --- Same-candle ambiguity: SL didahulukan dari TP (golden test case "Same-candle TP/SL ambiguity") ---

Deno.test('BUY - SL dan TP2 sama-sama tersentuh di candle yang sama -> SL didahulukan (fail-safe, bukan TP2)', () => {
  const s = buySignal({ stop_loss: 100, tp1: 90, tp2: 80 }); // dibuat harga rendah supaya current price di bawah SL juga "lewat" TP1/TP2 kalau logic salah urutan
  // currentPrice di bawah stop_loss -> harus HIT_SL walau secara angka juga <= tp1/tp2 kalau arahnya salah
  assertEquals(classifySignalStatus(s, 99), 'HIT_SL');
});

Deno.test('BUY - SL null (belum di-set) -> lanjut cek TP2 seperti biasa', () => {
  const s = buySignal({ stop_loss: null });
  assertEquals(classifySignalStatus(s, 145), 'HIT_TP2');
});

// --- Prioritas expiry di atas segalanya ---

Deno.test('BUY - sudah lewat expires_at DAN harga tembus SL -> tetap EXPIRED (expiry prioritas tertinggi)', () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const s = buySignal({ expires_at: '2026-08-24T00:00:00Z' });
  assertEquals(classifySignalStatus(s, 50, now), 'EXPIRED');
});

Deno.test('BUY - belum lewat expires_at -> evaluasi harga seperti biasa (bukan EXPIRED)', () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const s = buySignal({ expires_at: '2026-08-30T00:00:00Z' });
  assertEquals(classifySignalStatus(s, 121, now), 'HIT_TP1');
});

// --- Progresi normal SELL (arah harga terbalik dari BUY) ---

Deno.test('SELL - harga belum menyentuh apapun -> tetap ACTIVE', () => {
  const s = sellSignal();
  assertEquals(classifySignalStatus(s, 130), 'ACTIVE');
});

Deno.test('SELL - harga turun sentuh TP1 -> HIT_TP1', () => {
  const s = sellSignal();
  assertEquals(classifySignalStatus(s, 119), 'HIT_TP1');
});

Deno.test('SELL - sudah HIT_TP1, harga lanjut turun ke TP2 -> HIT_TP2', () => {
  const s = sellSignal({ status: 'HIT_TP1' });
  assertEquals(classifySignalStatus(s, 95), 'HIT_TP2');
});

Deno.test('SELL - harga naik tembus SL -> HIT_SL', () => {
  const s = sellSignal();
  assertEquals(classifySignalStatus(s, 145), 'HIT_SL');
});

Deno.test('SELL - sudah HIT_TP1, harga retrace naik lagi -> tidak regresi ke ACTIVE, tetap HIT_TP1', () => {
  const s = sellSignal({ status: 'HIT_TP1' });
  assertEquals(classifySignalStatus(s, 135), 'HIT_TP1');
});

// --- Status final (HIT_SL/HIT_TP2/EXPIRED/INVALIDATED) harus stabil, tidak berubah lagi ---

for (const finalStatus of ['HIT_SL', 'HIT_TP2', 'EXPIRED', 'INVALIDATED']) {
  Deno.test(`BUY - sinyal sudah berstatus final ${finalStatus}, harga masih di rentang netral -> status tidak berubah sendiri`, () => {
    const s = buySignal({ status: finalStatus });
    assertEquals(classifySignalStatus(s, 110), finalStatus);
  });
    }
