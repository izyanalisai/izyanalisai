set local check_function_bodies = off;

revoke all on function "public"."notify_push_on_new_notification"() from "authenticated";

revoke all on function "public"."unlock_signal_with_ad"(uuid) from "authenticated";

revoke all on table "public"."signals" from "anon";

revoke all on table "public"."signals" from "authenticated";

alter table "public"."signal_results"
  drop constraint "signal_results_result_check";

drop function "public"."get_stock_status_map"();

alter table "public"."backtest_runs"
  drop column "total_trades_resolved";

alter table "public"."backtest_runs"
  drop column "unfilled_count";

alter table "public"."signals"
  drop column "superseded_unresolved";

create extension "pg_net" schema "extensions";

alter table "public"."backtest_runs"
  add column "is_statistically_significant" boolean;

alter table "public"."backtest_runs"
  add column "ara_arb_unfilled_count" integer not null default 0;

alter table "public"."backtest_runs"
  alter column "p_value" drop default;

alter table "public"."backtest_runs"
  alter column "p_value" type numeric using "p_value"::numeric;

create or replace function public.admin_dashboard_summary()
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
DECLARE
  v_total_users int;
  v_premium_users int;
  v_signals_today int;
  v_active_signals int;
  v_total_news int;
  v_open_bug_reports int;
  v_open_feature_requests int;
  v_pending_payments int;
  v_failed_jobs_24h int;
  v_app_rating_avg numeric;
  v_app_rating_count int;
  v_queue_depth int;
  v_cron_errors_today int;
BEGIN
  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT COUNT(*) INTO v_total_users FROM profiles;
  SELECT COUNT(*) INTO v_premium_users FROM profiles WHERE is_premium = true;
  SELECT COUNT(*) INTO v_signals_today FROM signals
    WHERE triggered_at >= (now() AT TIME ZONE 'Asia/Jakarta')::date;
  SELECT COUNT(*) INTO v_active_signals FROM signals WHERE status = 'ACTIVE';
  SELECT COUNT(*) INTO v_total_news FROM news;

  SELECT COUNT(*) INTO v_open_bug_reports FROM bug_reports WHERE status NOT IN ('RESOLVED','WONT_FIX');
  SELECT COUNT(*) INTO v_open_feature_requests FROM feature_requests WHERE status NOT IN ('SHIPPED','DECLINED');
  SELECT COUNT(*) INTO v_pending_payments FROM payments WHERE status = 'pending';
  SELECT COUNT(*) INTO v_failed_jobs_24h FROM job_runs
    WHERE status = 'ERROR' AND started_at > now() - interval '24 hours';
  SELECT round(avg(rating)::numeric, 2), count(*) INTO v_app_rating_avg, v_app_rating_count
    FROM app_ratings;

  SELECT COUNT(*) INTO v_queue_depth FROM mtf_pipeline_runs WHERE status = 'RUNNING';

  SELECT COUNT(*) INTO v_cron_errors_today FROM job_runs
    WHERE status = 'ERROR' AND started_at >= (now() AT TIME ZONE 'Asia/Jakarta')::date;

  RETURN jsonb_build_object(
    'total_users', v_total_users,
    'premium_users', v_premium_users,
    'signals_today', v_signals_today,
    'active_signals', v_active_signals,
    'total_news', v_total_news,
    'open_bug_reports', v_open_bug_reports,
    'open_feature_requests', v_open_feature_requests,
    'pending_payments', v_pending_payments,
    'failed_jobs_24h', v_failed_jobs_24h,
    'app_rating_avg', v_app_rating_avg,
    'app_rating_count', v_app_rating_count,
    'queue_depth', v_queue_depth,
    'cron_errors_today', v_cron_errors_today
  );
END;
$function$;

create or replace function public.binomial_sf (
  k integer,
  n integer,
  p numeric default 0.5
)
  returns numeric
  language plpgsql
  immutable
  AS $function$
DECLARE
  i integer;
  log_p numeric := ln(p);
  log_q numeric := ln(1 - p);
  total numeric := 0;
  log_term numeric;
BEGIN
  IF n IS NULL OR n <= 0 OR k IS NULL THEN RETURN NULL; END IF;
  IF k <= 0 THEN RETURN 1; END IF;
  IF k > n THEN RETURN 0; END IF;
  FOR i IN k..n LOOP
    log_term := public.log_binomial_coeff(n, i) + i * log_p + (n - i) * log_q;
    total := total + exp(log_term);
  END LOOP;
  IF total > 1 THEN total := 1; END IF;
  IF total < 0 THEN total := 0; END IF;
  RETURN round(total, 6);
END;
$function$;

create or replace function public.cancel_subscription()
  returns jsonb
  language plpgsql
  security definer
  set search_path to ''
  AS $function$
declare
  v_uid uuid := auth.uid();
  v_row public.subscriptions;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_row
  from public.subscriptions
  where user_id = v_uid and status = 'active'
  order by created_at desc
  limit 1;

  if v_row.id is null then
    -- Sudah tidak ada subscription aktif (mungkin sudah dibatalkan
    -- sebelumnya, atau memang tidak pernah premium). Bukan error --
    -- idempotent, biar retry dari frontend aman.
    return jsonb_build_object('success', true, 'already_cancelled', true);
  end if;

  update public.subscriptions
  set cancel_at_period_end = true, status = 'pending_cancel'
  where id = v_row.id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, detail)
  values (v_uid, 'SUBSCRIPTION_CANCEL_REQUESTED', 'subscriptions', v_row.id, jsonb_build_object('plan', v_row.plan));

  return jsonb_build_object('success', true, 'already_cancelled', false, 'period_end', v_row.period_end);
