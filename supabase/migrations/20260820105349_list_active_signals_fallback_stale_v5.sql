DROP FUNCTION IF EXISTS public.list_active_signals(text);

CREATE OR REPLACE FUNCTION public.list_active_signals(p_tier text DEFAULT NULL::text)
RETURNS TABLE(
  id uuid, direction text, status text, signal_tier text, created_at timestamp with time zone,
  stock_id uuid, ticker text, name text,
  entry_price numeric, buy_area_low numeric, buy_area_high numeric,
  support_level numeric, resistance_level numeric,
  bearish_type text, bearish_trigger numeric, invalidation numeric,
  downside_support_1 numeric, downside_support_2 numeric,
  tp1 numeric, tp2 numeric, stop_loss numeric,
  current_price numeric, unlocked boolean, is_stale boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
  v_is_premium boolean := false;
  v_active_count int;
BEGIN
  IF v_user IS NOT NULL THEN
    SELECT COALESCE(p.is_premium, false) INTO v_is_premium
    FROM public.profiles p WHERE p.id = v_user;
  END IF;

  SELECT count(*) INTO v_active_count
  FROM public.signals s
  WHERE s.status IN ('ACTIVE', 'HIT_TP1')
    AND s.superseded_by IS NULL
    AND (p_tier IS NULL OR s.signal_tier = p_tier);

  RETURN QUERY
  SELECT
    s.id, s.direction, s.status, s.signal_tier, s.created_at,
    st.id AS stock_id, st.ticker, st.name,
    s.entry_price, s.buy_area_low, s.buy_area_high,
    s.support_level, s.resistance_level,
    s.bearish_type, s.bearish_trigger, s.invalidation,
    s.downside_support_1, s.downside_support_2,
    CASE WHEN (v_is_premium OR EXISTS (
      SELECT 1 FROM public.signal_unlocks su
      WHERE su.user_id = v_user AND su.stock_id = st.id AND su.unlock_date = v_today
    )) THEN s.tp1 ELSE NULL END,
    CASE WHEN (v_is_premium OR EXISTS (
      SELECT 1 FROM public.signal_unlocks su
      WHERE su.user_id = v_user AND su.stock_id = st.id AND su.unlock_date = v_today
    )) THEN s.tp2 ELSE NULL END,
    CASE WHEN (v_is_premium OR EXISTS (
      SELECT 1 FROM public.signal_unlocks su
      WHERE su.user_id = v_user AND su.stock_id = st.id AND su.unlock_date = v_today
    )) THEN s.stop_loss ELSE NULL END,
    q.price AS current_price,
    (v_is_premium OR EXISTS (
      SELECT 1 FROM public.signal_unlocks su
      WHERE su.user_id = v_user AND su.stock_id = st.id AND su.unlock_date = v_today
    )) AS unlocked,
    (v_active_count = 0) AS is_stale
  FROM public.signals s
  JOIN public.stocks st ON st.id = s.stock_id
  LEFT JOIN public.quotes q ON q.stock_id = st.id
  WHERE s.superseded_by IS NULL
    AND (p_tier IS NULL OR s.signal_tier = p_tier)
    AND (
      (v_active_count > 0 AND s.status IN ('ACTIVE', 'HIT_TP1'))
      OR (v_active_count = 0)
    )
  ORDER BY s.created_at DESC
  LIMIT CASE WHEN v_active_count = 0 THEN 15 ELSE 200 END;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.list_active_signals(text) TO anon, authenticated;
