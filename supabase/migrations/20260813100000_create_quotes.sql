-- Tabel quotes: harga terkini per saham, di-refresh oleh worker fetch-quotes
-- Satu baris per stock_id (upsert), bukan histori — histori candle nanti tabel terpisah

CREATE TABLE public.quotes (
  stock_id        uuid PRIMARY KEY REFERENCES public.stocks(id) ON DELETE CASCADE,
  price           numeric,
  prev_close      numeric,
  change_percent  numeric,
  day_high        numeric,
  day_low         numeric,
  volume          bigint,
  market_time     timestamp with time zone,
  quality         text DEFAULT 'FRESH' CHECK (quality = ANY (ARRAY['FRESH'::text, 'STALE'::text, 'MISSING'::text, 'INVALID'::text])),
  fetched_at      timestamp with time zone DEFAULT now(),
  fetch_error     text
);

ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.quotes TO anon;
GRANT SELECT ON public.quotes TO authenticated;
GRANT ALL ON public.quotes TO service_role;

CREATE POLICY "quotes readable by all" ON public.quotes
  FOR SELECT
  USING (true);

CREATE INDEX idx_quotes_fetched_at ON public.quotes (fetched_at);
