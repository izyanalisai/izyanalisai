-- Migration sinkronisasi dari live Supabase (25 Agustus 2026)
-- Menggabungkan 4 migration yang sudah jalan di live tapi belum ada di repo:
--   20260825032753_add_bandarmologi_proxy_v1
--   20260825032802_cleanup_unused_bandarmologi_loop_fn
--   20260825033023_schedule_bandarmologi_proxy_daily
--   20260825050826_historical_walkforward_backtest
-- Ditulis ulang sebagai representasi state akhir (idempotent), BUKAN replay history asli,
-- plus 2 fix keamanan (admin guard) yang sudah diterapkan langsung di live hari ini juga.

-- ============================================================
-- 1. Bandarmologi Proxy (OBV + MFI money-flow score)
-- ============================================================
ALTER TABLE public.indicators
  ADD COLUMN IF NOT EXISTS obv numeric,
  ADD COLUMN IF NOT EXISTS mfi14 numeric,
  ADD COLUMN IF NOT EXISTS bandarmologi_score numeric;

CREATE OR REPLACE FUNCTION public.refresh_bandarmologi_proxy_batch(p_timeframe text DEFAULT 'D1'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_updated int;
begin
  -- Guard: blokir anon/authenticated non-admin lewat API, tapi tetap izinkan cron
  -- (cron jalan direct SQL, tidak ada request.jwt.claims sama sekali).
  if current_setting('request.jwt.claims', true) is not null and not public.is_current_user_admin() then
    raise exception 'forbidden: admin only';
  end if;

  with typical as (
    select c.id, c.stock_id, c.ts, c.close, c.volume, (c.high + c.low + c.close) / 3 as tp
    from public.candles c where c.timeframe = p_timeframe
  ),
  flow as (
    select id, stock_id, ts, close, volume, tp, tp * coalesce(volume, 0) as raw_money_flow,
      lag(tp) over (partition by stock_id order by ts) as prev_tp,
      lag(close) over (partition by stock_id order by ts) as prev_close
    from typical
  ),
  mf_flagged as (
    select id, stock_id, ts, volume,
      case when prev_close is not null and close > prev_close then raw_money_flow else 0 end as pos_flow,
      case when prev_close is not null and close < prev_close then raw_money_flow else 0 end as neg_flow,
      case when prev_close is null then 0
           when close > prev_close then volume
           when close < prev_close then -volume
           else 0 end as obv_delta
    from flow
  ),
  obv_calc as (
    select id, stock_id, ts, sum(obv_delta) over (partition by stock_id order by ts rows unbounded preceding) as obv
    from mf_flagged
  ),
  mfi_calc as (
    select id, stock_id, ts,
      sum(pos_flow) over (partition by stock_id order by ts rows between 13 preceding and current row) as sum_pos_14,
      sum(neg_flow) over (partition by stock_id order by ts rows between 13 preceding and current row) as sum_neg_14
    from mf_flagged
  ),
  combined as (
    select o.id, o.stock_id, o.obv,
      case when coalesce(m.sum_neg_14, 0) = 0 then 100
           else round(100 - (100 / (1 + (m.sum_pos_14 / nullif(m.sum_neg_14, 0)))), 2)
      end as mfi14,
      o.obv - lag(o.obv, 5) over (partition by o.stock_id order by o.ts) as obv_5d_delta
    from obv_calc o join mfi_calc m on m.id = o.id
  ),
  scored as (
    select id, stock_id, obv, mfi14,
      case when obv_5d_delta is null then 0
           when obv_5d_delta > 0 then 15
           when obv_5d_delta < 0 then -15
           else 0 end as obv_trend_bonus
    from combined
  )
  update public.indicators i
  set obv = s.obv, mfi14 = s.mfi14,
      bandarmologi_score = greatest(0, least(100, coalesce(s.mfi14, 50) + s.obv_trend_bonus)),
      updated_at = now()
  from scored s join public.candles c on c.id = s.id
  where i.stock_id = s.stock_id and i.timeframe = p_timeframe and i.ts = c.ts;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$function$;

-- cleanup_unused_bandarmologi_loop_fn: fungsi loop percobaan awal (per-stock, digantikan versi batch/set-based
-- di atas yang jauh lebih efisien) sudah dihapus di live. Drop juga di sini biar konsisten kalau ada di repo lama.
DROP FUNCTION IF EXISTS public.refresh_bandarmologi_proxy_loop(text);

-- Jadwalkan cron harian (09:40 UTC = 16:40 WIB, setelah candle D1 closing kebentuk)
SELECT cron.unschedule('bandarmologi-proxy-daily') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'bandarmologi-proxy-daily'
);
SELECT cron.schedule(
  'bandarmologi-proxy-daily',
  '40 9 * * 1-5',
  $$select public.refresh_bandarmologi_proxy_batch('D1');$$
);

