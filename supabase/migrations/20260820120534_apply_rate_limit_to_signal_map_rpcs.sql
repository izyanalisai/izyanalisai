CREATE OR REPLACE FUNCTION public.get_full_signal_map(p_tier text DEFAULT 'daily'::text)
 RETURNS TABLE(stock_id uuid, direction text, signal_tier text, state text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.check_rate_limit('get_full_signal_map', coalesce(auth.uid()::text, 'anon-global'), 60, 60) THEN
    RAISE EXCEPTION 'RATE_LIMITED: terlalu banyak request, coba lagi sebentar' USING ERRCODE = '42901';
  END IF;

  RETURN QUERY
  SELECT * FROM (
    SELECT DISTINCT ON (s.stock_id)
      s.stock_id,
      s.direction::text,
      s.signal_tier::text,
      s.direction::text as state
    FROM public.signals s
    WHERE s.status IN ('ACTIVE', 'HIT_TP1')
      AND s.superseded_by IS NULL
      AND s.signal_tier = p_tier
    ORDER BY s.stock_id, s.created_at DESC
  ) active_signals

  UNION ALL

  SELECT
    sws.stock_id,
    'NETRAL'::text as direction,
    sws.signal_tier::text,
    'NETRAL'::text as state
  FROM public.signal_watch_states sws
  WHERE sws.signal_tier = p_tier
    AND NOT EXISTS (
      SELECT 1 FROM public.signals s2
      WHERE s2.stock_id = sws.stock_id
        AND s2.status IN ('ACTIVE', 'HIT_TP1')
        AND s2.superseded_by IS NULL
        AND s2.signal_tier = p_tier
    );
END;
$function$;
