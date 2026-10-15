-- Extend authenticated private market dispatch to observable live OHLCV
-- and indicators; every endpoint independently validates x-worker-secret.
CREATE OR REPLACE FUNCTION app_private.dispatch_market_worker(p_worker text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog AS $$
DECLARE v_secret text; v_request_id bigint;
BEGIN
  IF p_worker NOT IN (
    'fetch-news','fetch-index','detect-unusual-activity',
    'fetch-quotes','fetch-candles','compute-indicators'
  ) THEN
    RAISE EXCEPTION 'Unsupported market worker';
  END IF;
  SELECT value INTO v_secret FROM public.internal_secrets
    WHERE key='worker_shared_secret';
  IF v_secret IS NULL OR length(v_secret)<32 OR length(v_secret)>512
    THEN RAISE EXCEPTION 'Market worker credential unavailable';
  END IF;
  IF p_worker IN ('fetch-quotes','fetch-candles','compute-indicators','fetch-index')
    AND NOT EXISTS(SELECT 1 FROM public.stocks LIMIT 1) THEN RETURN; END IF;
  IF p_worker='compute-indicators'
    AND NOT EXISTS(SELECT 1 FROM public.candles LIMIT 1) THEN RETURN; END IF;
  IF p_worker='detect-unusual-activity'
    AND NOT EXISTS(SELECT 1 FROM public.quotes LIMIT 1) THEN RETURN; END IF;
  SELECT net.http_post(
    url:='https://zbsekszwhyjhtttqzpfq.supabase.co/functions/v1/' || p_worker,
    headers:=jsonb_build_object(
      'Content-Type','application/json','x-worker-secret',v_secret),
    body:='{}'::jsonb,
    timeout_milliseconds:=CASE WHEN p_worker='fetch-candles'
      THEN 120000 ELSE 60000 END
  ) INTO v_request_id;
  IF v_request_id IS NULL THEN RAISE EXCEPTION 'Worker dispatch was not enqueued'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION app_private.dispatch_market_worker(text)
  FROM PUBLIC, anon, authenticated;
SELECT cron.schedule('izy-quotes-opening','10 2 * * 1-5',
 $$SELECT app_private.dispatch_market_worker('fetch-quotes');$$);
SELECT cron.schedule('izy-quotes-midday','30 4 * * 1-5',
 $$SELECT app_private.dispatch_market_worker('fetch-quotes');$$);
SELECT cron.schedule('izy-quotes-afternoon','40 6 * * 1-5',
 $$SELECT app_private.dispatch_market_worker('fetch-quotes');$$);
SELECT cron.schedule('izy-quotes-closing','15 8 * * 1-5',
 $$SELECT app_private.dispatch_market_worker('fetch-quotes');$$);
SELECT cron.schedule('izy-candles-daily','35 8 * * 1-5',
 $$SELECT app_private.dispatch_market_worker('fetch-candles');$$);
SELECT cron.schedule('izy-indicators-daily','55 8 * * 1-5',
 $$SELECT app_private.dispatch_market_worker('compute-indicators');$$);
