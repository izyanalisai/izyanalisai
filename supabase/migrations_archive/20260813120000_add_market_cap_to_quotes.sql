-- Fix: migration 20260813100000_create_quotes.sql dihapus karena duplikat
-- (tabel quotes sudah dibuat di 20260813044457_quotes_table.sql, kolom aktif:
--  price, previous_close, day_high, day_low, volume, market_time, quality, updated_at).
-- Migration ini menambah kolom market_cap untuk kebutuhan filter Market Cap di Screener.

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS market_cap numeric;

CREATE INDEX IF NOT EXISTS idx_quotes_market_cap ON public.quotes (market_cap);
