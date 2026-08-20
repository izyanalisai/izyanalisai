-- pg_cron schedule untuk Worker 1 (Market Data Refresh)
-- Jadwal mengikuti blueprint 14.2:
--   08:50 WIB  -> harga pembukaan acuan (sekali)
--   09:05-11:55 WIB -> setiap 5 menit (sesi 1)
--   13:35-14:55 WIB -> setiap 5 menit (sesi 2)
--   15:20 WIB  -> closing resmi (sekali)
-- WIB = UTC+7, jadi semua jam di bawah dikonversi ke UTC untuk cron.
--
-- PENTING: migration ini TIDAK menyimpan service role key secara polos.
-- Key diambil dari Supabase Vault (project_url & service_role_key harus
-- disimpan lebih dulu lewat Dashboard > Project Settings > Vault, atau
-- lewat SQL: select vault.create_secret('nilai-key', 'service_role_key');
-- select vault.create_secret('https://xxxx.supabase.co', 'project_url');

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.trigger_fetch_quotes()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_url text;
  v_key text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE WARNING 'fetch-quotes: project_url atau service_role_key belum diset di Vault';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := v_url || '/functions/v1/fetch-quotes',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json')
  );
END;
$$;

SELECT cron.schedule('fetch-quotes-opening', '50 1 * * 1-5', $$SELECT public.trigger_fetch_quotes();$$);
SELECT cron.schedule('fetch-quotes-session1', '5-59/5 2-4 * * 1-5', $$SELECT public.trigger_fetch_quotes();$$);
SELECT cron.schedule('fetch-quotes-session2a', '35-59/5 6 * * 1-5', $$SELECT public.trigger_fetch_quotes();$$);
SELECT cron.schedule('fetch-quotes-session2b', '0-55/5 7 * * 1-5', $$SELECT public.trigger_fetch_quotes();$$);
SELECT cron.schedule('fetch-quotes-closing', '20 8 * * 1-5', $$SELECT public.trigger_fetch_quotes();$$);