end;
$function$;

create or replace function public.get_active_signal_map()
  returns table (
    stock_id    uuid,
    direction   text,
    signal_tier text
  )
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
BEGIN
  IF NOT public.check_rate_limit('get_active_signal_map', public.rate_limit_identity(), 60, 60) THEN
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

create or replace function public.get_full_signal_map (
  p_tier text default 'daily'::text
)
  returns table (
    stock_id    uuid,
    direction   text,
    signal_tier text,
    state       text
  )
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
BEGIN
  IF NOT public.check_rate_limit('get_full_signal_map', public.rate_limit_identity(), 60, 60) THEN
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

create or replace function public.get_signal_for_stock (
  p_stock_id uuid,
  p_tier     text default 'daily'::text
)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
DECLARE
  v_user       uuid := auth.uid();
  v_today      date := (now() at time zone 'Asia/Jakarta')::date;
  v_signal     public.signals;
  v_is_premium boolean := false;
  v_unlocked   boolean := false;
  v_result     jsonb;
BEGIN
  IF NOT public.check_rate_limit('get_signal_for_stock', public.rate_limit_identity(), 120, 60) THEN
    RAISE EXCEPTION 'RATE_LIMITED: terlalu banyak request, coba lagi sebentar' USING ERRCODE = '42901';
  END IF;

  SELECT * INTO v_signal FROM public.signals
    WHERE stock_id = p_stock_id AND status IN ('ACTIVE', 'HIT_TP1') AND superseded_by IS NULL
      AND signal_tier = p_tier
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
    'signal_tier', v_signal.signal_tier,
    'created_at', v_signal.created_at,
    'entry_price', v_signal.entry_price,
    'entry_type', v_signal.entry_type,
    'unlocked', v_unlocked,
    'evidence', v_signal.evidence
  );

  IF v_signal.direction = 'BUY' THEN
    v_result := v_result || jsonb_build_object(
      'buy_area_low', v_signal.buy_area_low,
      'buy_area_high', v_signal.buy_area_high,
      'support_level', v_signal.support_level,
      'resistance_level', v_signal.resistance_level
    );
    IF v_unlocked THEN
      v_result := v_result || jsonb_build_object(
        'tp1', v_signal.tp1,
        'tp2', v_signal.tp2,
        'stop_loss', v_signal.stop_loss,
        'ai_reasoning', v_signal.ai_reasoning
      );
    END IF;
  ELSIF v_signal.direction = 'SELL' THEN
    v_result := v_result || jsonb_build_object(
      'bearish_type', v_signal.bearish_type,
      'bearish_trigger', v_signal.bearish_trigger,
      'invalidation', v_signal.invalidation,
      'downside_support_1', v_signal.downside_support_1,
      'downside_support_2', v_signal.downside_support_2
    );
    IF v_unlocked THEN
      v_result := v_result || jsonb_build_object(
        'ai_reasoning', v_signal.ai_reasoning
      );
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

create or replace function public.get_signal_history (
  p_status text    default null::text,
  p_tier   text    default null::text,
  p_days   integer default null::integer,
  p_limit  integer default 50,
  p_offset integer default 0
)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_user uuid := auth.uid();
  v_is_premium boolean := false;
  v_result jsonb;
