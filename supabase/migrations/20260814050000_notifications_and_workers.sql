-- Migration: sinkronisasi perubahan yang sudah diterapkan langsung di Supabase
-- (notifikasi Unusual Activity, notifikasi Sinyal baru untuk watchlist,
-- notifikasi Berita untuk watchlist, cron Kalender IPO, worker Morning Briefing)

-- 1) Notifikasi Unusual Activity ke user yang subscribe
CREATE OR REPLACE FUNCTION public.notify_unusual_activity_subscribers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.notifications (user_id, category, title, body, reference_id, event_id)
  SELECT
    np.user_id,
    'UNUSUAL_ACTIVITY',
    'Volume Tidak Wajar: ' || s.ticker,
    s.ticker || ' bergerak ' || COALESCE(NEW.price_change_percent::text, '-') || '% dengan volume ' ||
      round(COALESCE(NEW.volume / NULLIF(NEW.avg_volume_20d,0), 0), 1) || 'x rata-rata 20 hari (severity: ' || NEW.severity || ')',
    NEW.stock_id,
    'ua:' || NEW.id || ':' || np.user_id
  FROM public.notification_preferences np
  JOIN public.stocks s ON s.id = NEW.stock_id
  WHERE np.master_enabled = true AND np.unusual_activity_alert = true
  ON CONFLICT (event_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_notify_unusual_activity ON public.unusual_activities;
CREATE TRIGGER trg_notify_unusual_activity
AFTER INSERT ON public.unusual_activities
FOR EACH ROW
EXECUTE FUNCTION public.notify_unusual_activity_subscribers();

-- 2) Notifikasi sinyal baru untuk user yang punya saham itu di watchlist
CREATE OR REPLACE FUNCTION public.notify_watchlist_new_signal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (user_id, category, title, body, reference_id, event_id)
  SELECT DISTINCT
    w.user_id,
    'SIGNAL',
    'Sinyal Baru: ' || s.ticker || ' (' || NEW.direction || ')',
    'Sinyal ' || NEW.direction || ' ' || NEW.timeframe || ' untuk ' || s.ticker || ' di watchlist Anda sudah tersedia.',
    NEW.id,
    'signal:' || NEW.id || ':' || w.user_id
  FROM public.watchlist_items wi
  JOIN public.watchlists w ON w.id = wi.watchlist_id
  JOIN public.notification_preferences np ON np.user_id = w.user_id
  JOIN public.stocks s ON s.id = NEW.stock_id
  WHERE wi.stock_id = NEW.stock_id
    AND np.master_enabled = true
    AND np.signal_alerts = true
  ON CONFLICT (event_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_notify_watchlist_new_signal ON public.signals;
CREATE TRIGGER trg_notify_watchlist_new_signal
AFTER INSERT ON public.signals
FOR EACH ROW
EXECUTE FUNCTION public.notify_watchlist_new_signal();

-- 3) Notifikasi berita untuk user yang punya saham terkait di watchlist
CREATE OR REPLACE FUNCTION public.notify_watchlist_news()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.related_tickers IS NULL OR array_length(NEW.related_tickers, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (user_id, category, title, body, reference_id, event_id)
  SELECT DISTINCT
    w.user_id,
    'NEWS',
    'Berita: ' || s.ticker,
    NEW.title,
    NEW.id,
    'news:' || NEW.id || ':' || w.user_id
  FROM public.watchlist_items wi
  JOIN public.watchlists w ON w.id = wi.watchlist_id
  JOIN public.stocks s ON s.id = wi.stock_id
  JOIN public.notification_preferences np ON np.user_id = w.user_id
  WHERE s.ticker = ANY(NEW.related_tickers)
    AND np.master_enabled = true
    AND np.news_updates = true
  ON CONFLICT (event_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_notify_watchlist_news ON public.news;
CREATE TRIGGER trg_notify_watchlist_news
AFTER INSERT ON public.news
FOR EACH ROW
EXECUTE FUNCTION public.notify_watchlist_news();

-- 4) Cron Kalender IPO (fungsinya sudah ada sebelumnya, cuma belum dijadwalkan)
SELECT cron.schedule(
  'fetch-ipo-calendar-daily',
  '10 23 * * 0-4',
  $$SELECT public.trigger_fetch_ipo_calendar();$$
);

-- 5) Worker Morning Briefing (07:00 WIB, hari kerja) - baru dibuat, belum ada sebelumnya
CREATE OR REPLACE FUNCTION public.dispatch_morning_briefing()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ihsg record;
  v_gainers text;
  v_losers text;
  v_body text;
  v_event_id text;
BEGIN
  v_event_id := 'morning_briefing:' || (now() at time zone 'Asia/Jakarta')::date;

  SELECT value, previous_close,
    round(((value - previous_close) / NULLIF(previous_close,0)) * 100, 2) AS pct
  INTO v_ihsg
  FROM public.market_index WHERE ticker = '^JKSE' LIMIT 1;

  SELECT string_agg(s.ticker || ' +' || round(((q.price - q.previous_close)/NULLIF(q.previous_close,0))*100,1) || '%', ', ')
  INTO v_gainers
  FROM (
    SELECT stock_id, price, previous_close FROM public.quotes
    WHERE previous_close > 0
    ORDER BY ((price - previous_close)/NULLIF(previous_close,0)) DESC LIMIT 3
  ) q JOIN public.stocks s ON s.id = q.stock_id;

  SELECT string_agg(s.ticker || ' ' || round(((q.price - q.previous_close)/NULLIF(q.previous_close,0))*100,1) || '%', ', ')
  INTO v_losers
  FROM (
    SELECT stock_id, price, previous_close FROM public.quotes
    WHERE previous_close > 0
    ORDER BY ((price - previous_close)/NULLIF(previous_close,0)) ASC LIMIT 3
  ) q JOIN public.stocks s ON s.id = q.stock_id;

  v_body := 'IHSG ' || COALESCE(v_ihsg.value::text, '-') ||
    ' (' || COALESCE(v_ihsg.pct::text, '0') || '%). Top gainers: ' || COALESCE(v_gainers, '-') ||
    '. Top losers: ' || COALESCE(v_losers, '-') || '.';

  INSERT INTO public.notifications (user_id, category, title, body, event_id)
  SELECT np.user_id, 'MORNING_BRIEFING', 'Ringkasan Pagi IHSG', v_body, v_event_id || ':' || np.user_id
  FROM public.notification_preferences np
  WHERE np.master_enabled = true AND np.morning_briefing = true
  ON CONFLICT (event_id) DO NOTHING;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_morning_briefing()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_run_id uuid;
BEGIN
  v_run_id := public.job_run_start('morning-briefing');
  BEGIN
    PERFORM public.dispatch_morning_briefing();
    PERFORM public.job_run_finish(v_run_id, 'SUCCESS');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('error', SQLERRM));
  END;
END;
$function$;

SELECT cron.schedule(
  'morning-briefing-daily',
  '0 0 * * 1-5',
  $$SELECT public.trigger_morning_briefing();$$
);
