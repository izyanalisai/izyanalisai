CREATE OR REPLACE FUNCTION public.get_next_signal_expiry(
  from_ts timestamptz DEFAULT NOW(),
  tier text DEFAULT 'daily'
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_wib_now      date;
  v_next_date    date;
  v_session_close time;
  v_expiry       timestamptz;
  v_days_to_skip int;
BEGIN
  v_wib_now := (from_ts AT TIME ZONE 'Asia/Jakarta')::date;
  v_days_to_skip := CASE WHEN tier = 'swing' THEN 1 ELSE 0 END;

  SELECT date, session_close
  INTO v_next_date, v_session_close
  FROM market_calendar
  WHERE date > v_wib_now
    AND is_trading_day = true
  ORDER BY date
  LIMIT 1
  OFFSET v_days_to_skip;

  IF v_next_date IS NULL THEN
    v_next_date    := v_wib_now + 1;
    v_session_close := '15:50:00'::time;
  END IF;

  IF v_session_close IS NULL THEN
    v_session_close := '15:50:00'::time;
  END IF;

  v_expiry := (v_next_date || ' ' || v_session_close)::timestamp AT TIME ZONE 'Asia/Jakarta';

  RETURN v_expiry;
END;
$$;

COMMENT ON FUNCTION public.get_next_signal_expiry IS
  'Hitung expires_at signal berdasarkan market_calendar, selalu next trading day session_close.';

CREATE OR REPLACE FUNCTION public.fix_signal_expiry_on_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_correct_expiry timestamptz;
BEGIN
  IF NEW.expires_at IS NULL OR NEW.expires_at < NOW() + INTERVAL '12 hours' THEN
    v_correct_expiry := get_next_signal_expiry(NOW(), COALESCE(NEW.timeframe, 'daily'));
    NEW.expires_at := v_correct_expiry;
    RAISE LOG 'fix_signal_expiry_on_insert: override expires_at untuk signal % dari % ke %',
      NEW.id, OLD.expires_at, v_correct_expiry;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fix_signal_expiry ON public.signals;
CREATE TRIGGER trg_fix_signal_expiry
  BEFORE INSERT ON public.signals
  FOR EACH ROW
  EXECUTE FUNCTION public.fix_signal_expiry_on_insert();

COMMENT ON TRIGGER trg_fix_signal_expiry ON public.signals IS
  'Safety net: override expires_at kalau di-set terlalu pendek (< 12 jam dari sekarang).';