begin
  if not public.check_rate_limit('get_signal_history', public.rate_limit_identity(), 60, 60) then
    raise exception 'RATE_LIMITED: terlalu banyak request, coba lagi sebentar' using errcode = '42901';
  end if;

  if v_user is not null then
    select coalesce(is_premium, false) into v_is_premium from public.profiles where id = v_user;
  end if;

  select jsonb_agg(row_to_json(t)) into v_result from (
    select
      sg.id, st.ticker, st.name as stock_name, sg.direction, sg.timeframe, sg.signal_tier,
      sg.status, sg.created_at, sg.resolved_at, sr.result, sr.r_multiple,
      case when v_is_premium or (v_user is not null and exists (
        select 1 from public.signal_unlocks su
        where su.user_id = v_user and su.stock_id = sg.stock_id
          and su.unlock_date between (sg.created_at at time zone 'Asia/Jakarta')::date
                                  and coalesce((sg.resolved_at at time zone 'Asia/Jakarta')::date, (now() at time zone 'Asia/Jakarta')::date)
      )) then true else false end as unlocked,
      sg.entry_price,
      sg.buy_area_low,
      sg.buy_area_high,
      sg.downside_support_1,
      case when v_is_premium or (v_user is not null and exists (
        select 1 from public.signal_unlocks su
        where su.user_id = v_user and su.stock_id = sg.stock_id
          and su.unlock_date between (sg.created_at at time zone 'Asia/Jakarta')::date
                                  and coalesce((sg.resolved_at at time zone 'Asia/Jakarta')::date, (now() at time zone 'Asia/Jakarta')::date)
      )) then sg.tp1 else null end as tp1,
      case when v_is_premium or (v_user is not null and exists (
        select 1 from public.signal_unlocks su
        where su.user_id = v_user and su.stock_id = sg.stock_id
          and su.unlock_date between (sg.created_at at time zone 'Asia/Jakarta')::date
                                  and coalesce((sg.resolved_at at time zone 'Asia/Jakarta')::date, (now() at time zone 'Asia/Jakarta')::date)
      )) then sg.tp2 else null end as tp2,
      case when v_is_premium or (v_user is not null and exists (
        select 1 from public.signal_unlocks su
        where su.user_id = v_user and su.stock_id = sg.stock_id
          and su.unlock_date between (sg.created_at at time zone 'Asia/Jakarta')::date
                                  and coalesce((sg.resolved_at at time zone 'Asia/Jakarta')::date, (now() at time zone 'Asia/Jakarta')::date)
      )) then sg.stop_loss else null end as stop_loss,
      case when v_is_premium or (v_user is not null and exists (
        select 1 from public.signal_unlocks su
        where su.user_id = v_user and su.stock_id = sg.stock_id
          and su.unlock_date between (sg.created_at at time zone 'Asia/Jakarta')::date
                                  and coalesce((sg.resolved_at at time zone 'Asia/Jakarta')::date, (now() at time zone 'Asia/Jakarta')::date)
      )) then sg.bearish_trigger else null end as bearish_trigger,
      case when v_is_premium or (v_user is not null and exists (
        select 1 from public.signal_unlocks su
        where su.user_id = v_user and su.stock_id = sg.stock_id
          and su.unlock_date between (sg.created_at at time zone 'Asia/Jakarta')::date
                                  and coalesce((sg.resolved_at at time zone 'Asia/Jakarta')::date, (now() at time zone 'Asia/Jakarta')::date)
      )) then sg.invalidation else null end as invalidation,
      case when v_is_premium or (v_user is not null and exists (
        select 1 from public.signal_unlocks su
        where su.user_id = v_user and su.stock_id = sg.stock_id
          and su.unlock_date between (sg.created_at at time zone 'Asia/Jakarta')::date
                                  and coalesce((sg.resolved_at at time zone 'Asia/Jakarta')::date, (now() at time zone 'Asia/Jakarta')::date)
      )) then sg.downside_support_2 else null end as downside_support_2
    from public.signals sg
    join public.stocks st on st.id = sg.stock_id
    left join public.signal_results sr on sr.signal_id = sg.id
    where sg.status in ('HIT_TP1','HIT_TP2','HIT_SL','HIT_SL_LOCKED','EXPIRED','INVALIDATED')
      and (p_status is null or sg.status = p_status)
      and (p_tier is null or sg.signal_tier = p_tier)
      and (p_days is null or sg.created_at >= now() - (p_days || ' days')::interval)
    order by sg.created_at desc
    limit p_limit offset p_offset
  ) t;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

create or replace function public.get_stock_status_map()
  returns table (
    stock_id    uuid,
    signal_tier text,
    status      text
  )
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
BEGIN
  IF NOT public.check_rate_limit('get_stock_status_map', public.rate_limit_identity(), 120, 60) THEN
    RAISE EXCEPTION 'RATE_LIMITED: terlalu banyak request, coba lagi sebentar' USING ERRCODE = '42901';
  END IF;

  RETURN QUERY
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
END;
$function$;

create or replace function public.get_watch_state_for_stock (
  p_stock_id uuid,
  p_tier     text default 'daily'::text
)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
DECLARE
  v_watch public.signal_watch_states;
  v_indicator public.indicators;
  v_result jsonb;
BEGIN
  IF NOT public.check_rate_limit('get_watch_state_for_stock', public.rate_limit_identity(), 120, 60) THEN
    RAISE EXCEPTION 'RATE_LIMITED: terlalu banyak request, coba lagi sebentar' USING ERRCODE = '42901';
  END IF;

  SELECT * INTO v_watch
  FROM public.signal_watch_states
  WHERE stock_id = p_stock_id AND signal_tier = p_tier
  ORDER BY updated_at DESC
  LIMIT 1;

  SELECT * INTO v_indicator
  FROM public.indicators
  WHERE stock_id = p_stock_id AND timeframe = 'D1'
  ORDER BY ts DESC
  LIMIT 1;

  IF v_watch IS NULL THEN
    RETURN NULL;
  END IF;

  v_result := jsonb_build_object(
    'state', COALESCE(v_watch.state, 'NETRAL'),
    'reason', v_watch.reason,
    'support_level', v_watch.support_level,
    'resistance_level', v_watch.resistance_level,
    'watch_direction', v_watch.watch_direction,
    'watch_zone_low', v_watch.watch_zone_low,
    'watch_zone_high', v_watch.watch_zone_high,
    'bias', v_watch.bias,
    'last_close', v_watch.last_close,
    'formula_version', v_watch.formula_version,
    'data_source', v_watch.data_source,
    'updated_at', v_watch.updated_at,
    'rsi14', v_indicator.rsi14,
    'ema21', v_indicator.ema21,
    'ema50', v_indicator.ema50,
    'macd_line', v_indicator.macd_line,
    'macd_signal', v_indicator.macd_signal,
    'volume_avg20', v_indicator.volume_avg20
  );

  RETURN v_result;
END;
$function$;

create or replace function public.list_active_signals (
  p_tier text default null::text
)
  returns table (
    id                 uuid,
    direction          text,
    status             text,
    signal_tier        text,
    created_at         timestamp with time zone,
    stock_id           uuid,
    ticker             text,
    name               text,
    entry_price        numeric,
    buy_area_low       numeric,
    buy_area_high      numeric,
    support_level      numeric,
    resistance_level   numeric,
    bearish_type       text,
    bearish_trigger    numeric,
    invalidation       numeric,
    downside_support_1 numeric,
    downside_support_2 numeric,
    tp1                numeric,
    tp2                numeric,
    stop_loss          numeric,
    current_price      numeric,
    unlocked           boolean,
    is_stale           boolean
  )
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
  v_is_premium boolean := false;
  v_active_count int;
