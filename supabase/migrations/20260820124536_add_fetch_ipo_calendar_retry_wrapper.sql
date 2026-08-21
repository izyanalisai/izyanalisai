CREATE OR REPLACE FUNCTION public.trigger_fetch_ipo_calendar_retry()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_last_status text;
BEGIN
  SELECT status INTO v_last_status
  FROM public.job_runs
  WHERE job_name = 'fetch-ipo-calendar'
    AND started_at > (now() AT TIME ZONE 'Asia/Jakarta')::date
  ORDER BY started_at DESC
  LIMIT 1;

  IF v_last_status IS DISTINCT FROM 'ERROR' THEN
    RETURN;
  END IF;

  PERFORM public.trigger_fetch_ipo_calendar();
END;
$function$;

SELECT cron.schedule('fetch-ipo-calendar-retry-1', '10 0 * * 1-5', $$select public.trigger_fetch_ipo_calendar_retry();$$);
SELECT cron.schedule('fetch-ipo-calendar-retry-2', '10 1 * * 1-5', $$select public.trigger_fetch_ipo_calendar_retry();$$);