-- ============================================================
-- 2. Historical Walk-forward Backtest (terpisah dari live/forward gate structural_v2)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.backtest_walkforward_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  note text
);

CREATE TABLE IF NOT EXISTS public.backtest_walkforward_trades (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES public.backtest_walkforward_runs(id),
  formula_version text NOT NULL DEFAULT 'structural_v2',
  tier text NOT NULL,
  level_mode text NOT NULL,
  stock_id uuid REFERENCES public.stocks(id),
  direction text,
  outcome text,
  pnl_r numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.backtest_walkforward_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backtest_walkforward_trades ENABLE ROW LEVEL SECURITY;
-- Sengaja TIDAK ada policy: kedua tabel ini hanya boleh diakses lewat RPC SECURITY DEFINER
-- (aggregate_walkforward_backtest) yang jalan sebagai owner, jadi RLS-deny-all di jalur
-- REST API langsung (anon/authenticated) memang perilaku yang diinginkan, bukan bug.

CREATE OR REPLACE FUNCTION public.aggregate_walkforward_backtest(p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_mode record; v_results jsonb := '[]'::jsonb; v_overall_pass boolean := true; v_alpha numeric := 0.05;
begin
  -- Guard: blokir anon/authenticated non-admin lewat API. Cron/SQL langsung (tanpa JWT) tetap lolos.
  if current_setting('request.jwt.claims', true) is not null and not public.is_current_user_admin() then
    raise exception 'forbidden: admin only';
  end if;

  for v_mode in select level_mode, wr_threshold_pct, requires_positive_ev, min_profit_factor,
                       max_drawdown_r_limit, min_sample_size, min_expectancy_r, min_sharpe_ratio
               from public.backtest_gate_config
  loop
    declare
      v_total int; v_win int; v_loss int; v_gross_win numeric; v_gross_loss numeric;
      v_win_rate numeric; v_ev numeric; v_profit_factor numeric; v_p_value numeric; v_significant boolean;
      v_max_dd_r numeric; v_sharpe numeric; v_r_mean numeric; v_r_stddev numeric;
      v_gate_passed boolean := true; v_fail_reasons text[] := '{}'; v_run_id uuid;
    begin
      select count(*), count(*) filter (where pnl_r > 0), count(*) filter (where pnl_r <= 0),
        sum(pnl_r) filter (where pnl_r > 0), abs(sum(pnl_r) filter (where pnl_r <= 0)), avg(pnl_r), stddev_samp(pnl_r)
      into v_total, v_win, v_loss, v_gross_win, v_gross_loss, v_r_mean, v_r_stddev
      from public.backtest_walkforward_trades where batch_id = p_batch_id and level_mode = v_mode.level_mode;

      v_win_rate := case when v_total > 0 then round(100.0 * v_win / v_total, 2) else null end;
      v_ev := case when v_total > 0 then round((coalesce(v_gross_win,0) - coalesce(v_gross_loss,0)) / v_total, 4) else null end;
      v_profit_factor := case when coalesce(v_gross_loss,0) > 0 then round(v_gross_win / v_gross_loss, 2)
                               when coalesce(v_gross_win,0) > 0 then null else null end;
      v_p_value := public.binomial_sf(v_win, v_total, 0.5);
      v_significant := v_p_value is not null and v_p_value < v_alpha;
      v_sharpe := case when coalesce(v_r_stddev,0) > 0 then round(v_r_mean / v_r_stddev, 3) else null end;

      select coalesce(max(running_peak - running_equity), 0) into v_max_dd_r
      from (
        select running_equity, max(running_equity) over (order by id rows unbounded preceding) as running_peak
        from (
          select id, sum(pnl_r) over (order by id rows unbounded preceding) as running_equity
          from public.backtest_walkforward_trades
          where batch_id = p_batch_id and level_mode = v_mode.level_mode
        ) base
      ) peaked;

      if v_total < v_mode.min_sample_size then v_gate_passed := false;
        v_fail_reasons := array_append(v_fail_reasons, format('INSUFFICIENT_SAMPLE: %s trade, minimal %s', v_total, v_mode.min_sample_size)); end if;
      if v_win_rate is null or v_win_rate < v_mode.wr_threshold_pct then v_gate_passed := false;
        v_fail_reasons := array_append(v_fail_reasons, format('WIN_RATE_BELOW_THRESHOLD: %s%% < %s%%', coalesce(v_win_rate::text,'null'), v_mode.wr_threshold_pct)); end if;
      if v_mode.requires_positive_ev and (v_ev is null or v_ev < v_mode.min_expectancy_r) then v_gate_passed := false;
        v_fail_reasons := array_append(v_fail_reasons, format('EXPECTANCY_BELOW_THRESHOLD: %sR < %sR', coalesce(v_ev::text,'null'), v_mode.min_expectancy_r)); end if;
      if v_profit_factor is null or v_profit_factor < v_mode.min_profit_factor then v_gate_passed := false;
        v_fail_reasons := array_append(v_fail_reasons, format('PROFIT_FACTOR_BELOW_THRESHOLD: %s < %s', coalesce(v_profit_factor::text,'null'), v_mode.min_profit_factor)); end if;
      if v_max_dd_r > v_mode.max_drawdown_r_limit then v_gate_passed := false;
        v_fail_reasons := array_append(v_fail_reasons, format('MAX_DRAWDOWN_EXCEEDED: %sR > %sR', v_max_dd_r, v_mode.max_drawdown_r_limit)); end if;
      if not v_significant then v_gate_passed := false;
        v_fail_reasons := array_append(v_fail_reasons, format('NOT_STATISTICALLY_SIGNIFICANT: p_value=%s >= alpha=%s', coalesce(v_p_value::text,'null'), v_alpha)); end if;
      if v_total >= v_mode.min_sample_size and (v_sharpe is null or v_sharpe < v_mode.min_sharpe_ratio) then v_gate_passed := false;
        v_fail_reasons := array_append(v_fail_reasons, format('SHARPE_BELOW_THRESHOLD: %s < %s', coalesce(v_sharpe::text,'null'), v_mode.min_sharpe_ratio)); end if;
      if not v_gate_passed then v_overall_pass := false; end if;

      insert into public.backtest_runs (
        formula_version, timeframe, level_mode, universe, period_start, period_end,
        total_trades, win_trades, loss_trades, win_rate, expected_value, profit_factor, max_drawdown,
        gate_wr_threshold, gate_requires_positive_ev, gate_passed, fail_reasons,
        p_value, is_statistically_significant, ara_arb_unfilled_count,
        sharpe_ratio, fold_consistency_cv, fold_count, min_sample_required,
        assumptions, data_snapshot_note, run_by
      ) values (
        'structural_v2_walkforward_historical', 'D1', v_mode.level_mode,
        'IDX seluruh stock aktif dengan candle historis -- walk-forward no-look-ahead',
        (select min(created_at)::date from public.backtest_walkforward_trades where batch_id = p_batch_id),
        (select max(created_at)::date from public.backtest_walkforward_trades where batch_id = p_batch_id),
        v_total, v_win, v_loss, v_win_rate, v_ev, v_profit_factor, v_max_dd_r,
        v_mode.wr_threshold_pct, v_mode.requires_positive_ev, v_gate_passed, v_fail_reasons,
        v_p_value, v_significant, 0, v_sharpe, null, null, v_mode.min_sample_size,
        jsonb_build_object(
          'source', 'backtest-simulate-structural-v2 edge function, walk-forward bar-by-bar terhadap candles historis (bukan live signal_results)',
          'batch_id', p_batch_id,
          'no_look_ahead', 'EMA/pivot/zone dihitung ulang tiap bar dari window bergulir, tidak pakai data masa depan',
          'statistical_test', format('binomial one-tailed, H0: WR<=50%%, alpha=%s', v_alpha),
          'note', 'Dipisah tegas dari formula_version=structural_v2 (live/forward) sesuai prinsip auditability blueprint -- JANGAN dipakai gate produksi otomatis sebelum direview manual'
        ),
        'Walk-forward historical backtest batch ' || p_batch_id::text || ' per ' || now()::text,
        auth.uid()
      ) returning id into v_run_id;

      v_results := v_results || jsonb_build_object(
        'level_mode', v_mode.level_mode, 'backtest_run_id', v_run_id,
        'total_trades', v_total, 'win', v_win, 'loss', v_loss,
        'win_rate_pct', v_win_rate, 'expected_value_r', v_ev, 'profit_factor', v_profit_factor,
        'max_drawdown_r', v_max_dd_r, 'sharpe_ratio', v_sharpe,
        'p_value', v_p_value, 'is_statistically_significant', v_significant,
        'gate_passed', v_gate_passed, 'fail_reasons', v_fail_reasons
      );
    end;
  end loop;
  return jsonb_build_object('batch_id', p_batch_id, 'overall_gate_passed', v_overall_pass, 'per_level_mode', v_results);
end;
$function$;