BEGIN
  IF NOT public.check_rate_limit('list_active_signals', public.rate_limit_identity(), 120, 60) THEN
    RAISE EXCEPTION 'RATE_LIMITED: terlalu banyak request, coba lagi sebentar' USING ERRCODE = '42901';
  END IF;

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

create or replace function public.log_binomial_coeff (
  n integer,
  k integer
)
  returns numeric
  language plpgsql
  immutable
  AS $function$
DECLARE
  kk integer := k;
  j integer;
  log_c numeric := 0;
BEGIN
  IF n IS NULL OR k IS NULL OR kk < 0 OR kk > n THEN RETURN NULL; END IF;
  IF kk = 0 OR kk = n THEN RETURN 0; END IF;
  IF kk > n - kk THEN kk := n - kk; END IF;
  FOR j IN 1..kk LOOP
    log_c := log_c + ln((n - kk + j)::numeric) - ln(j::numeric);
  END LOOP;
  RETURN log_c;
END;
$function$;

create or replace function public.rate_limit_identity()
  returns text
  language plpgsql
  stable
  set search_path to 'public'
  AS $function$
DECLARE
  v_uid text;
  v_ip text;
BEGIN
  v_uid := auth.uid()::text;
  IF v_uid IS NOT NULL THEN
    RETURN v_uid;
  END IF;

  BEGIN
    v_ip := split_part(
      coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''),
      ',', 1
    );
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;

  IF v_ip IS NOT NULL AND btrim(v_ip) <> '' THEN
    RETURN 'ip:' || btrim(v_ip);
  END IF;

  RETURN 'anon-global';
END;
$function$;

create or replace function public.record_signal_result()
  returns trigger
  language plpgsql
  security definer
  set search_path to ''
  AS $function$
DECLARE
  v_result text;
  v_exit numeric;
  v_r numeric;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  CASE NEW.status
    WHEN 'HIT_TP2' THEN v_result := 'WIN'; v_exit := NEW.tp2;
    WHEN 'HIT_SL' THEN v_result := 'LOSS'; v_exit := NEW.stop_loss;
    WHEN 'EXPIRED' THEN v_result := 'BREAKEVEN'; v_exit := NULL;
    WHEN 'INVALIDATED' THEN
      -- FIX 22 Agustus 2026: sinyal yang di-invalidate KARENA digantikan sinyal baru
      -- (superseded_by terisi) dipisah dari INVALID generik. Root cause churn (sinyal
      -- mati rata-rata 5.1 jam sebelum sempat resolve alami) belum diperbaiki di
      -- generate-signals-mtf -- ini baru langkah labeling supaya kelihatan jelas di data.
      IF NEW.superseded_by IS NOT NULL THEN
        v_result := 'SUPERSEDED_UNRESOLVED';
      ELSE
        v_result := 'INVALID';
      END IF;
      v_exit := NULL;
    ELSE RETURN NEW;
  END CASE;

  IF v_exit IS NOT NULL AND NEW.entry_price IS NOT NULL AND NEW.stop_loss IS NOT NULL
     AND NEW.entry_price <> NEW.stop_loss THEN
    IF NEW.direction = 'BUY' THEN
      v_r := round((v_exit - NEW.entry_price) / NULLIF(NEW.entry_price - NEW.stop_loss, 0), 2);
    ELSIF NEW.direction = 'SELL' THEN
      v_r := round((NEW.entry_price - v_exit) / NULLIF(NEW.stop_loss - NEW.entry_price, 0), 2);
    END IF;
  END IF;

  INSERT INTO public.signal_results (id, signal_id, result, r_multiple, holding_minutes, evaluated_at)
  VALUES (
    gen_random_uuid(), NEW.id, v_result, v_r,
    CASE WHEN NEW.resolved_at IS NOT NULL AND NEW.created_at IS NOT NULL
      THEN extract(epoch FROM (NEW.resolved_at - NEW.created_at))/60 ELSE NULL END,
    COALESCE(NEW.resolved_at, now())
  )
  ON CONFLICT (signal_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

create or replace function public.request_account_deletion (
  p_reason text default null::text
)
  returns void
  language plpgsql
  security definer
  set search_path to ''
  AS $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  perform set_config('app.trusted_profile_update', 'on', true);

  update public.profiles
  set deleted_at = now(), is_active = false
  where id = v_uid and deleted_at is null;

  update public.subscriptions
  set cancel_at_period_end = true, status = 'pending_cancel'
  where user_id = v_uid and status = 'active';

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, detail)
  values (v_uid, 'ACCOUNT_DELETE_REQUESTED', 'profiles', v_uid, jsonb_build_object('reason', p_reason));
end;
$function$;

create or replace function public.run_backtest (
  p_timeframe    text,
  p_period_start date default null::date,
  p_period_end   date default null::date
)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  v_period_start date;
  v_period_end date;
  v_min_sample int := 30;
  v_alpha numeric := 0.05;
  v_formula_version text;
  v_results jsonb := '[]'::jsonb;
  v_mode record;
  v_run_id uuid;
  v_overall_pass boolean := true;
