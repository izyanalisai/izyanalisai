CREATE OR REPLACE FUNCTION public.get_stock_status_map()
RETURNS TABLE(stock_id uuid, signal_tier text, status text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH active_signal AS (
    SELECT DISTINCT ON (s.stock_id, s.signal_tier)
      s.stock_id,
      s.signal_tier,
      s.direction AS status
    FROM public.signals s
    WHERE s.status IN ('ACTIVE', 'HIT_TP1')
      AND s.superseded_by IS NULL
    ORDER BY s.stock_id, s.signal_tier, s.created_at DESC
  ),
  netral AS (
    SELECT
      w.stock_id,
      w.signal_tier,
      'NETRAL'::text AS status
    FROM public.signal_watch_states w
    WHERE NOT EXISTS (
      SELECT 1 FROM active_signal a
      WHERE a.stock_id = w.stock_id AND a.signal_tier = w.signal_tier
    )
  )
  SELECT * FROM active_signal
  UNION ALL
  SELECT * FROM netral;
$function$;

GRANT EXECUTE ON FUNCTION public.get_stock_status_map() TO anon, authenticated;
