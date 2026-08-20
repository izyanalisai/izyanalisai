CREATE OR REPLACE FUNCTION public.trigger_fetch_news()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_url text; v_key text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE WARNING 'fetch-news: project_url/service_role_key belum di Vault'; RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_url || '/functions/v1/fetch-news',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json')
  );
END; $$;

-- 07:00 WIB = 00:00 UTC, 16:00 WIB = 09:00 UTC
SELECT cron.schedule('fetch-news-morning', '0 0 * * *', $$SELECT public.trigger_fetch_news();$$);
SELECT cron.schedule('fetch-news-afternoon', '0 9 * * *', $$SELECT public.trigger_fetch_news();$$);