begin
  if auth.uid() is not null and not public.is_current_user_admin() then
    raise exception 'forbidden: admin only';
  end if;

  select coalesce(p_period_start, min(sr.evaluated_at)::date) into v_period_start
    from public.signal_results sr;
  v_period_end := coalesce(p_period_end, (now() at time zone 'Asia/Jakarta')::date);

  select coalesce(max(s.formula_version), 'unknown') into v_formula_version
  from public.signals s join public.signal_results sr on sr.signal_id = s.id;

  for v_mode in select level_mode, wr_threshold_pct, requires_positive_ev from public.backtest_gate_config
  loop
    declare
      v_total int; v_win int; v_loss int; v_breakeven int; v_invalid int; v_ara_arb int; v_superseded int;
      v_avg_win_r numeric; v_avg_loss_r numeric; v_gross_win numeric; v_gross_loss numeric;
      v_win_rate numeric; v_ev numeric; v_profit_factor numeric; v_p_value numeric; v_significant boolean;
      v_gate_passed boolean := true; v_fail_reasons text[] := '{}';
    begin
      select
        count(*) filter (where sr.result in ('WIN','LOSS')),
        count(*) filter (where sr.result = 'WIN'),
        count(*) filter (where sr.result = 'LOSS'),
        count(*) filter (where sr.result = 'BREAKEVEN'),
        count(*) filter (where sr.result = 'INVALID'),
        count(*) filter (where sr.result = 'ARA_ARB_UNFILLED'),
        count(*) filter (where sr.result = 'SUPERSEDED_UNRESOLVED'),
        avg(sr.r_multiple) filter (where sr.result = 'WIN'),
        avg(sr.r_multiple) filter (where sr.result = 'LOSS'),
        sum(sr.r_multiple) filter (where sr.result = 'WIN'),
        abs(sum(sr.r_multiple) filter (where sr.result = 'LOSS'))
      into v_total, v_win, v_loss, v_breakeven, v_invalid, v_ara_arb, v_superseded, v_avg_win_r, v_avg_loss_r, v_gross_win, v_gross_loss
      from public.signal_results sr
      join public.signals s on s.id = sr.signal_id
      where sr.evaluated_at::date between v_period_start and v_period_end
        and (p_timeframe = 'ALL' or s.signal_tier = p_timeframe)
        and s.level_mode = v_mode.level_mode;

      v_win_rate := case when v_total > 0 then round(100.0 * v_win / v_total, 2) else null end;
      v_ev := case when v_total > 0 then round(
          (coalesce(v_avg_win_r,0) * v_win - coalesce(abs(v_avg_loss_r),1) * v_loss) / v_total
        , 4) else null end;
      v_profit_factor := case when coalesce(v_gross_loss,0) > 0 then round(v_gross_win / v_gross_loss, 2)
                               when coalesce(v_gross_win,0) > 0 then null
                               else null end;
      v_p_value := public.binomial_sf(v_win, v_total, 0.5);
      v_significant := v_p_value is not null and v_p_value < v_alpha;

      if v_total < v_min_sample then
        v_gate_passed := false;
        v_fail_reasons := array_append(v_fail_reasons,
          format('INSUFFICIENT_SAMPLE: hanya %s trade, minimal %s', v_total, v_min_sample));
      end if;
      if v_win_rate is null or v_win_rate < v_mode.wr_threshold_pct then
        v_gate_passed := false;
        v_fail_reasons := array_append(v_fail_reasons,
          format('WIN_RATE_BELOW_THRESHOLD: %s%% < %s%%', coalesce(v_win_rate::text,'null'), v_mode.wr_threshold_pct));
      end if;
      if v_mode.requires_positive_ev and (v_ev is null or v_ev <= 0) then
        v_gate_passed := false;
        v_fail_reasons := array_append(v_fail_reasons,
          format('NEGATIVE_OR_ZERO_EV: %s', coalesce(v_ev::text,'null')));
      end if;
      if not v_significant then
        v_gate_passed := false;
        v_fail_reasons := array_append(v_fail_reasons,
          format('NOT_STATISTICALLY_SIGNIFICANT: p_value=%s >= alpha=%s (H0: win rate <= 50%% belum bisa ditolak)',
            coalesce(v_p_value::text,'null'), v_alpha));
      end if;
      if v_superseded > v_total then
        v_fail_reasons := array_append(v_fail_reasons,
          format('WARNING_HIGH_CHURN: %s sinyal ke-supersede vs cuma %s yang resolve alami -- sample size gate ini kemungkinan under-estimate, lihat catatan churn generate-signals-mtf', v_superseded, v_total));
      end if;
      if not v_gate_passed then v_overall_pass := false; end if;

      insert into public.backtest_runs (
        formula_version, timeframe, level_mode, universe, period_start, period_end,
        total_trades, win_trades, loss_trades, win_rate, expected_value, profit_factor,
        gate_wr_threshold, gate_requires_positive_ev, gate_passed, fail_reasons,
        p_value, is_statistically_significant, ara_arb_unfilled_count,
        assumptions, data_snapshot_note, run_by
      ) values (
        v_formula_version, 'D1', v_mode.level_mode,
        'IDX seluruh stock master aktif -- segmen: ' || p_timeframe || ' / level_mode: ' || v_mode.level_mode,
        v_period_start, v_period_end,
        v_total, v_win, v_loss, v_win_rate, v_ev, v_profit_factor,
        v_mode.wr_threshold_pct, v_mode.requires_positive_ev, v_gate_passed, v_fail_reasons,
        v_p_value, v_significant, coalesce(v_ara_arb, 0),
        jsonb_build_object(
          'signal_tier_segment', p_timeframe,
          'level_mode_segment', v_mode.level_mode,
          'source', 'signal_results (real forward evaluation via evaluate-signals)',
          'breakeven_excluded_from_wr', v_breakeven,
          'invalidated_excluded_from_wr', v_invalid,
          'ara_arb_excluded_from_wr', coalesce(v_ara_arb, 0),
          'superseded_unresolved_excluded_from_wr', coalesce(v_superseded, 0),
          'loss_r_assumption', '1R penuh per HIT_SL',
          'no_look_ahead', 'signal dievaluasi worker evaluate-signals pakai EOD setelah signal dibuat',
          'level_mode_segmentation', 'AKTIF sejak 20 Agustus 2026 -- engine generate-signals-mtf v50 sudah mengisi level_mode',
          'transaction_cost', 'tidak dimasukkan (spec belum tentukan asumsi biaya transaksi)',
          'statistical_test', format('binomial one-tailed, H0: WR<=50%%, alpha=%s -- ditambahkan 22 Agustus 2026 (spec v6.1 section 3)', v_alpha),
          'known_issue', 'churn bug generate-signals-mtf belum diperbaiki (22 Agustus 2026) -- signal_tier daily rata-rata di-supersede 5.1 jam setelah dibuat, sample resolve alami jadi jauh lebih kecil dari total signal_results'
        ),
        'Auto-generated per level_mode dari signal_results real per ' || now()::text,
        auth.uid()
      ) returning id into v_run_id;

      v_results := v_results || jsonb_build_object(
        'level_mode', v_mode.level_mode,
        'backtest_run_id', v_run_id,
        'total_trades', v_total, 'win', v_win, 'loss', v_loss,
        'breakeven', v_breakeven, 'invalid', v_invalid, 'ara_arb_unfilled', coalesce(v_ara_arb, 0),
        'superseded_unresolved', coalesce(v_superseded, 0),
        'win_rate_pct', v_win_rate, 'expected_value_r', v_ev, 'profit_factor', v_profit_factor,
        'p_value', v_p_value, 'is_statistically_significant', v_significant,
        'gate_threshold_pct', v_mode.wr_threshold_pct, 'gate_passed', v_gate_passed,
        'fail_reasons', v_fail_reasons
      );
    end;
  end loop;

  return jsonb_build_object(
    'segment', p_timeframe,
    'period', jsonb_build_object('start', v_period_start, 'end', v_period_end),
    'overall_gate_passed', v_overall_pass,
    'per_level_mode', v_results
  );
