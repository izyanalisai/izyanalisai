CREATE OR REPLACE FUNCTION public.get_active_signal_map()
 RETURNS TABLE(stock_id uuid, direction text, signal_tier text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.check_rate_limit('get_active_signal_map', coalesce(auth.uid()::text, 'anon-global'), 60, 60) THEN
    RAISE EXCEPTION 'RATE_LIMITED: terlalu banyak request, coba lagi sebentar' USING ERRCODE = '42901';
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (s.stock_id)
    s.stock_id,
    s.direction,
    s.signal_tier
  FROM public.signals s
  WHERE s.status IN ('ACTIVE', 'HIT_TP1')
    AND s.superseded_by IS NULL
  ORDER BY s.stock_id, s.created_at DESC;
END;
$function$;
