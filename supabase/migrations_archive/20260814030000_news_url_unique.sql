-- Worker 5 (Ringkasan Berita) akan insert banyak kali per hari dari RSS yang
-- sama; unique index di url mencegah duplikat kalau item RSS muncul lagi di
-- fetch berikutnya (idempotency, poin 14.3.1).
CREATE UNIQUE INDEX IF NOT EXISTS news_url_unique_idx ON public.news (url) WHERE url IS NOT NULL;