end;
$function$;

create or replace function public.trigger_generate_signal_reasoning()
  returns void
  language plpgsql
  security definer
  set search_path to 'public', 'extensions'
  AS $function$
DECLARE
  v_url text; v_key text; v_secret text; v_run_id uuid; v_req_id bigint;
BEGIN
  v_run_id := public.job_run_start('generate-signal-reasoning');
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'worker_shared_secret';
  IF v_url IS NULL OR v_key IS NULL OR v_secret IS NULL THEN
    PERFORM public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('reason', 'vault/internal secrets belum diset'));
    RETURN;
  END IF;
  -- FIX (22 Agustus 2026, v88): model 'ivann' route ke grok-4.5-high (reasoning
  -- model berat, prompt 2 kata saja makan 645 completion_tokens). max_tokens
  -- dinaikkan ke 1200 di worker, timeout per-attempt naik ke 55s. limit
  -- diturunin 3->2 supaya 2x55s=110s tetap di bawah deadline function (130s)
  -- dan limit pg_net (150s).
  SELECT net.http_post(
    url := v_url || '/functions/v1/generate-signal-reasoning?limit=2',
    headers := jsonb_build_object('Authorization','Bearer ' || v_key,'Content-Type','application/json','x-worker-secret', v_secret),
    timeout_milliseconds := 150000
  ) INTO v_req_id;
  PERFORM public.job_run_finish(v_run_id, 'SUCCESS', jsonb_build_object('net_request_id', v_req_id, 'note', 'dispatched, menunggu reconcile'));
END;
$function$;

alter table "public"."signal_results"
  add constraint "signal_results_result_check"
    check ((result = ANY (ARRAY['WIN'::text, 'LOSS'::text, 'BREAKEVEN'::text, 'INVALID'::text, 'ARA_ARB_UNFILLED'::text, 'SUPERSEDED_UNRESOLVED'::text])));

comment on column "public"."backtest_runs"."ara_arb_unfilled_count" is 'Jumlah trade yang dikecualikan dari win rate/expectancy karena kena batas Auto Reject IDX (ARA/ARB) di T+1, dicatat terpisah dari INVALID biasa.';

comment on column "public"."backtest_runs"."is_statistically_significant" is 'true kalau p_value < 0.05 (alpha 5%)';

comment on column "public"."backtest_runs"."p_value" is 'One-tailed binomial test p-value: P(X >= wins | n = total_trades WIN+LOSS, p = 0.5). H0: true win rate <= 0.5.';

comment on constraint "signal_results_result_check" on "public"."signal_results" is 'SUPERSEDED_UNRESOLVED ditambahkan 22 Agustus 2026: sinyal yang di-invalidate karena digantikan sinyal baru (superseded_by terisi), dipisah dari INVALID generik supaya audit bisa bedain "gagal validasi" vs "kegantiin duluan sebelum sempat resolve". Root cause churn-nya masih belum diperbaiki -- ini baru langkah labeling, bukan fix ke generate-signals-mtf.';

comment on extension "pg_net" is 'Async HTTP';

comment on function "public"."binomial_sf"(integer, integer, numeric) is 'P(X >= k) untuk X ~ Binomial(n, p). Dipakai sebagai one-tailed p-value test H0: win rate <= 0.5 vs H1: win rate > 0.5.';

