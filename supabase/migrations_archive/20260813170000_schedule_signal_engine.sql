-- pg_cron schedule untuk pipeline Worker 2 (Generate Signal): rantai
-- fetch-candles -> compute-indicators -> generate-signals, dipanggil
-- berurutan (bukan paralel) supaya tiap tahap pasti pakai data hasil
-- tahap sebelumnya yang sudah selesai, bukan data basi.
--
-- Sebelumnya ketiga fungsi ini hanya bisa dipanggil manual — sinyal
-- BUY/SELL tidak akan pernah muncul otomatis di aplikasi tanpa cron ini.
--
-- Jadwal per timeframe:
--   H1  -> tiap jam selama sesi bursa berjalan (candle jam-an, biar tidak basi)
--   H4  -> 2x sehari, mengikuti akhir tiap sesi (candle 4-jaman)
--   D1  -> 1x sehari setelah closing resmi (candle harian baru "closed" habis penutupan)
--   W1  -> 1x seminggu, Jumat setelah closing (candle mingguan baru "closed" akhir minggu)
--
-- WIB = UTC+7. Jam bursa acuan sama dengan schedule_fetch_quotes.sql:
--   09:05-11:55 WIB -> sesi 1 (02:05-04:55 UTC)
--   13:35-14:55 WIB -> sesi 2 (06:35-07:55 UTC)
--   15:20 WIB        -> closing resmi (08:20 UTC)
--
-- PENTING: sama seperti trigger_fetch_quotes, key diambil dari Supabase
-- Vault (project_url & service_role_key), tidak disimpan polos di sini.

CREATE OR REPLACE FUNCTION public.trigger_signal_pipeline(p_timeframe text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_url text;
  v_key text;
  v_headers jsonb;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE WARNING 'signal-pipeline (%): project_url atau service_role_key belum diset di Vault', p_timeframe;
    RETURN;
  END IF;

  v_headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json');

  -- 1) fetch-candles: tarik OHLCV terbaru dari sumber data ke tabel candles
  PERFORM net.http_post(
    url := v_url || '/functions/v1/fetch-candles?timeframe=' || p_timeframe,
    headers := v_headers
  );

  -- 2) compute-indicators: hitung EMA/RSI/MACD/Stochastic/Volume dari candles
  PERFORM net.http_post(
    url := v_url || '/functions/v1/compute-indicators?timeframe=' || p_timeframe,
    headers := v_headers
  );

  -- 3) generate-signals: scoring + threshold + Entry/SL/TP dari indicators
  PERFORM net.http_post(
    url := v_url || '/functions/v1/generate-signals?timeframe=' || p_timeframe,
    headers := v_headers
  );
END;
$$;

-- H1: tiap jam selama sesi bursa (menit ke-0, jam sesi 1 & sesi 2)
SELECT cron.schedule('signal-pipeline-h1-session1', '0 2-4 * * 1-5', $$SELECT public.trigger_signal_pipeline('H1');$$);
SELECT cron.schedule('signal-pipeline-h1-session2', '0 7 * * 1-5', $$SELECT public.trigger_signal_pipeline('H1');$$);

-- H4: akhir tiap sesi (setelah cukup candle H1 baru untuk agregasi)
SELECT cron.schedule('signal-pipeline-h4-session1', '0 5 * * 1-5', $$SELECT public.trigger_signal_pipeline('H4');$$);
SELECT cron.schedule('signal-pipeline-h4-session2', '25 8 * * 1-5', $$SELECT public.trigger_signal_pipeline('H4');$$);

-- D1: sekali sehari, setelah closing resmi 15:20 WIB (08:20 UTC)
SELECT cron.schedule('signal-pipeline-d1', '30 8 * * 1-5', $$SELECT public.trigger_signal_pipeline('D1');$$);

-- W1: sekali seminggu, Jumat setelah closing
SELECT cron.schedule('signal-pipeline-w1', '35 8 * * 5', $$SELECT public.trigger_signal_pipeline('W1');$$);
