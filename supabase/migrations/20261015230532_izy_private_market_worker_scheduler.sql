-- Hosted market scheduler: no service-role JWT leaves the database.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.dispatch_market_worker(p_worker text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog
AS $$
DECLARE
  v_secret text;
  v_request_id bigint;
BEGIN
  IF p_worker NOT IN ('fetch-news', 'fetch-index', 'detect-unusual-activity') THEN
    RAISE EXCEPTION 'Unsupported market worker';
  END IF;
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'worker_shared_secret';
  IF v_secret IS NULL OR length(v_secret) < 32 OR length(v_secret) > 512 THEN
    RAISE EXCEPTION 'Market worker credential unavailable';
  END IF;
  -- No empty-data synthetic generation. Workers dependent on market data
  -- are dispatched only after the actual upstream rows exist.
  IF p_worker = 'fetch-index' AND NOT EXISTS (SELECT 1 FROM public.stocks LIMIT 1) THEN
    RETURN;
  END IF;
  IF p_worker = 'detect-unusual-activity' AND NOT EXISTS (SELECT 1 FROM public.quotes LIMIT 1) THEN
    RETURN;
  END IF;
  SELECT net.http_post(
    url := 'https://zbsekszwhyjhtttqzpfq.supabase.co/functions/v1/' || p_worker,
    headers := jsonb_build_object('Content-Type','application/json','x-worker-secret',v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_request_id;
  IF v_request_id IS NULL THEN
    RAISE EXCEPTION 'Worker dispatch was not enqueued';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app_private.dispatch_market_worker(text) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('izy-news-morning', '0 0 * * *',
  $$SELECT app_private.dispatch_market_worker('fetch-news');$$);
SELECT cron.schedule('izy-news-afternoon', '0 9 * * *',
  $$SELECT app_private.dispatch_market_worker('fetch-news');$$);
SELECT cron.schedule('izy-index-closing', '15 9 * * 1-5',
  $$SELECT app_private.dispatch_market_worker('fetch-index');$$);
SELECT cron.schedule('izy-unusual-activity-after-close', '0 10 * * 1-5',
  $$SELECT app_private.dispatch_market_worker('detect-unusual-activity');$$);