comment on function "public"."log_binomial_coeff"(integer, integer) is 'log(C(n,k)) dihitung via penjumlahan log, bukan factorial langsung, biar aman untuk n besar.';

comment on function "public"."rate_limit_identity"() is 'Identitas buat rate-limit: auth.uid() kalau login, else IP client dari header x-forwarded-for, else anon-global sbg fallback terakhir.';

grant execute on function "public"."binomial_sf"(integer, integer, numeric) to public, "authenticated", "postgres", "service_role";

revoke all on function "public"."cancel_subscription"() from public;

grant execute on function "public"."cancel_subscription"() to "authenticated", "postgres", "service_role";

grant execute on function "public"."get_stock_status_map"() to public, "anon", "authenticated", "postgres", "service_role";

grant execute on function "public"."log_binomial_coeff"(integer, integer) to public, "authenticated", "postgres", "service_role";

grant execute on function "public"."rate_limit_identity"() to public, "authenticated", "postgres", "service_role";

revoke all on table "public"."profiles" from "authenticated";

grant delete, insert, maintain, references, select, trigger, truncate on table "public"."profiles" to "authenticated";

select cron.schedule_in_database('ai-task-executor', '*/5 * * * *', 'SELECT public.trigger_ai_task_executor();', 'postgres', null, true);

select cron.schedule_in_database('economic-calendar-afternoon', '0 9 * * *', 'SELECT public.trigger_fetch_economic_calendar();', 'postgres', null, true);

select cron.schedule_in_database('economic-calendar-morning', '0 0 * * *', 'SELECT public.trigger_fetch_economic_calendar();', 'postgres', null, true);

select cron.schedule_in_database('evaluate-session2-preview', '10 5 * * 1-5', 'SELECT public.trigger_evaluate_session2_preview();', 'postgres', null, true);

select cron.schedule_in_database('evaluate-signals-market-close', '20 9 * * 1-5', 'SELECT public.trigger_evaluate_signals();', 'postgres', null, true);

select cron.schedule_in_database('evaluate-signals-session1', '5-59/5 2-4 * * 1-5', 'SELECT public.trigger_evaluate_signals();', 'postgres', null, true);

select cron.schedule_in_database('evaluate-signals-session2a', '35-59/5 6 * * 1-5', 'SELECT public.trigger_evaluate_signals();', 'postgres', null, true);

select cron.schedule_in_database('evaluate-signals-session2b', '0-55/5 7 * * 1-5', 'SELECT public.trigger_evaluate_signals();', 'postgres', null, true);

select cron.schedule_in_database('expire-active-subscriptions', '0 1 * * *', 'select public.expire_active_subscriptions();', 'postgres', null, true);

select cron.schedule_in_database('expire-grace-subscriptions', '0 1 * * *', 'select public.expire_grace_subscriptions();', 'postgres', null, true);

select cron.schedule_in_database('fetch-earnings-calendar-daily', '0 23 * * 0-4', 'select public.trigger_fetch_earnings_calendar();', 'postgres', null, true);

select cron.schedule_in_database('fetch-fundamentals-daily', '0 22 * * 0-4', 'select public.trigger_fetch_fundamentals();', 'postgres', null, true);

select cron.schedule_in_database('fetch-idx-eod-1900wib', '0 12 * * 1-5', 'SELECT public.trigger_fetch_idx_eod();', 'postgres', null, true);

select cron.schedule_in_database('fetch-idx-eod-1915wib', '15 12 * * 1-5', 'SELECT public.trigger_fetch_idx_eod();', 'postgres', null, true);

select cron.schedule_in_database('fetch-idx-eod-1930wib', '30 12 * * 1-5', 'SELECT public.trigger_fetch_idx_eod();', 'postgres', null, true);

select cron.schedule_in_database('fetch-idx-eod-1945wib', '45 12 * * 1-5', 'SELECT public.trigger_fetch_idx_eod();', 'postgres', null, true);

select cron.schedule_in_database('fetch-idx-eod-2000wib', '0 13 * * 1-5', 'SELECT public.trigger_fetch_idx_eod();', 'postgres', null, true);

select cron.schedule_in_database('fetch-idx-eod-2030wib', '30 13 * * 1-5', 'SELECT public.trigger_fetch_idx_eod();', 'postgres', null, true);

select cron.schedule_in_database('fetch-idx-eod-2100wib', '0 14 * * 1-5', 'SELECT public.trigger_fetch_idx_eod();', 'postgres', null, true);

select cron.schedule_in_database('fetch-idx-eod-2130wib', '30 14 * * 1-5', 'SELECT public.trigger_fetch_idx_eod();', 'postgres', null, true);

select cron.schedule_in_database('fetch-idx-eod-2200wib', '0 15 * * 1-5', 'SELECT public.trigger_fetch_idx_eod();', 'postgres', null, true);

select cron.schedule_in_database('fetch-idx-eod-2230wib', '30 15 * * 1-5', 'SELECT public.trigger_fetch_idx_eod();', 'postgres', null, true);

select cron.schedule_in_database('fetch-idx-eod-2300wib', '0 16 * * 1-5', 'SELECT public.trigger_fetch_idx_eod();', 'postgres', null, true);

select cron.schedule_in_database('fetch-index-close', '17 9 * * 1-5', 'SELECT public.trigger_fetch_index();', 'postgres', null, true);

select cron.schedule_in_database('fetch-index-open', '50 1 * * 1-5', 'SELECT public.trigger_fetch_index();', 'postgres', null, true);

select cron.schedule_in_database('fetch-index-sesi1', '5-59/5 2-4 * * 1-5', 'SELECT public.trigger_fetch_index();', 'postgres', null, true);

