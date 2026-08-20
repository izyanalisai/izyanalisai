-- =====================================================================
-- FIX 1 (KRITIS): sinyal dari formula yang GAGAL backtest gate
-- (gate_passed = false) tampil live ke user via list_active_signals,
-- get_signal_for_stock, get_signal_history. Semua formula (baseline_v1
-- s/d v6) belum lolos gate (lihat backtest_runs & signal_engine_versions).
-- Sekarang RPC ikut filter gate_passed = true.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.list_active_signals()
RETURNS TABLE(id uuid, direction text, created_at timestamptz, stock_id uuid, ticker text, name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT s.id, s.direction, s.created_at, st.id AS stock_id, st.ticker, st.name
  FROM public.signals s
  JOIN public.stocks st ON st.id = s.stock_id
  WHERE s.status IN ('ACTIVE', 'HIT_TP1')
    AND s.superseded_by IS NULL
    AND s.gate_passed = true
  ORDER BY s.created_at DESC;
$$;

CREATE OR REPLACE FUNCTION public.get_signal_for_stock(p_stock_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user       uuid := auth.uid();
  v_today      date := (now() at time zone 'Asia/Jakarta')::date;
  v_signal     public.signals;
  v_is_premium boolean := false;
  v_unlocked   boolean := false;
  v_result     jsonb;
BEGIN
  SELECT * INTO v_signal FROM public.signals
    WHERE stock_id = p_stock_id AND status = 'ACTIVE' AND superseded_by IS NULL
      AND gate_passed = true
    ORDER BY created_at DESC
    LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_user IS NOT NULL THEN
    SELECT COALESCE(is_premium, false) INTO v_is_premium FROM public.profiles WHERE id = v_user;
    v_unlocked := v_is_premium OR EXISTS (
      SELECT 1 FROM public.signal_unlocks
      WHERE user_id = v_user AND stock_id = p_stock_id AND unlock_date = v_today
    );
  END IF;

  v_result := jsonb_build_object(
    'id', v_signal.id,
    'direction', v_signal.direction,
    'status', v_signal.status,
    'created_at', v_signal.created_at,
    'unlocked', v_unlocked
  );

  IF v_unlocked THEN
    v_result := v_result || jsonb_build_object(
      'entry_price', v_signal.entry_price,
      'buy_area_low', v_signal.buy_area_low,
      'buy_area_high', v_signal.buy_area_high,
      'tp1', v_signal.tp1,
      'tp2', v_signal.tp2,
      'stop_loss', v_signal.stop_loss,
      'confidence_score', v_signal.confidence_score,
      'ai_reasoning', v_signal.ai_reasoning
    );
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_signal_history(p_status text DEFAULT NULL, p_days integer DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_is_premium boolean := false;
  v_result jsonb;
BEGIN
  IF v_user IS NOT NULL THEN
    SELECT COALESCE(is_premium, false) INTO v_is_premium FROM public.profiles WHERE id = v_user;
  END IF;

  SELECT jsonb_agg(row_to_json(t)) INTO v_result FROM (
    SELECT
      sg.id, st.ticker, st.name AS stock_name, sg.direction, sg.timeframe,
      sg.status, sg.created_at, sg.resolved_at, sr.result, sr.r_multiple,
      CASE WHEN v_is_premium OR (v_user IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.signal_unlocks su
        WHERE su.user_id = v_user AND su.stock_id = sg.stock_id
          AND su.unlock_date = (sg.created_at AT TIME ZONE 'Asia/Jakarta')::date
      )) THEN true ELSE false END AS unlocked,
      CASE WHEN v_is_premium OR (v_user IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.signal_unlocks su
        WHERE su.user_id = v_user AND su.stock_id = sg.stock_id
          AND su.unlock_date = (sg.created_at AT TIME ZONE 'Asia/Jakarta')::date
      )) THEN sg.entry_price ELSE NULL END AS entry_price,
      CASE WHEN v_is_premium OR (v_user IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.signal_unlocks su
        WHERE su.user_id = v_user AND su.stock_id = sg.stock_id
          AND su.unlock_date = (sg.created_at AT TIME ZONE 'Asia/Jakarta')::date
      )) THEN sg.tp1 ELSE NULL END AS tp1,
      CASE WHEN v_is_premium OR (v_user IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.signal_unlocks su
        WHERE su.user_id = v_user AND su.stock_id = sg.stock_id
          AND su.unlock_date = (sg.created_at AT TIME ZONE 'Asia/Jakarta')::date
      )) THEN sg.tp2 ELSE NULL END AS tp2,
      CASE WHEN v_is_premium OR (v_user IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.signal_unlocks su
        WHERE su.user_id = v_user AND su.stock_id = sg.stock_id
          AND su.unlock_date = (sg.created_at AT TIME ZONE 'Asia/Jakarta')::date
      )) THEN sg.stop_loss ELSE NULL END AS stop_loss
    FROM public.signals sg
    JOIN public.stocks st ON st.id = sg.stock_id
    LEFT JOIN public.signal_results sr ON sr.signal_id = sg.id
    WHERE sg.status IN ('HIT_TP1','HIT_TP2','HIT_SL','EXPIRED','INVALIDATED')
      AND sg.gate_passed = true
      AND (p_status IS NULL OR sg.status = p_status)
      AND (p_days IS NULL OR sg.created_at >= now() - (p_days || ' days')::interval)
    ORDER BY sg.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) t;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- =====================================================================
-- FIX 2: bersih-bersih fungsi/trigger duplikat.
-- =====================================================================

DROP TRIGGER IF EXISTS ai_task_limit_check ON public.ai_tasks;
DROP FUNCTION IF EXISTS public.enforce_ai_task_limit();

DROP FUNCTION IF EXISTS public.credit_ad_unlock(uuid);