select cron.schedule_in_database('fetch-index-sesi2a', '35-59/5 6 * * 1-5', 'SELECT public.trigger_fetch_index();', 'postgres', null, true);

select cron.schedule_in_database('fetch-index-sesi2b', '0-55/5 7 * * 1-5', 'SELECT public.trigger_fetch_index();', 'postgres', null, true);

select cron.schedule_in_database('fetch-ipo-calendar-daily', '10 23 * * 0-4', 'SELECT public.trigger_fetch_ipo_calendar();', 'postgres', null, true);

select cron.schedule_in_database('fetch-news-global', '0 * * * *', 'select public.trigger_fetch_news(''global'');', 'postgres', null, true);

select cron.schedule_in_database('fetch-news-local', '*/5 * * * *', 'select public.trigger_fetch_news(''local'');', 'postgres', null, true);

select cron.schedule_in_database('fetch-quotes-close', '17 9 * * 1-5', 'SELECT public.trigger_fetch_quotes();', 'postgres', null, true);

select cron.schedule_in_database('fetch-quotes-open', '50 1 * * 1-5', 'SELECT public.trigger_fetch_quotes();', 'postgres', null, true);

select cron.schedule_in_database('fetch-quotes-sesi1', '5-59/5 2-4 * * 1-5', 'SELECT public.trigger_fetch_quotes();', 'postgres', null, true);

select cron.schedule_in_database('fetch-quotes-sesi2a', '35-59/5 6 * * 1-5', 'SELECT public.trigger_fetch_quotes();', 'postgres', null, true);

select cron.schedule_in_database('fetch-quotes-sesi2b', '0-55/5 7 * * 1-5', 'SELECT public.trigger_fetch_quotes();', 'postgres', null, true);

select cron.schedule_in_database('generate-signal-reasoning-catchup', '0 1 * * 1-5', 'SELECT public.trigger_generate_signal_reasoning();', 'postgres', null, true);

select cron.schedule_in_database('generate-signal-reasoning-evening', '*/10 12-14 * * 1-5', 'SELECT public.trigger_generate_signal_reasoning();', 'postgres', null, true);

select cron.schedule_in_database('generate-signal-reasoning-session', '*/10 2-8 * * 1-5', 'SELECT public.trigger_generate_signal_reasoning();', 'postgres', null, true);

select cron.schedule_in_database('generate-trending-reason-frequent', '*/15 * * * *', 'select public.trigger_generate_trending_reason();', 'postgres', null, true);

select cron.schedule_in_database('master-sync-corporate-actions', '0 22 * * *', 'select public.process_corporate_actions();', 'postgres', null, true);

select cron.schedule_in_database('master-sync-stock-daily', '0 22 * * *', 'SELECT public.trigger_master_sync_stock();', 'postgres', null, true);

select cron.schedule_in_database('morning-briefing-daily', '0 0 * * 1-5', 'SELECT public.trigger_morning_briefing();', 'postgres', null, true);

select cron.schedule_in_database('mtf-pipeline-poller', '* * * * *', 'select public.mtf_pipeline_poll();', 'postgres', null, true);

select cron.schedule_in_database('process-corporate-actions-daily', '0 22 * * 0-4', 'SELECT public.trigger_process_corporate_actions();', 'postgres', null, true);

select cron.schedule_in_database('reconcile-job-runs', '*/5 * * * *', 'SELECT public.reconcile_job_runs();', 'postgres', null, true);

select cron.schedule_in_database('sector-rotation-daily', '20 9 * * 1-5', 'select public.compute_sector_rotation();', 'postgres', null, true);

select
  cron.schedule_in_database('signal-pipeline-mtf-daily-watchdog', '*/15 12-15 * * 1-5', 'SELECT public.retry_signal_pipeline_mtf_if_needed(''daily'');', 'postgres', null, true);

select cron.schedule_in_database('signal-pipeline-mtf-daily', '0 12 * * 1-5', 'select public.trigger_signal_pipeline_mtf(''daily'');', 'postgres', null, true);

select
  cron.schedule_in_database('signal-pipeline-mtf-swing-watchdog', '*/15 12-15 * * 1-5', 'SELECT public.retry_signal_pipeline_mtf_if_needed(''swing'');', 'postgres', null, true);

select cron.schedule_in_database('signal-pipeline-mtf-swing', '10 12 * * 1-5', 'select public.trigger_signal_pipeline_mtf(''swing'');', 'postgres', null, true);

select cron.schedule_in_database('subscription-renewal-h1-notif', '5 0 * * *', 'select public.notify_subscription_renewal_h1();', 'postgres', null, true);

select cron.schedule_in_database('sync-corporate-action-detections', '*/15 * * * *', 'select public.trigger_sync_corporate_action_detections();', 'postgres', null, true);

select cron.schedule_in_database('trending-score-daily', '20 9 * * 1-5', 'SELECT public.trigger_trending_score();', 'postgres', null, true);

select cron.schedule_in_database('unusual-activity-session1', '5-59/5 2-4 * * 1-5', 'SELECT public.trigger_detect_unusual_activity();', 'postgres', null, true);

select cron.schedule_in_database('unusual-activity-session2a', '35-59/5 6 * * 1-5', 'SELECT public.trigger_detect_unusual_activity();', 'postgres', null, true);

select cron.schedule_in_database('unusual-activity-session2b', '0-55/5 7 * * 1-5', 'SELECT public.trigger_detect_unusual_activity();', 'postgres', null, true);

