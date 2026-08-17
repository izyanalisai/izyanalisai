


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."activate_subscription_from_payment"("p_payment_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_payment public.payments;
  v_sub_id uuid;
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'PAYMENT_NOT_FOUND';
  end if;

  select id into v_sub_id from public.subscriptions
    where user_id = v_payment.user_id and status in ('active','pending_cancel','grace')
    order by created_at desc limit 1;

  if v_sub_id is not null then
    update public.subscriptions
      set status = 'active',
          period_start = coalesce(period_start, now()),
          period_end = greatest(coalesce(period_end, now()), now()) + interval '30 days',
          cancel_at_period_end = false,
          grace_ends_at = null
      where id = v_sub_id;
  else
    insert into public.subscriptions (user_id, status, plan, period_start, period_end)
    values (v_payment.user_id, 'active', 'premium_monthly', now(), now() + interval '30 days')
    returning id into v_sub_id;
  end if;

  update public.payments set subscription_id = v_sub_id where id = p_payment_id;
  update public.profiles set is_premium = true where id = v_payment.user_id;

  return jsonb_build_object('status', 'ok', 'subscription_id', v_sub_id);
end;
$$;


ALTER FUNCTION "public"."activate_subscription_from_payment"("p_payment_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_dashboard_summary"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_is_admin boolean;
  v_result jsonb;
begin
  select is_admin into v_is_admin from public.profiles where id = auth.uid();
  if v_is_admin is not true then
    raise exception 'FORBIDDEN: hanya admin';
  end if;

  select jsonb_build_object(
    'total_users', (select count(*) from public.profiles where deleted_at is null),
    'premium_users', (select count(*) from public.profiles where is_premium = true and deleted_at is null),
    'open_bug_reports', (select count(*) from public.bug_reports where status = 'OPEN'),
    'open_feature_requests', (select count(*) from public.feature_requests where status = 'OPEN'),
    'active_signals', (select count(*) from public.signals where status = 'ACTIVE'),
    'pending_payments', (select count(*) from public.payments where status = 'pending'),
    'failed_jobs_24h', (select count(*) from public.job_runs where status = 'ERROR' and started_at > now() - interval '24 hours'),
    'app_rating_avg', (select round(avg(rating)::numeric, 2) from public.app_ratings),
    'app_rating_count', (select count(*) from public.app_ratings)
  ) into v_result;

  return v_result;
end;
$$;


ALTER FUNCTION "public"."admin_dashboard_summary"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_invalidate_signal"("p_signal_id" "uuid", "p_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_is_admin boolean;
  v_status text;
BEGIN
  SELECT is_admin INTO v_is_admin FROM public.profiles WHERE id = auth.uid();
  IF v_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'FORBIDDEN: hanya admin yang boleh override signal';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Alasan override wajib diisi';
  END IF;

  SELECT status INTO v_status FROM public.signals WHERE id = p_signal_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Signal tidak ditemukan';
  END IF;
  IF v_status NOT IN ('ACTIVE') THEN
    RAISE EXCEPTION 'Signal sudah dalam status terminal (%), tidak bisa di-override', v_status;
  END IF;

  UPDATE public.signals
  SET status = 'INVALIDATED', resolved_at = now()
  WHERE id = p_signal_id;

  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, detail)
  VALUES (auth.uid(), 'ADMIN_OVERRIDE_SIGNAL', 'signal', p_signal_id, jsonb_build_object('reason', p_reason));
END;
$$;


ALTER FUNCTION "public"."admin_invalidate_signal"("p_signal_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_record_corporate_action"("p_stock_id" "uuid", "p_action_type" "text", "p_ex_date" "date", "p_ratio" numeric DEFAULT NULL::numeric, "p_notes" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only';
  END IF;

  INSERT INTO public.corporate_actions (stock_id, action_type, ex_date, ratio, notes, status)
  VALUES (p_stock_id, p_action_type, p_ex_date, p_ratio, p_notes, 'PENDING')
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (actor_id, action, target_table, target_id, detail)
  VALUES (auth.uid(), 'CORPORATE_ACTION_RECORDED', 'corporate_actions', v_id,
    jsonb_build_object('stock_id', p_stock_id, 'action_type', p_action_type, 'ex_date', p_ex_date));

  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."admin_record_corporate_action"("p_stock_id" "uuid", "p_action_type" "text", "p_ex_date" "date", "p_ratio" numeric, "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."calculate_trending_scores"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  WITH latest_indicator AS (
    SELECT DISTINCT ON (stock_id) stock_id, rsi14, macd_hist, volume_avg20
    FROM public.indicators
    WHERE timeframe = 'D1'
    ORDER BY stock_id, updated_at DESC
  ),
  scored AS (
    SELECT
      s.id AS stock_id,
      -- RSI healthy momentum zone (0-10)
      CASE WHEN li.rsi14 BETWEEN 50 AND 70 THEN 10 ELSE 0 END
      -- MACD bullish histogram (0-10)
      + CASE WHEN li.macd_hist > 0 THEN 10 ELSE 0 END
      -- Volume spike vs 20d avg (0-15)
      + CASE
          WHEN li.volume_avg20 > 0 AND q.volume >= li.volume_avg20 * 2 THEN 15
          WHEN li.volume_avg20 > 0 AND q.volume >= li.volume_avg20 * 1.5 THEN 8
          ELSE 0
        END
      -- Fundamental: reasonable PE (0-10)
      + CASE WHEN f.pe_ratio IS NOT NULL AND f.pe_ratio BETWEEN 0 AND 25 THEN 10 ELSE 0 END
      -- Fundamental: profitable (0-10)
      + CASE WHEN f.net_profit IS NOT NULL AND f.net_profit > 0 THEN 10 ELSE 0 END
      AS score
    FROM public.stocks s
    LEFT JOIN latest_indicator li ON li.stock_id = s.id
    LEFT JOIN public.quotes q ON q.stock_id = s.id
    LEFT JOIN public.fundamentals f ON f.stock_id = s.id
    WHERE s.is_active = true
  )
  UPDATE public.stocks st
  SET trending_score = round(sc.score, 1),
      trending_label = CASE WHEN sc.score >= 60 THEN 'Trending' ELSE NULL END,
      trending_updated_at = now()
  FROM scored sc
  WHERE sc.stock_id = st.id;
END;
$$;


ALTER FUNCTION "public"."calculate_trending_scores"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."compute_sector_rotation"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_today date;
begin
  select max(ts::date) into v_today from public.candles where timeframe = 'D1';
  if v_today is null then
    return;
  end if;

  with ranked as (
    select
      c.stock_id,
      s.sector_id,
      c.ts::date as trade_date,
      c.close,
      row_number() over (partition by c.stock_id order by c.ts desc) as rn
    from public.candles c
    join public.stocks s on s.id = c.stock_id
    where c.timeframe = 'D1' and s.sector_id is not null and s.is_active = true
  ),
  -- window terkini: hari ini (rn=1) vs 5 hari kerja lalu (rn=6)
  cur_window as (
    select stock_id, sector_id,
      max(close) filter (where rn = 1) as close_now,
      max(close) filter (where rn = 6) as close_5d_ago
    from ranked where rn in (1, 6)
    group by stock_id, sector_id
  ),
  -- window sebelumnya: 5 hari lalu (rn=6) vs 10 hari lalu (rn=11), buat hitung momentum
  prior_window as (
    select stock_id, sector_id,
      max(close) filter (where rn = 6) as close_5d_ago,
      max(close) filter (where rn = 11) as close_10d_ago
    from ranked where rn in (6, 11)
    group by stock_id, sector_id
  ),
  cur_returns as (
    select sector_id, stock_id,
      case when close_5d_ago > 0 then (close_now - close_5d_ago) / close_5d_ago * 100 else null end as ret
    from cur_window
  ),
  prior_returns as (
    select sector_id, stock_id,
      case when close_10d_ago > 0 then (close_5d_ago - close_10d_ago) / close_10d_ago * 100 else null end as ret
    from prior_window
  ),
  market_cur as (
    select avg(ret) as m from cur_returns where ret is not null
  ),
  market_prior as (
    select avg(ret) as m from prior_returns where ret is not null
  ),
  sector_cur as (
    select sector_id, avg(ret) as avg_return_5d
    from cur_returns where ret is not null
    group by sector_id
  ),
  sector_prior as (
    select sector_id, avg(ret) as avg_return_5d
    from prior_returns where ret is not null
    group by sector_id
  )
  insert into public.sector_rotation_scores (sector_id, as_of_date, relative_strength, momentum, label, avg_return_5d)
  select
    sc.sector_id,
    v_today,
    (sc.avg_return_5d - mc.m) as relative_strength,
    (sc.avg_return_5d - mc.m) - coalesce((sp.avg_return_5d - mp.m), sc.avg_return_5d - mc.m) as momentum,
    case
      when (sc.avg_return_5d - mc.m) >= 0 and ((sc.avg_return_5d - mc.m) - coalesce((sp.avg_return_5d - mp.m), sc.avg_return_5d - mc.m)) >= 0 then 'LEADING'
      when (sc.avg_return_5d - mc.m) < 0 and ((sc.avg_return_5d - mc.m) - coalesce((sp.avg_return_5d - mp.m), sc.avg_return_5d - mc.m)) >= 0 then 'IMPROVING'
      when (sc.avg_return_5d - mc.m) >= 0 and ((sc.avg_return_5d - mc.m) - coalesce((sp.avg_return_5d - mp.m), sc.avg_return_5d - mc.m)) < 0 then 'WEAKENING'
      else 'LAGGING'
    end,
    sc.avg_return_5d
  from sector_cur sc
  cross join market_cur mc
  left join sector_prior sp on sp.sector_id = sc.sector_id
  cross join market_prior mp
  on conflict (sector_id, as_of_date) do update set
    relative_strength = excluded.relative_strength,
    momentum = excluded.momentum,
    label = excluded.label,
    avg_return_5d = excluded.avg_return_5d,
    computed_at = now();

  insert into public.job_runs (job_name, status, finished_at)
  values ('compute-sector-rotation', 'SUCCESS', now());
end;
$$;


ALTER FUNCTION "public"."compute_sector_rotation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."credit_ad_unlock_verified"("p_user_id" "uuid", "p_stock_id" "uuid", "p_transaction_id" "text", "p_reward_item" "text" DEFAULT NULL::"text", "p_reward_amount" numeric DEFAULT NULL::numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_wallet public.token_wallets;
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
begin
  -- Idempotency: transaction_id dari AdMob cuma boleh diproses sekali
  begin
    insert into public.ad_verifications (transaction_id, user_id, stock_id, reward_item, reward_amount)
    values (p_transaction_id, p_user_id, p_stock_id, p_reward_item, p_reward_amount);
  exception when unique_violation then
    return jsonb_build_object('status', 'ok', 'already_processed', true);
  end;

  v_wallet := public.ensure_wallet_current(p_user_id);

  if exists (
    select 1 from public.signal_unlocks
    where user_id = p_user_id and stock_id = p_stock_id and unlock_date = v_today
  ) then
    return jsonb_build_object('status', 'ok', 'already_unlocked', true);
  end if;

  -- FIX: enforce batas 3 iklan/hari (spec 7.1) -- sebelumnya tidak dicek di sini,
  -- cuma dicek di jalur placeholder unlock_signal_with_ad.
  if v_wallet.ad_unlock_count >= 3 then
    return jsonb_build_object('status', 'error', 'reason', 'AD_LIMIT_REACHED');
  end if;

  update public.token_wallets
    set ad_unlock_count = ad_unlock_count + 1
    where id = v_wallet.id;

  insert into public.token_transactions (wallet_id, amount, type, reference_id)
  values (v_wallet.id, 0, 'AD_UNLOCK', p_stock_id);

  insert into public.signal_unlocks (user_id, stock_id, unlock_date, source)
  values (p_user_id, p_stock_id, v_today, 'AD')
  on conflict (user_id, stock_id, unlock_date) do nothing;

  return jsonb_build_object('status', 'ok', 'ad_unlock_count', v_wallet.ad_unlock_count + 1);
end;
$$;


ALTER FUNCTION "public"."credit_ad_unlock_verified"("p_user_id" "uuid", "p_stock_id" "uuid", "p_transaction_id" "text", "p_reward_item" "text", "p_reward_amount" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deduct_token"("p_type" "text", "p_reference_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("balance" integer, "already_charged" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_wallet_id uuid;
  v_balance integer;
  v_balance_before integer;
  v_last_reset date;
  v_today_wib date := (now() AT TIME ZONE 'Asia/Jakarta')::date;
  v_is_premium boolean;
  v_daily_grant integer;
  v_period_days integer;
  v_existing_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  IF p_type IS NULL OR p_type = '' THEN
    RAISE EXCEPTION 'INVALID_TYPE';
  END IF;

  IF p_reference_id IS NOT NULL THEN
    SELECT tt.id INTO v_existing_id
    FROM public.token_transactions tt
    JOIN public.token_wallets tw ON tw.id = tt.wallet_id
    WHERE tw.user_id = v_user_id AND tt.reference_id = p_reference_id AND tt.type = p_type
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      SELECT tw.balance INTO v_balance FROM public.token_wallets tw WHERE tw.user_id = v_user_id;
      RETURN QUERY SELECT v_balance, true;
      RETURN;
    END IF;
  END IF;

  SELECT p.is_premium INTO v_is_premium FROM public.profiles p WHERE p.id = v_user_id;
  v_daily_grant := CASE WHEN v_is_premium THEN 50 ELSE 5 END;
  v_period_days := CASE WHEN v_is_premium THEN 3 ELSE 1 END;

  SELECT tw.id, tw.balance, tw.last_reset_date INTO v_wallet_id, v_balance, v_last_reset
  FROM public.token_wallets tw
  WHERE tw.user_id = v_user_id
  FOR UPDATE;

  IF v_wallet_id IS NULL THEN
    INSERT INTO public.token_wallets (user_id, balance, last_reset_date)
    VALUES (v_user_id, v_daily_grant, v_today_wib)
    RETURNING token_wallets.id, token_wallets.balance, token_wallets.last_reset_date
    INTO v_wallet_id, v_balance, v_last_reset;
  ELSIF v_today_wib - v_last_reset >= v_period_days THEN
    UPDATE public.token_wallets AS tw
      SET balance = v_daily_grant, last_reset_date = v_today_wib
      WHERE tw.id = v_wallet_id
      RETURNING tw.balance INTO v_balance;
  END IF;

  IF v_balance <= 0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_TOKENS';
  END IF;

  v_balance_before := v_balance;

  UPDATE public.token_wallets AS tw SET balance = tw.balance - 1
    WHERE tw.id = v_wallet_id RETURNING tw.balance INTO v_balance;

  INSERT INTO public.token_transactions (wallet_id, amount, type, reference_id, balance_before, balance_after)
  VALUES (v_wallet_id, -1, p_type, p_reference_id, v_balance_before, v_balance);

  RETURN QUERY SELECT v_balance, false;
END;
$$;


ALTER FUNCTION "public"."deduct_token"("p_type" "text", "p_reference_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."detect_unusual_activity"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.unusual_activities (stock_id, timestamp, price, volume, avg_volume_20d, price_change_percent, severity)
  SELECT
    q.stock_id,
    now(),
    q.price,
    q.volume,
    i.volume_avg20,
    round(((q.price - q.previous_close) / NULLIF(q.previous_close,0)) * 100, 2),
    CASE
      WHEN q.volume >= i.volume_avg20 * 5 THEN 'high'
      ELSE 'medium'
    END
  FROM public.quotes q
  JOIN public.indicators i ON i.stock_id = q.stock_id AND i.timeframe = 'D1'
  WHERE i.volume_avg20 > 0
    AND q.volume >= i.volume_avg20 * 3
    AND abs((q.price - q.previous_close) / NULLIF(q.previous_close,0)) * 100 >= 2
    AND NOT EXISTS (
      SELECT 1 FROM public.unusual_activities ua
      WHERE ua.stock_id = q.stock_id
        AND ua.timestamp::date = (now() at time zone 'Asia/Jakarta')::date
    );
END;
$$;


ALTER FUNCTION "public"."detect_unusual_activity"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dispatch_morning_briefing"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."dispatch_morning_briefing"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_ai_task_limits"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_is_premium boolean;
  v_max_tasks int;
  v_active_count int;
  v_ticker text;
  v_ticker_exists boolean;
BEGIN
  SELECT is_premium INTO v_is_premium FROM public.profiles WHERE id = NEW.user_id;
  v_is_premium := COALESCE(v_is_premium, false);

  IF NOT v_is_premium AND NEW.task_type IN ('LEVEL_RETEST', 'UNUSUAL_VOLUME') THEN
    RAISE EXCEPTION 'AI_TASK_TYPE_REQUIRES_PREMIUM';
  END IF;

  v_max_tasks := CASE WHEN v_is_premium THEN 20 ELSE 3 END;

  IF NEW.is_active THEN
    SELECT count(*) INTO v_active_count
    FROM public.ai_tasks
    WHERE user_id = NEW.user_id AND is_active = true;

    IF v_active_count >= v_max_tasks THEN
      RAISE EXCEPTION 'AI_TASK_LIMIT_REACHED';
    END IF;
  END IF;

  -- Validasi ticker wajib ada di stocks untuk task berbasis harga saham
  IF NEW.task_type IN ('PRICE_ALERT', 'LEVEL_RETEST', 'UNUSUAL_VOLUME') THEN
    v_ticker := NEW.parameters->>'ticker';
    IF v_ticker IS NOT NULL AND trim(v_ticker) <> '' THEN
      SELECT EXISTS(SELECT 1 FROM public.stocks WHERE ticker = upper(v_ticker) AND is_active = true)
        INTO v_ticker_exists;
      IF NOT v_ticker_exists THEN
        RAISE EXCEPTION 'AI_TASK_INVALID_TICKER: %', v_ticker;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_ai_task_limits"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_ai_task_limits_on_update"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_is_premium boolean;
  v_max_tasks int;
  v_active_count int;
BEGIN
  IF NEW.is_active = true AND OLD.is_active = false THEN
    SELECT is_premium INTO v_is_premium FROM public.profiles WHERE id = NEW.user_id;
    v_is_premium := COALESCE(v_is_premium, false);
    v_max_tasks := CASE WHEN v_is_premium THEN 20 ELSE 3 END;

    SELECT count(*) INTO v_active_count
    FROM public.ai_tasks
    WHERE user_id = NEW.user_id AND is_active = true AND id != NEW.id;

    IF v_active_count >= v_max_tasks THEN
      RAISE EXCEPTION 'AI_TASK_LIMIT_REACHED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_ai_task_limits_on_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_trading_plan_module_lock"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_is_premium boolean;
begin
  select coalesce(is_premium, false) into v_is_premium
  from public.profiles where id = new.user_id;

  if not v_is_premium then
    if NULLIF(trim(new.module_4), '')  is distinct from NULLIF(trim(old.module_4), '')  or
       NULLIF(trim(new.module_5), '')  is distinct from NULLIF(trim(old.module_5), '')  or
       NULLIF(trim(new.module_6), '')  is distinct from NULLIF(trim(old.module_6), '')  or
       NULLIF(trim(new.module_7), '')  is distinct from NULLIF(trim(old.module_7), '')  or
       NULLIF(trim(new.module_8), '')  is distinct from NULLIF(trim(old.module_8), '')  or
       NULLIF(trim(new.module_9), '')  is distinct from NULLIF(trim(old.module_9), '')  or
       NULLIF(trim(new.module_10), '') is distinct from NULLIF(trim(old.module_10), '') then
      raise exception 'MODUL_TERKUNCI: modul 4-10 hanya untuk Premium';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_trading_plan_module_lock"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_trading_plan_module_lock_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_is_premium boolean;
begin
  select coalesce(is_premium, false) into v_is_premium
  from public.profiles where id = new.user_id;

  if not v_is_premium then
    if NULLIF(trim(new.module_4), '')  is not null or NULLIF(trim(new.module_5), '')  is not null or
       NULLIF(trim(new.module_6), '')  is not null or NULLIF(trim(new.module_7), '')  is not null or
       NULLIF(trim(new.module_8), '')  is not null or NULLIF(trim(new.module_9), '')  is not null or
       NULLIF(trim(new.module_10), '') is not null then
      raise exception 'MODUL_TERKUNCI: modul 4-10 hanya untuk Premium';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_trading_plan_module_lock_insert"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_trading_plan_tier"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_is_premium boolean;
BEGIN
  SELECT is_premium INTO v_is_premium FROM public.profiles WHERE id = NEW.user_id;
  IF NOT COALESCE(v_is_premium, false) THEN
    IF NULLIF(trim(NEW.module_4), '')  IS NOT NULL OR NULLIF(trim(NEW.module_5), '')  IS NOT NULL
       OR NULLIF(trim(NEW.module_6), '')  IS NOT NULL OR NULLIF(trim(NEW.module_7), '')  IS NOT NULL
       OR NULLIF(trim(NEW.module_8), '')  IS NOT NULL OR NULLIF(trim(NEW.module_9), '')  IS NOT NULL
       OR NULLIF(trim(NEW.module_10), '') IS NOT NULL THEN
      RAISE EXCEPTION 'TRADING_PLAN_MODULE_REQUIRES_PREMIUM';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_trading_plan_tier"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_watchlist_folder_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.watchlists WHERE user_id = NEW.user_id;
  IF v_count >= 10 THEN
    RAISE EXCEPTION 'WATCHLIST_FOLDER_LIMIT: maksimal 10 folder watchlist per user';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_watchlist_folder_limit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_watchlist_item_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.watchlist_items WHERE watchlist_id = NEW.watchlist_id;
  IF v_count >= 50 THEN
    RAISE EXCEPTION 'WATCHLIST_ITEM_LIMIT: maksimal 50 saham per folder watchlist';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_watchlist_item_limit"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."token_wallets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "balance" integer DEFAULT 5,
    "last_reset_date" "date" DEFAULT CURRENT_DATE,
    "ad_unlock_count" integer DEFAULT 0 NOT NULL,
    "ad_unlock_date" "date" DEFAULT (("now"() AT TIME ZONE 'Asia/Jakarta'::"text"))::"date" NOT NULL,
    CONSTRAINT "token_wallets_balance_nonneg" CHECK (("balance" >= 0))
);


ALTER TABLE "public"."token_wallets" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_wallet_current"("p_user_id" "uuid") RETURNS "public"."token_wallets"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
                                      declare
                                        v_wallet     public.token_wallets;
                                          v_today      date := (now() at time zone 'Asia/Jakarta')::date;
                                            v_is_premium boolean;
                                              v_grant      integer;
                                              begin
                                                select * into v_wallet from public.token_wallets where user_id = p_user_id for update;

                                                  if not found then
                                                      insert into public.token_wallets (user_id, balance, last_reset_date, ad_unlock_count, ad_unlock_date)
                                                          values (p_user_id, 5, v_today, 0, v_today)
                                                              returning * into v_wallet;
                                                                end if;

                                                                  if v_wallet.last_reset_date < v_today then
                                                                      select coalesce(is_premium, false) into v_is_premium from public.profiles where id = p_user_id;
                                                                          v_grant := case when v_is_premium then 50 else 5 end;

                                                                              update public.token_wallets
                                                                                    set balance = v_grant, last_reset_date = v_today
                                                                                          where id = v_wallet.id
                                                                                                returning * into v_wallet;
                                                                                                  end if;

                                                                                                    if v_wallet.ad_unlock_date < v_today then
                                                                                                        update public.token_wallets
                                                                                                              set ad_unlock_count = 0, ad_unlock_date = v_today
                                                                                                                    where id = v_wallet.id
                                                                                                                          returning * into v_wallet;
                                                                                                                            end if;

                                                                                                                              return v_wallet;
                                                                                                                              end;
                                                                                                                              $$;


ALTER FUNCTION "public"."ensure_wallet_current"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."execute_ai_tasks"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  t record;
  st record;
  q record;
  triggered boolean;
  ihsg_summary text;
BEGIN
  -- PRICE ALERT
  FOR t IN
    SELECT * FROM public.ai_tasks
    WHERE is_active = true AND task_type = 'PRICE_ALERT'
  LOOP
    SELECT s.id, s.ticker INTO st FROM public.stocks s WHERE s.ticker = upper(t.parameters->>'ticker') LIMIT 1;
    IF st.id IS NULL THEN CONTINUE; END IF;
    SELECT price INTO q FROM public.quotes WHERE stock_id = st.id LIMIT 1;
    IF q.price IS NULL THEN CONTINUE; END IF;

    triggered := CASE
      WHEN t.parameters->>'direction' = 'above' THEN q.price >= (t.parameters->>'target_price')::numeric
      WHEN t.parameters->>'direction' = 'below' THEN q.price <= (t.parameters->>'target_price')::numeric
      ELSE false
    END;

    IF triggered THEN
      INSERT INTO public.notifications (id, user_id, category, title, body, reference_id, is_read, created_at, event_id)
      VALUES (
        gen_random_uuid(), t.user_id, 'SIGNAL',
        st.ticker || ' mencapai target harga',
        st.ticker || ' sekarang di ' || q.price || ' (target: ' || (t.parameters->>'direction') || ' ' || (t.parameters->>'target_price') || ')',
        st.id, false, now(),
        'ai_task:' || t.id || ':price_alert'
      )
      ON CONFLICT (event_id) DO NOTHING;

      UPDATE public.ai_tasks SET status = 'DONE', is_active = false, last_run = now() WHERE id = t.id;
    ELSE
      UPDATE public.ai_tasks SET last_run = now() WHERE id = t.id;
    END IF;
  END LOOP;

  -- LEVEL RETEST
  FOR t IN
    SELECT * FROM public.ai_tasks
    WHERE is_active = true AND task_type = 'LEVEL_RETEST'
  LOOP
    SELECT s.id, s.ticker INTO st FROM public.stocks s WHERE s.ticker = upper(t.parameters->>'ticker') LIMIT 1;
    IF st.id IS NULL THEN CONTINUE; END IF;
    SELECT price INTO q FROM public.quotes WHERE stock_id = st.id LIMIT 1;
    IF q.price IS NULL THEN CONTINUE; END IF;

    triggered := abs(q.price - (t.parameters->>'level')::numeric) / NULLIF((t.parameters->>'level')::numeric,0) * 100
                 <= COALESCE((t.parameters->>'tolerance_pct')::numeric, 1);

    IF triggered THEN
      INSERT INTO public.notifications (id, user_id, category, title, body, reference_id, is_read, created_at, event_id)
      VALUES (
        gen_random_uuid(), t.user_id, 'SIGNAL',
        st.ticker || ' retest level',
        st.ticker || ' menyentuh level ' || (t.parameters->>'level') || ' (harga sekarang: ' || q.price || ')',
        st.id, false, now(),
        'ai_task:' || t.id || ':level_retest:' || (now() at time zone 'Asia/Jakarta')::date
      )
      ON CONFLICT (event_id) DO NOTHING;
      UPDATE public.ai_tasks SET last_run = now() WHERE id = t.id;
    ELSE
      UPDATE public.ai_tasks SET last_run = now() WHERE id = t.id;
    END IF;
  END LOOP;

  -- UNUSUAL VOLUME (personal subscription to detector output)
  FOR t IN
    SELECT * FROM public.ai_tasks
    WHERE is_active = true AND task_type = 'UNUSUAL_VOLUME'
  LOOP
    FOR st IN
      SELECT ua.id AS ua_id, s.ticker, ua.price_change_percent
      FROM public.unusual_activities ua
      JOIN public.stocks s ON s.id = ua.stock_id
      WHERE ua.timestamp > COALESCE(t.last_run, now() - interval '1 day')
        AND (t.parameters->>'ticker' IS NULL OR s.ticker = upper(t.parameters->>'ticker'))
    LOOP
      INSERT INTO public.notifications (id, user_id, category, title, body, reference_id, is_read, created_at, event_id)
      VALUES (
        gen_random_uuid(), t.user_id, 'SIGNAL',
        st.ticker || ' volume tidak wajar',
        st.ticker || ' terdeteksi volume tidak wajar, perubahan harga ' || st.price_change_percent || '%',
        NULL, false, now(),
        'ai_task:' || t.id || ':unusual_volume:' || st.ua_id
      )
      ON CONFLICT (event_id) DO NOTHING;
    END LOOP;
    UPDATE public.ai_tasks SET last_run = now() WHERE id = t.id;
  END LOOP;

  -- DAILY SUMMARY (kirim sekali per hari WIB, hanya jika sudah lewat jam terjadwal)
  FOR t IN
    SELECT * FROM public.ai_tasks
    WHERE is_active = true AND task_type = 'DAILY_SUMMARY'
      AND (t.last_run IS NULL OR (t.last_run AT TIME ZONE 'Asia/Jakarta')::date < (now() AT TIME ZONE 'Asia/Jakarta')::date)
  LOOP
    SELECT string_agg(s.ticker || ' ' || round(((qu.price - qu.previous_close)/NULLIF(qu.previous_close,0))*100, 2) || '%', ', ')
      INTO ihsg_summary
    FROM public.quotes qu
    JOIN public.stocks s ON s.id = qu.stock_id
    WHERE qu.price IS NOT NULL AND qu.previous_close IS NOT NULL
    ORDER BY abs(((qu.price - qu.previous_close)/NULLIF(qu.previous_close,0))) DESC
    LIMIT 5;

    INSERT INTO public.notifications (id, user_id, category, title, body, reference_id, is_read, created_at, event_id)
    VALUES (
      gen_random_uuid(), t.user_id, 'MORNING_BRIEFING',
      'Ringkasan Pasar Hari Ini',
      COALESCE('Top movers: ' || ihsg_summary, 'Belum ada data pergerakan hari ini.'),
      NULL, false, now(),
      'ai_task:' || t.id || ':daily_summary:' || (now() at time zone 'Asia/Jakarta')::date
    )
    ON CONFLICT (event_id) DO NOTHING;

    UPDATE public.ai_tasks SET last_run = now() WHERE id = t.id;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."execute_ai_tasks"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expire_grace_subscriptions"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update public.subscriptions
    set status = 'expired'
    where status = 'grace'
      and grace_ends_at is not null
      and grace_ends_at < now();

  update public.profiles p
    set is_premium = false
    from public.subscriptions s
    where s.user_id = p.id
      and s.status = 'expired'
      and p.is_premium = true;
end;
$$;


ALTER FUNCTION "public"."expire_grace_subscriptions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_for_you_stocks"("p_limit" integer DEFAULT 10) RETURNS TABLE("stock_id" "uuid", "ticker" "text", "name" "text", "price" numeric, "change_percent" numeric, "signal_direction" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_risk_profile text;
  v_cap_min numeric;
  v_cap_max numeric;
BEGIN
  SELECT p.risk_profile INTO v_risk_profile FROM public.profiles p WHERE p.id = auth.uid();

  IF v_risk_profile = 'KONSERVATIF' THEN
    v_cap_min := 10000000000000; v_cap_max := NULL;
  ELSIF v_risk_profile = 'MODERAT' THEN
    v_cap_min := 2000000000000; v_cap_max := 10000000000000;
  ELSE
    v_cap_min := 0; v_cap_max := 2000000000000;
  END IF;

  RETURN QUERY
  SELECT s.id, s.ticker, s.name, q.price,
    round(((q.price - q.previous_close) / NULLIF(q.previous_close, 0)) * 100, 2) AS change_percent,
    sig.direction
  FROM public.stocks s
  JOIN public.quotes q ON q.stock_id = s.id
  LEFT JOIN LATERAL (
    SELECT sig_inner.direction FROM public.signals sig_inner
    WHERE sig_inner.stock_id = s.id AND sig_inner.status IN ('ACTIVE','HIT_TP1') AND sig_inner.superseded_by IS NULL
    ORDER BY sig_inner.created_at DESC LIMIT 1
  ) sig ON true
  WHERE s.is_active = true
    AND q.market_cap >= v_cap_min
    AND (v_cap_max IS NULL OR q.market_cap < v_cap_max)
  ORDER BY (sig.direction = 'BUY') DESC NULLS LAST, q.market_cap DESC
  LIMIT p_limit;
END;
$$;


ALTER FUNCTION "public"."get_for_you_stocks"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_wallet"() RETURNS "public"."token_wallets"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
                                                                                                                              begin
                                                                                                                                if auth.uid() is null then
                                                                                                                                    raise exception 'NOT_AUTHENTICATED';
                                                                                                                                      end if;
                                                                                                                                        return public.ensure_wallet_current(auth.uid());
                                                                                                                                        end;
                                                                                                                                        $$;


ALTER FUNCTION "public"."get_my_wallet"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_signal_for_stock"("p_stock_id" "uuid", "p_tier" "text" DEFAULT 'daily'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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
    'unlocked', v_unlocked
  );

  IF v_unlocked THEN
    v_result := v_result || jsonb_build_object(
      'entry_price', v_signal.entry_price,
      'buy_area_low', v_signal.buy_area_low,
      'buy_area_high', v_signal.buy_area_high,
      'support_level', v_signal.support_level,
      'resistance_level', v_signal.resistance_level,
      'tp1', v_signal.tp1,
      'tp2', v_signal.tp2,
      'stop_loss', v_signal.stop_loss,
      'ai_reasoning', v_signal.ai_reasoning
    );
  END IF;

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."get_signal_for_stock"("p_stock_id" "uuid", "p_tier" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_signal_history"("p_status" "text" DEFAULT NULL::"text", "p_tier" "text" DEFAULT NULL::"text", "p_days" integer DEFAULT NULL::integer, "p_limit" integer DEFAULT 50, "p_offset" integer DEFAULT 0) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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
      sg.id, st.ticker, st.name AS stock_name, sg.direction, sg.timeframe, sg.signal_tier,
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
    WHERE sg.status IN ('HIT_TP1','HIT_TP2','HIT_SL','HIT_SL_LOCKED','EXPIRED','INVALIDATED')
      AND (p_status IS NULL OR sg.status = p_status)
      AND (p_tier IS NULL OR sg.signal_tier = p_tier)
      AND (p_days IS NULL OR sg.created_at >= now() - (p_days || ' days')::interval)
    ORDER BY sg.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) t;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;


ALTER FUNCTION "public"."get_signal_history"("p_status" "text", "p_tier" "text", "p_days" integer, "p_limit" integer, "p_offset" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.profiles (id, full_name, created_at)
    values (new.id, new.raw_user_meta_data->>'full_name', now());

  insert into public.token_wallets (user_id, balance, last_reset_date)
    values (new.id, 5, (now() at time zone 'Asia/Jakarta')::date)
    on conflict (user_id) do nothing;

  insert into public.notification_preferences (
    user_id, master_enabled, market_alerts, signal_alerts,
    news_updates, economic_events, morning_briefing, unusual_activity_alert, updated_at
  )
    values (new.id, true, true, true, true, true, true, true, now())
    on conflict (user_id) do nothing;

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_current_user_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;


ALTER FUNCTION "public"."is_current_user_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."job_run_finish"("p_id" "uuid", "p_status" "text", "p_detail" "jsonb" DEFAULT NULL::"jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  UPDATE public.job_runs
  SET status = p_status,
      finished_at = now(),
      detail = CASE WHEN p_detail IS NULL THEN detail ELSE COALESCE(detail, '{}'::jsonb) || p_detail END
  WHERE id = p_id;
END;
$$;


ALTER FUNCTION "public"."job_run_finish"("p_id" "uuid", "p_status" "text", "p_detail" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."job_run_start"("p_job_name" "text", "p_detail" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.job_runs (job_name, status, detail, started_at)
  VALUES (p_job_name, 'RUNNING', p_detail, now())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."job_run_start"("p_job_name" "text", "p_detail" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_active_signals"("p_tier" "text" DEFAULT NULL::"text") RETURNS TABLE("id" "uuid", "direction" "text", "status" "text", "signal_tier" "text", "created_at" timestamp with time zone, "stock_id" "uuid", "ticker" "text", "name" "text", "entry_price" numeric, "buy_area_low" numeric, "buy_area_high" numeric, "support_level" numeric, "resistance_level" numeric, "tp1" numeric, "tp2" numeric, "stop_loss" numeric, "current_price" numeric, "unlocked" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Jakarta')::date;
  v_is_premium boolean := false;
BEGIN
  IF v_user IS NOT NULL THEN
    SELECT COALESCE(p.is_premium, false) INTO v_is_premium
    FROM public.profiles p WHERE p.id = v_user;
  END IF;

  RETURN QUERY
  SELECT
    s.id, s.direction, s.status, s.signal_tier, s.created_at,
    st.id AS stock_id, st.ticker, st.name,
    CASE WHEN (v_is_premium OR EXISTS (
      SELECT 1 FROM public.signal_unlocks su
      WHERE su.user_id = v_user AND su.stock_id = st.id AND su.unlock_date = v_today
    )) THEN s.entry_price ELSE NULL END,
    CASE WHEN (v_is_premium OR EXISTS (
      SELECT 1 FROM public.signal_unlocks su
      WHERE su.user_id = v_user AND su.stock_id = st.id AND su.unlock_date = v_today
    )) THEN s.buy_area_low ELSE NULL END,
    CASE WHEN (v_is_premium OR EXISTS (
      SELECT 1 FROM public.signal_unlocks su
      WHERE su.user_id = v_user AND su.stock_id = st.id AND su.unlock_date = v_today
    )) THEN s.buy_area_high ELSE NULL END,
    s.support_level,
    s.resistance_level,
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
    )) AS unlocked
  FROM public.signals s
  JOIN public.stocks st ON st.id = s.stock_id
  LEFT JOIN public.quotes q ON q.stock_id = st.id
  WHERE s.status IN ('ACTIVE', 'HIT_TP1')
    AND s.superseded_by IS NULL
    AND (p_tier IS NULL OR s.signal_tier = p_tier)
  ORDER BY s.created_at DESC;
END;
$$;


ALTER FUNCTION "public"."list_active_signals"("p_tier" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mtf_pipeline_poll"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_deadline timestamptz := clock_timestamp() + interval '100 seconds';
  r record;
  v_row net._http_response%ROWTYPE;
  v_url text; v_key text; v_secret text; v_headers jsonb;
  v_req bigint; v_next_tf text; v_page_total int; v_next_offset int;
  PAGE_SIZE constant int := 100;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.mtf_pipeline_runs WHERE status='RUNNING') THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'worker_shared_secret';
  v_headers := jsonb_build_object('Authorization','Bearer '||v_key,'Content-Type','application/json','x-worker-secret',v_secret);

  WHILE clock_timestamp() < v_deadline AND EXISTS (SELECT 1 FROM public.mtf_pipeline_runs WHERE status='RUNNING') LOOP
    FOR r IN SELECT * FROM public.mtf_pipeline_runs WHERE status='RUNNING' ORDER BY created_at LOOP
      SELECT * INTO v_row FROM net._http_response WHERE id = r.pending_request_id;

      IF NOT FOUND THEN
        IF now() - r.updated_at > interval '5 minutes' THEN
          PERFORM public.job_run_finish(r.job_run_id, 'ERROR', jsonb_build_object('stage', r.stage, 'reason', 'timeout menunggu net response (poller, >5menit)'));
          UPDATE public.mtf_pipeline_runs SET status='ERROR', updated_at=now() WHERE id = r.id;
        END IF;
        CONTINUE;
      END IF;

      IF v_row.error_msg IS NOT NULL OR v_row.status_code IS NULL OR v_row.status_code < 200 OR v_row.status_code >= 300 THEN
        PERFORM public.job_run_finish(r.job_run_id, 'ERROR', jsonb_build_object('stage', r.stage, 'offset', r.offset_val, 'status_code', v_row.status_code, 'error_msg', v_row.error_msg, 'content', left(v_row.content,500)));
        UPDATE public.mtf_pipeline_runs SET status='ERROR', updated_at=now() WHERE id = r.id;
        CONTINUE;
      END IF;

      v_page_total := COALESCE((v_row.content::jsonb ->> 'total')::int, 0);

      IF r.stage IN ('fetch-candles','compute-indicators') AND v_page_total >= PAGE_SIZE THEN
        v_next_offset := r.offset_val + PAGE_SIZE;
        SELECT net.http_post(
          url := v_url || '/functions/v1/' || r.stage || '?timeframe=' || (r.timeframes[r.tf_index]) || '&offset=' || v_next_offset || '&limit=' || PAGE_SIZE,
          headers := v_headers, timeout_milliseconds := 240000
        ) INTO v_req;
        UPDATE public.mtf_pipeline_runs SET offset_val=v_next_offset, pending_request_id=v_req, updated_at=now() WHERE id = r.id;

      ELSIF r.stage = 'fetch-candles' THEN
        SELECT net.http_post(
          url := v_url || '/functions/v1/compute-indicators?timeframe=' || (r.timeframes[r.tf_index]) || '&offset=0&limit=' || PAGE_SIZE,
          headers := v_headers, timeout_milliseconds := 240000
        ) INTO v_req;
        UPDATE public.mtf_pipeline_runs SET stage='compute-indicators', offset_val=0, pending_request_id=v_req, updated_at=now() WHERE id = r.id;

      ELSIF r.stage = 'compute-indicators' THEN
        IF r.tf_index < array_length(r.timeframes, 1) THEN
          v_next_tf := r.timeframes[r.tf_index + 1];
          SELECT net.http_post(
            url := v_url || '/functions/v1/fetch-candles?timeframe=' || v_next_tf || '&offset=0&limit=' || PAGE_SIZE,
            headers := v_headers, timeout_milliseconds := 240000
          ) INTO v_req;
          UPDATE public.mtf_pipeline_runs SET stage='fetch-candles', tf_index = r.tf_index + 1, offset_val=0, pending_request_id=v_req, updated_at=now() WHERE id = r.id;
        ELSE
          SELECT net.http_post(
            url := v_url || '/functions/v1/generate-signals-mtf?tier=' || r.tier || '&offset=0&limit=' || PAGE_SIZE,
            headers := v_headers, timeout_milliseconds := 240000
          ) INTO v_req;
          UPDATE public.mtf_pipeline_runs SET stage='generate-signals-mtf', offset_val=0, pending_request_id=v_req, updated_at=now() WHERE id = r.id;
        END IF;

      ELSIF r.stage = 'generate-signals-mtf' AND v_page_total >= PAGE_SIZE THEN
        v_next_offset := r.offset_val + PAGE_SIZE;
        SELECT net.http_post(
          url := v_url || '/functions/v1/generate-signals-mtf?tier=' || r.tier || '&offset=' || v_next_offset || '&limit=' || PAGE_SIZE,
          headers := v_headers, timeout_milliseconds := 240000
        ) INTO v_req;
        UPDATE public.mtf_pipeline_runs SET offset_val=v_next_offset, pending_request_id=v_req, updated_at=now() WHERE id = r.id;

      ELSIF r.stage = 'generate-signals-mtf' THEN
        PERFORM public.job_run_finish(r.job_run_id, 'SUCCESS', jsonb_build_object('tier', r.tier, 'note', 'full universe via async paginated poller'));
        UPDATE public.mtf_pipeline_runs SET status='SUCCESS', updated_at=now() WHERE id = r.id;
      END IF;

      EXIT WHEN clock_timestamp() >= v_deadline;
    END LOOP;

    IF clock_timestamp() < v_deadline AND EXISTS (SELECT 1 FROM public.mtf_pipeline_runs WHERE status='RUNNING') THEN
      PERFORM pg_sleep(3);
    END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."mtf_pipeline_poll"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_push_on_new_notification"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_pref record;
  v_allowed boolean := true;
  v_url text; v_key text; v_secret text; v_req_id bigint;
BEGIN
  SELECT * INTO v_pref FROM public.notification_preferences WHERE user_id = NEW.user_id;

  IF v_pref IS NOT NULL THEN
    IF v_pref.master_enabled = false THEN
      v_allowed := false;
    ELSIF NEW.category = 'MARKET' AND v_pref.market_alerts = false THEN v_allowed := false;
    ELSIF NEW.category = 'SIGNAL' AND v_pref.signal_alerts = false THEN v_allowed := false;
    ELSIF NEW.category = 'NEWS' AND v_pref.news_updates = false THEN v_allowed := false;
    ELSIF NEW.category = 'ECONOMIC_EVENT' AND v_pref.economic_events = false THEN v_allowed := false;
    ELSIF NEW.category = 'MORNING_BRIEFING' AND v_pref.morning_briefing = false THEN v_allowed := false;
    ELSIF NEW.category = 'UNUSUAL_ACTIVITY' AND v_pref.unusual_activity_alert = false THEN v_allowed := false;
    END IF;
  END IF;

  IF NOT v_allowed THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.push_subscriptions WHERE user_id = NEW.user_id) THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'worker_shared_secret';
  IF v_url IS NULL OR v_key IS NULL OR v_secret IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT net.http_post(
    url := v_url || '/functions/v1/send-web-push',
    headers := jsonb_build_object('Authorization','Bearer ' || v_key,'Content-Type','application/json','x-worker-secret', v_secret),
    body := jsonb_build_object(
      'user_id', NEW.user_id,
      'title', NEW.title,
      'body', NEW.body,
      'category', NEW.category,
      'reference_id', NEW.reference_id
    ),
    timeout_milliseconds := 15000
  ) INTO v_req_id;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."notify_push_on_new_notification"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_subscription_renewal_h1"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.notifications (user_id, category, title, body, reference_id, event_id)
  SELECT
    s.user_id,
    'SUBSCRIPTION',
    CASE WHEN s.cancel_at_period_end
      THEN 'Langganan Premium Berakhir Besok'
      ELSE 'Langganan Premium Diperpanjang Besok'
    END,
    CASE WHEN s.cancel_at_period_end
      THEN 'Langganan Premium kamu akan berakhir pada ' || to_char(s.period_end, 'DD Mon YYYY') || ' dan tidak diperpanjang otomatis.'
      ELSE 'Langganan Premium kamu akan diperpanjang otomatis pada ' || to_char(s.period_end, 'DD Mon YYYY') || '.'
    END,
    s.id,
    'sub_renewal_h1:' || s.id || ':' || s.period_end::date
  FROM public.subscriptions s
  JOIN public.notification_preferences np ON np.user_id = s.user_id
  WHERE s.status = 'active'
    AND s.period_end IS NOT NULL
    AND s.period_end::date = (now() AT TIME ZONE 'Asia/Jakarta')::date + INTERVAL '1 day'
    AND np.master_enabled = true
  ON CONFLICT (event_id) DO NOTHING;
END;
$$;


ALTER FUNCTION "public"."notify_subscription_renewal_h1"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_unusual_activity_subscribers"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."notify_unusual_activity_subscribers"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_watchlist_new_signal"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.notifications (user_id, category, title, body, reference_id, event_id)
  SELECT DISTINCT
    w.user_id,
    'SIGNAL',
    'Sinyal Baru: ' || s.ticker,
    'Sinyal ' || NEW.direction || ' baru untuk ' || s.ticker || ' (timeframe ' || NEW.timeframe || ').',
    NEW.stock_id,
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
$$;


ALTER FUNCTION "public"."notify_watchlist_new_signal"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_watchlist_news"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.related_tickers IS NULL OR array_length(NEW.related_tickers, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (user_id, category, title, body, reference_id, event_id)
  SELECT DISTINCT
    w.user_id,
    'NEWS',
    'Berita: ' || NEW.title,
    NEW.summary,
    NEW.id,
    'news:' || NEW.id || ':' || w.user_id
  FROM public.watchlist_items wi
  JOIN public.stocks s ON s.id = wi.stock_id
  JOIN public.watchlists w ON w.id = wi.watchlist_id
  JOIN public.notification_preferences np ON np.user_id = w.user_id
  WHERE s.ticker = ANY(NEW.related_tickers)
    AND np.master_enabled = true
    AND np.news_updates = true
  ON CONFLICT (event_id) DO NOTHING;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."notify_watchlist_news"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."process_corporate_actions"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_action record;
  v_signal record;
begin
  for v_action in
    select * from public.corporate_actions
    where status = 'PENDING' and ex_date <= (now() at time zone 'Asia/Jakarta')::date
  loop
    -- invalidate semua sinyal ACTIVE di saham ini
    for v_signal in
      select id from public.signals
      where stock_id = v_action.stock_id and status = 'ACTIVE'
    loop
      update public.signals
        set status = 'INVALIDATED', resolved_at = now()
        where id = v_signal.id;

      insert into public.audit_logs (actor_id, action, entity_type, entity_id, detail)
      values (
        null,
        'SIGNAL_INVALIDATED_CORPORATE_ACTION',
        'signal',
        v_signal.id,
        jsonb_build_object(
          'corporate_action_id', v_action.id,
          'action_type', v_action.action_type,
          'ex_date', v_action.ex_date,
          'ratio', v_action.ratio
        )
      );
    end loop;

    update public.corporate_actions
      set status = 'PROCESSED', processed_at = now()
      where id = v_action.id;

    insert into public.job_runs (job_name, status, detail, finished_at)
    values (
      'master-sync-corporate-action',
      'SUCCESS',
      jsonb_build_object('corporate_action_id', v_action.id, 'stock_id', v_action.stock_id, 'action_type', v_action.action_type),
      now()
    );
  end loop;
end;
$$;


ALTER FUNCTION "public"."process_corporate_actions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."process_pending_corporate_actions"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_action record;
  v_processed int := 0;
  v_signals_invalidated int := 0;
  v_count int;
BEGIN
  FOR v_action IN
    SELECT * FROM public.corporate_actions
    WHERE status = 'PENDING'
      AND ex_date <= (now() AT TIME ZONE 'Asia/Jakarta')::date
    ORDER BY ex_date
  LOOP
    UPDATE public.signals
    SET status = 'INVALIDATED', resolved_at = now()
    WHERE stock_id = v_action.stock_id
      AND status IN ('ACTIVE','HIT_TP1')
      AND superseded_by IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_signals_invalidated := v_signals_invalidated + v_count;

    IF v_action.action_type IN ('DELISTING','SUSPENSION') THEN
      UPDATE public.stocks SET is_active = false WHERE id = v_action.stock_id;
    END IF;

    UPDATE public.corporate_actions
    SET status = 'PROCESSED', processed_at = now()
    WHERE id = v_action.id;

    INSERT INTO public.audit_logs (actor_id, action, target_table, target_id, detail)
    VALUES (NULL, 'CORPORATE_ACTION_PROCESSED', 'corporate_actions', v_action.id,
      jsonb_build_object('stock_id', v_action.stock_id, 'action_type', v_action.action_type, 'signals_invalidated', v_count));

    v_processed := v_processed + 1;
  END LOOP;

  RETURN jsonb_build_object('processed', v_processed, 'signals_invalidated', v_signals_invalidated);
END;
$$;


ALTER FUNCTION "public"."process_pending_corporate_actions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_idx_manual_candle"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF OLD.source = 'IDX_MANUAL' AND NEW.source IS DISTINCT FROM 'IDX_MANUAL' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."protect_idx_manual_candle"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_idx_manual_quote"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF OLD.source = 'IDX_MANUAL'
     AND NEW.source IS DISTINCT FROM 'IDX_MANUAL'
     AND (OLD.market_time AT TIME ZONE 'Asia/Jakarta')::date
       = (COALESCE(NEW.market_time, now()) AT TIME ZONE 'Asia/Jakarta')::date
  THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."protect_idx_manual_quote"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_sensitive_profile_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.role() <> 'service_role'
     and coalesce(current_setting('app.trusted_profile_update', true), '') <> 'on' then
    new.is_premium := old.is_premium;
    new.is_admin := old.is_admin;
    new.is_active := old.is_active;
    new.deleted_at := old.deleted_at;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."protect_sensitive_profile_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_signal_immutable_fields"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    IF NEW.entry_price IS DISTINCT FROM OLD.entry_price
      OR NEW.buy_area_low IS DISTINCT FROM OLD.buy_area_low
      OR NEW.buy_area_high IS DISTINCT FROM OLD.buy_area_high
      OR NEW.tp1 IS DISTINCT FROM OLD.tp1
      OR NEW.tp2 IS DISTINCT FROM OLD.tp2
      OR NEW.stop_loss IS DISTINCT FROM OLD.stop_loss
      OR NEW.bearish_type IS DISTINCT FROM OLD.bearish_type
      OR NEW.bearish_trigger IS DISTINCT FROM OLD.bearish_trigger
      OR NEW.invalidation IS DISTINCT FROM OLD.invalidation
      OR NEW.downside_support_1 IS DISTINCT FROM OLD.downside_support_1
      OR NEW.downside_support_2 IS DISTINCT FROM OLD.downside_support_2
      OR NEW.evidence IS DISTINCT FROM OLD.evidence
    THEN
      RAISE EXCEPTION 'signal immutable fields tidak boleh diubah langsung -- gunakan alur signal_revisions (spec v4.1 section 79)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."protect_signal_immutable_fields"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."push_market_cap_to_quote"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.market_cap is not null then
    update public.quotes set market_cap = new.market_cap where stock_id = new.stock_id;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."push_market_cap_to_quote"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconcile_fetch_ipo_calendar"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
DECLARE
  v_job RECORD;
  v_resp RECORD;
  v_content text;
  v_card text;
  v_company text;
  v_ticker text;
  v_status_raw text;
  v_status text;
  v_tgl text;
  v_listing_date date;
  v_harga_text text;
  v_prices numeric[];
  v_low numeric;
  v_high numeric;
  v_total_ok int := 0;
  v_total_failed int := 0;
  v_month_map jsonb := '{"jan":"01","feb":"02","mar":"03","apr":"04","may":"05","jun":"06","jul":"07","aug":"08","sep":"09","oct":"10","nov":"11","dec":"12"}'::jsonb;
BEGIN
  FOR v_job IN
    SELECT id, detail FROM job_runs
    WHERE job_name = 'fetch-ipo-calendar' AND status = 'RUNNING'
    ORDER BY started_at DESC LIMIT 1
  LOOP
    SELECT status_code, content INTO v_resp
    FROM net._http_response
    WHERE id = (v_job.detail->>'net_request_id')::bigint;

    IF v_resp IS NULL OR v_resp.status_code IS NULL THEN
      CONTINUE; -- belum selesai, coba lagi di run cron berikutnya
    END IF;

    IF v_resp.status_code != 200 THEN
      UPDATE job_runs SET status = 'ERROR', detail = detail || jsonb_build_object('http_status', v_resp.status_code), finished_at = now()
      WHERE id = v_job.id;
      CONTINUE;
    END IF;

    v_content := v_resp.content;

    -- Tiap kartu IPO adalah blok <div class="pricing-box ...">...</div>;
    -- pisahkan per kartu lalu ekstrak field dengan regex.
    FOR v_card IN
      SELECT (regexp_matches(v_content, '<div class="pricing-box[^"]*">(.*?)</div>\s*</div>\s*</div>\s*</div>', 'g'))[1]
    LOOP
      v_status_raw := substring(v_card FROM '<h3>([^<]+)</h3>');
      v_company := substring(v_card FROM '<h5 class="nobottommargin">([^<]+)<br>');
      v_ticker := substring(v_card FROM '\(([A-Z]{4})\)');
      v_tgl := substring(v_card FROM 'Tanggal Pencatatan</h5><p class="notopmargin">([^<]+)</p>');
      v_harga_text := substring(v_card FROM '(?:Harga Final|Rentang Harga Book Building)</h5><p class="notopmargin">([^<]+)</p>');

      IF v_ticker IS NULL OR v_company IS NULL THEN
        CONTINUE;
      END IF;

      -- Parse tanggal "08 Jul 2026" -> date
      v_listing_date := NULL;
      IF v_tgl IS NOT NULL THEN
        DECLARE
          v_day text := split_part(trim(v_tgl), ' ', 1);
          v_mon_raw text := lower(split_part(trim(v_tgl), ' ', 2));
          v_year text := split_part(trim(v_tgl), ' ', 3);
          v_mon text := v_month_map->>v_mon_raw;
        BEGIN
          IF v_mon IS NOT NULL AND v_year ~ '^\d{4}$' THEN
            v_listing_date := to_date(v_year || '-' || v_mon || '-' || lpad(v_day, 2, '0'), 'YYYY-MM-DD');
          END IF;
        END;
      END IF;

      -- Parse harga "Rp 470" atau "Rp 298 - Rp 328"
      v_prices := ARRAY(
        SELECT replace((regexp_matches(v_harga_text, 'Rp\s*([\d.]+)', 'g'))[1], '.', '')::numeric
        FROM (SELECT 1) _
      );
      -- regexp_matches dengan 'g' di lateral context butuh pendekatan berbeda; ambil manual:
      v_prices := ARRAY(
        SELECT replace(m[1], '.', '')::numeric
        FROM regexp_matches(coalesce(v_harga_text, ''), 'Rp\s*([\d.]+)', 'g') AS m
      );
      IF array_length(v_prices, 1) IS NULL THEN
        v_low := NULL; v_high := NULL;
      ELSIF array_length(v_prices, 1) = 1 THEN
        v_low := v_prices[1]; v_high := v_prices[1];
      ELSE
        v_low := (SELECT min(x) FROM unnest(v_prices) x);
        v_high := (SELECT max(x) FROM unnest(v_prices) x);
      END IF;

      -- Map status e-IPO -> enum ipo_calendar.status
      v_status := CASE
        WHEN v_status_raw ILIKE '%closed%' THEN 'LISTED'
        WHEN v_status_raw ILIKE '%cancel%' OR v_status_raw ILIKE '%postpone%' THEN 'CANCELLED'
        WHEN v_status_raw ILIKE '%waiting for offering%' OR v_status_raw ILIKE '%book building%' OR v_status_raw ILIKE '%pre-effective%' THEN 'UPCOMING'
        WHEN v_status_raw ILIKE '%offering%' OR v_status_raw ILIKE '%allotment%' THEN 'OPEN'
        ELSE 'UPCOMING'
      END;

      BEGIN
        INSERT INTO ipo_calendar (company_name, ticker, listing_date, price_range_low, price_range_high, status)
        VALUES (trim(v_company), v_ticker, v_listing_date, v_low, v_high, v_status)
        ON CONFLICT (ticker) WHERE ticker IS NOT NULL
        DO UPDATE SET
          company_name = EXCLUDED.company_name,
          listing_date = EXCLUDED.listing_date,
          price_range_low = EXCLUDED.price_range_low,
          price_range_high = EXCLUDED.price_range_high,
          status = EXCLUDED.status;
        v_total_ok := v_total_ok + 1;
      EXCEPTION WHEN OTHERS THEN
        v_total_failed := v_total_failed + 1;
      END;
    END LOOP;

    UPDATE job_runs
    SET status = 'SUCCESS',
        detail = detail || jsonb_build_object('ok', v_total_ok, 'failed', v_total_failed),
        finished_at = now()
    WHERE id = v_job.id;
  END LOOP;
END;
$_$;


ALTER FUNCTION "public"."reconcile_fetch_ipo_calendar"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconcile_job_runs"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  r record;
  v_status_code int;
  v_error_msg text;
  v_timed_out boolean;
BEGIN
  FOR r IN
    SELECT id, (detail->>'net_request_id')::bigint AS req_id
    FROM public.job_runs
    WHERE status = 'SUCCESS'
      AND detail ? 'net_request_id'
      AND NOT (detail ? 'reconciled')
      AND started_at > now() - interval '2 hours'
  LOOP
    SELECT status_code, error_msg, timed_out INTO v_status_code, v_error_msg, v_timed_out
    FROM net._http_response WHERE id = r.req_id;

    IF v_status_code IS NOT NULL THEN
      UPDATE public.job_runs
      SET status = CASE WHEN v_status_code BETWEEN 200 AND 299 THEN 'SUCCESS' ELSE 'ERROR' END,
          detail = detail || jsonb_build_object('reconciled', true, 'http_status', v_status_code)
      WHERE id = r.id;
    ELSIF v_error_msg IS NOT NULL OR v_timed_out THEN
      UPDATE public.job_runs
      SET status = 'ERROR',
          detail = detail || jsonb_build_object('reconciled', true, 'error', COALESCE(v_error_msg, 'timeout'))
      WHERE id = r.id;
    END IF;
  END LOOP;

  UPDATE public.job_runs
  SET status = 'ERROR', finished_at = now(),
      detail = COALESCE(detail, '{}'::jsonb) || jsonb_build_object('reason', 'timeout/no response after 15 min')
  WHERE status = 'RUNNING' AND started_at < now() - interval '15 minutes';
END;
$$;


ALTER FUNCTION "public"."reconcile_job_runs"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_signal_result"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
    WHEN 'INVALIDATED' THEN v_result := 'INVALID'; v_exit := NULL;
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
$$;


ALTER FUNCTION "public"."record_signal_result"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refund_token"("p_type" "text", "p_reference_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("balance" integer, "refunded" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_wallet_id uuid;
  v_balance integer;
  v_already boolean;
  v_original_debit_exists boolean;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  IF p_reference_id IS NULL THEN
    RAISE EXCEPTION 'REFERENCE_ID_REQUIRED';
  END IF;

  -- Refund cuma valid kalau memang ada transaksi DEBIT (amount < 0) asli
  -- dengan reference_id + type yang sama milik user ini. Ini mencegah user
  -- bikin refund_token dengan reference_id acak buat minting token gratis.
  SELECT EXISTS(
    SELECT 1 FROM public.token_transactions tt
    JOIN public.token_wallets tw ON tw.id = tt.wallet_id
    WHERE tw.user_id = v_user_id AND tt.reference_id = p_reference_id AND tt.type = p_type AND tt.amount < 0
  ) INTO v_original_debit_exists;

  IF NOT v_original_debit_exists THEN
    RAISE EXCEPTION 'NO_MATCHING_DEBIT_TO_REFUND';
  END IF;

  -- Sudah pernah di-refund sebelumnya? (idempotent, cek record REFUND dengan reference sama)
  SELECT EXISTS(
    SELECT 1 FROM public.token_transactions tt
    JOIN public.token_wallets tw ON tw.id = tt.wallet_id
    WHERE tw.user_id = v_user_id AND tt.reference_id = p_reference_id AND tt.type = p_type AND tt.amount > 0
  ) INTO v_already;

  IF v_already THEN
    SELECT tw.balance INTO v_balance FROM public.token_wallets tw WHERE tw.user_id = v_user_id;
    RETURN QUERY SELECT v_balance, false;
    RETURN;
  END IF;

  UPDATE public.token_wallets AS tw SET balance = tw.balance + 1
    WHERE tw.user_id = v_user_id
    RETURNING tw.id, tw.balance INTO v_wallet_id, v_balance;

  IF v_wallet_id IS NULL THEN
    RETURN QUERY SELECT NULL::integer, false;
    RETURN;
  END IF;

  INSERT INTO public.token_transactions (wallet_id, amount, type, reference_id, balance_before, balance_after)
  VALUES (v_wallet_id, 1, p_type, p_reference_id, v_balance - 1, v_balance);

  RETURN QUERY SELECT v_balance, true;
END;
$$;


ALTER FUNCTION "public"."refund_token"("p_type" "text", "p_reference_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."request_account_deletion"("p_reason" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
  set cancel_at_period_end = true
  where user_id = v_uid and status = 'active';

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, detail)
  values (v_uid, 'ACCOUNT_DELETE_REQUESTED', 'profiles', v_uid, jsonb_build_object('reason', p_reason));
end;
$$;


ALTER FUNCTION "public"."request_account_deletion"("p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_quote_market_cap"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.market_cap is null then
    select f.market_cap into new.market_cap
    from public.fundamentals f
    where f.stock_id = new.stock_id;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."sync_quote_market_cap"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_signal_evidence"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.evidence IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.signal_evidence (
    id, signal_id, structure, support, resistance, "trigger",
    invalidation, timeframes, data_quality, formula_version, generated_at, created_at
  )
  VALUES (
    gen_random_uuid(),
    NEW.id,
    NEW.evidence->'structure',
    NEW.evidence->'support',
    NEW.evidence->'resistance',
    NEW.evidence->'trigger',
    NEW.evidence->'invalidation',
    NEW.evidence->'timeframes',
    NEW.evidence->'data_quality',
    COALESCE(NEW.evidence->>'formula_version', NEW.formula_version),
    COALESCE((NEW.evidence->>'generated_at')::timestamptz, NEW.created_at, now()),
    now()
  )
  ON CONFLICT (signal_id) DO UPDATE SET
    structure = EXCLUDED.structure,
    support = EXCLUDED.support,
    resistance = EXCLUDED.resistance,
    "trigger" = EXCLUDED."trigger",
    invalidation = EXCLUDED.invalidation,
    timeframes = EXCLUDED.timeframes,
    data_quality = EXCLUDED.data_quality,
    formula_version = EXCLUDED.formula_version,
    generated_at = EXCLUDED.generated_at;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_signal_evidence"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_stock_master"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_new_count int := 0;
  v_deactivated_count int := 0;
BEGIN
  INSERT INTO public.stocks (ticker, name, is_active)
  SELECT ic.ticker, ic.company_name, true
  FROM public.ipo_calendar ic
  WHERE ic.status = 'LISTED'
    AND ic.ticker IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.stocks st WHERE st.ticker = ic.ticker);
  GET DIAGNOSTICS v_new_count = ROW_COUNT;

  UPDATE public.stocks st
  SET is_active = false
  FROM public.corporate_actions ca
  WHERE ca.stock_id = st.id
    AND ca.status = 'PROCESSED'
    AND ca.action_type IN ('DELISTING', 'SUSPENSION')
    AND st.is_active = true;
  GET DIAGNOSTICS v_deactivated_count = ROW_COUNT;

  RETURN jsonb_build_object('new_stocks', v_new_count, 'deactivated_stocks', v_deactivated_count);
END;
$$;


ALTER FUNCTION "public"."sync_stock_master"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_ai_task_executor"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_url text; v_key text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE WARNING 'ai-task-executor: project_url/service_role_key belum di Vault'; RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_url || '/functions/v1/ai-task-executor',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json')
  );
END; $$;


ALTER FUNCTION "public"."trigger_ai_task_executor"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_detect_unusual_activity"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_url text; v_key text; v_run_id uuid; v_req_id bigint;
begin
  v_run_id := public.job_run_start('detect-unusual-activity');
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then
    perform public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('reason','vault secrets belum diset'));
    return;
  end if;
  select net.http_post(
    url := v_url || '/functions/v1/detect-unusual-activity',
    headers := jsonb_build_object('Authorization','Bearer ' || v_key,'Content-Type','application/json'),
    timeout_milliseconds := 60000
  ) into v_req_id;
  perform public.job_run_finish(v_run_id, 'SUCCESS', jsonb_build_object('net_request_id', v_req_id, 'note','dispatched, menunggu reconcile'));
end;
$$;


ALTER FUNCTION "public"."trigger_detect_unusual_activity"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_evaluate_signals"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_url text;
  v_key text;
  v_secret text;
  v_run_id uuid;
  v_req_id bigint;
BEGIN
  v_run_id := public.job_run_start('evaluate-signals');

  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'worker_shared_secret';

  IF v_url IS NULL OR v_key IS NULL THEN
    PERFORM public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('reason', 'vault secrets belum diset'));
    RETURN;
  END IF;

  SELECT net.http_post(
    url := v_url || '/functions/v1/evaluate-signals',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json', 'x-worker-secret', v_secret),
    timeout_milliseconds := 120000
  ) INTO v_req_id;

  PERFORM public.job_run_finish(v_run_id, 'SUCCESS', jsonb_build_object('net_request_id', v_req_id, 'note', 'dispatched, menunggu reconcile'));
END;
$$;


ALTER FUNCTION "public"."trigger_evaluate_signals"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_fetch_earnings_calendar"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_url text; v_key text; v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'worker_shared_secret';
  IF v_url IS NULL OR v_key IS NULL OR v_secret IS NULL THEN
    RAISE WARNING 'fetch-earnings-calendar: secret belum lengkap'; RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_url || '/functions/v1/fetch-earnings-calendar',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json', 'x-worker-secret', v_secret)
  );
END; $$;


ALTER FUNCTION "public"."trigger_fetch_earnings_calendar"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_fetch_economic_calendar"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
  v_url text;
  v_key text;
  v_secret text;
  v_run_id uuid;
  v_req_id bigint;
BEGIN
  v_run_id := public.job_run_start('fetch-economic-calendar');

  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'worker_shared_secret';

  IF v_url IS NULL OR v_key IS NULL OR v_secret IS NULL THEN
    PERFORM public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('reason', 'secret belum lengkap'));
    RETURN;
  END IF;

  SELECT net.http_post(
    url := v_url || '/functions/v1/fetch-economic-calendar',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_key,
      'Content-Type', 'application/json',
      'x-worker-secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) INTO v_req_id;

  PERFORM public.job_run_finish(v_run_id, 'SUCCESS', jsonb_build_object('net_request_id', v_req_id, 'note', 'dispatched, menunggu reconcile'));
END;
$$;


ALTER FUNCTION "public"."trigger_fetch_economic_calendar"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_fetch_fundamentals"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_url text; v_key text; v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'worker_shared_secret';
  IF v_url IS NULL OR v_key IS NULL OR v_secret IS NULL THEN
    RAISE WARNING 'fetch-fundamentals: secret belum lengkap'; RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_url || '/functions/v1/fetch-fundamentals',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json', 'x-worker-secret', v_secret)
  );
END; $$;


ALTER FUNCTION "public"."trigger_fetch_fundamentals"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_fetch_index"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_url text;
  v_key text;
  v_run_id uuid;
  v_req_id bigint;
BEGIN
  v_run_id := public.job_run_start('fetch-index');

  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF v_url IS NULL OR v_key IS NULL THEN
    PERFORM public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('reason', 'vault secrets belum diset'));
    RETURN;
  END IF;

  SELECT net.http_post(
    url := v_url || '/functions/v1/fetch-index',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) INTO v_req_id;

  PERFORM public.job_run_finish(v_run_id, 'SUCCESS', jsonb_build_object('net_request_id', v_req_id, 'note', 'dispatched, menunggu reconcile'));
END;
$$;


ALTER FUNCTION "public"."trigger_fetch_index"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_fetch_ipo_calendar"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_url text; v_key text; v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'worker_shared_secret';
  IF v_url IS NULL OR v_key IS NULL OR v_secret IS NULL THEN
    RAISE WARNING 'fetch-ipo-calendar: secret belum lengkap'; RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_url || '/functions/v1/fetch-ipo-calendar',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json', 'x-worker-secret', v_secret)
  );
END; $$;


ALTER FUNCTION "public"."trigger_fetch_ipo_calendar"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_fetch_news"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_url text; v_key text; v_run_id uuid; v_req_id bigint;
begin
  v_run_id := public.job_run_start('fetch-news');
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then
    perform public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('reason','vault secrets belum diset'));
    return;
  end if;
  select net.http_post(
    url := v_url || '/functions/v1/fetch-news',
    headers := jsonb_build_object('Authorization','Bearer ' || v_key,'Content-Type','application/json'),
    timeout_milliseconds := 120000
  ) into v_req_id;
  perform public.job_run_finish(v_run_id, 'SUCCESS', jsonb_build_object('net_request_id', v_req_id, 'note','dispatched, menunggu reconcile'));
end;
$$;


ALTER FUNCTION "public"."trigger_fetch_news"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_fetch_news"("p_scope" "text" DEFAULT 'all'::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_url text; v_key text; v_run_id uuid; v_req_id bigint;
begin
  v_run_id := public.job_run_start('fetch-news-' || p_scope);
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then
    perform public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('reason','vault secrets belum diset'));
    return;
  end if;
  select net.http_post(
    url := v_url || '/functions/v1/fetch-news?scope=' || p_scope,
    headers := jsonb_build_object('Authorization','Bearer ' || v_key,'Content-Type','application/json'),
    timeout_milliseconds := 120000
  ) into v_req_id;
  perform public.job_run_finish(v_run_id, 'SUCCESS', jsonb_build_object('net_request_id', v_req_id, 'note','dispatched, menunggu reconcile'));
end;
$$;


ALTER FUNCTION "public"."trigger_fetch_news"("p_scope" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_fetch_quotes"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_url text;
  v_key text;
  v_secret text;
  v_run_id uuid;
  v_req_id bigint;
BEGIN
  v_run_id := public.job_run_start('fetch-quotes');

  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'worker_shared_secret';

  IF v_url IS NULL OR v_key IS NULL THEN
    PERFORM public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('reason', 'vault secrets belum diset'));
    RETURN;
  END IF;

  SELECT net.http_post(
    url := v_url || '/functions/v1/fetch-quotes',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_key,
      'Content-Type', 'application/json',
      'x-worker-secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) INTO v_req_id;

  PERFORM public.job_run_finish(v_run_id, 'SUCCESS', jsonb_build_object('net_request_id', v_req_id, 'note', 'dispatched, menunggu reconcile'));
END;
$$;


ALTER FUNCTION "public"."trigger_fetch_quotes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_generate_signal_reasoning"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
  SELECT net.http_post(
    url := v_url || '/functions/v1/generate-signal-reasoning?limit=15',
    headers := jsonb_build_object('Authorization','Bearer ' || v_key,'Content-Type','application/json','x-worker-secret', v_secret),
    timeout_milliseconds := 90000
  ) INTO v_req_id;
  PERFORM public.job_run_finish(v_run_id, 'SUCCESS', jsonb_build_object('net_request_id', v_req_id, 'note', 'dispatched, menunggu reconcile'));
END;
$$;


ALTER FUNCTION "public"."trigger_generate_signal_reasoning"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_generate_trending_reason"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_url text; v_key text; v_secret text; v_run_id uuid; v_req_id bigint;
BEGIN
  v_run_id := public.job_run_start('generate-trending-reason');
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'worker_shared_secret';
  IF v_url IS NULL OR v_key IS NULL OR v_secret IS NULL THEN
    PERFORM public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('reason', 'vault/internal secrets belum diset'));
    RETURN;
  END IF;
  SELECT net.http_post(
    url := v_url || '/functions/v1/generate-trending-reason?limit=10',
    headers := jsonb_build_object('Authorization','Bearer ' || v_key,'Content-Type','application/json','x-worker-secret', v_secret),
    timeout_milliseconds := 90000
  ) INTO v_req_id;
  PERFORM public.job_run_finish(v_run_id, 'SUCCESS', jsonb_build_object('net_request_id', v_req_id, 'note', 'dispatched, menunggu reconcile'));
END;
$$;


ALTER FUNCTION "public"."trigger_generate_trending_reason"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_master_sync_stock"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_run_id uuid;
  v_result jsonb;
BEGIN
  v_run_id := public.job_run_start('master-sync-stock');
  BEGIN
    v_result := public.sync_stock_master();
    PERFORM public.job_run_finish(v_run_id, 'SUCCESS', v_result);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('error', SQLERRM));
  END;
END;
$$;


ALTER FUNCTION "public"."trigger_master_sync_stock"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_morning_briefing"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."trigger_morning_briefing"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_process_corporate_actions"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_run_id uuid;
  v_result jsonb;
BEGIN
  v_run_id := public.job_run_start('process-corporate-actions');
  BEGIN
    v_result := public.process_pending_corporate_actions();
    PERFORM public.job_run_finish(v_run_id, 'SUCCESS', v_result);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('error', SQLERRM));
  END;
END;
$$;


ALTER FUNCTION "public"."trigger_process_corporate_actions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_signal_pipeline_mtf"("p_tier" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_url text; v_key text; v_secret text; v_headers jsonb;
  v_run_id uuid; v_req bigint; v_timeframes text[]; v_existing int;
BEGIN
  IF p_tier NOT IN ('daily','swing') THEN
    RAISE EXCEPTION 'tier tidak dikenal: %', p_tier;
  END IF;

  SELECT count(*) INTO v_existing FROM public.mtf_pipeline_runs WHERE tier = p_tier AND status = 'RUNNING';
  IF v_existing > 0 THEN
    RETURN;
  END IF;

  -- Spec v4.2 section 5.2: H1/H4 dihapus dari engine. Daily = D1 saja. Swing tetap D1+W1.
  v_timeframes := CASE WHEN p_tier='daily' THEN ARRAY['D1'] ELSE ARRAY['D1','W1'] END;
  v_run_id := public.job_run_start('signal-pipeline-mtf-' || p_tier);

  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'worker_shared_secret';
  IF v_url IS NULL OR v_key IS NULL THEN
    PERFORM public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('reason','vault secrets belum diset'));
    RETURN;
  END IF;
  v_headers := jsonb_build_object('Authorization','Bearer '||v_key,'Content-Type','application/json','x-worker-secret',v_secret);

  SELECT net.http_post(
    url := v_url || '/functions/v1/fetch-candles?timeframe=' || v_timeframes[1] || '&offset=0&limit=100',
    headers := v_headers, timeout_milliseconds := 240000
  ) INTO v_req;

  INSERT INTO public.mtf_pipeline_runs(tier, status, stage, timeframes, tf_index, offset_val, pending_request_id, job_run_id, detail)
  VALUES (p_tier, 'RUNNING', 'fetch-candles', v_timeframes, 1, 0, v_req, v_run_id, jsonb_build_object('timeframe', v_timeframes[1]));
END;
$$;


ALTER FUNCTION "public"."trigger_signal_pipeline_mtf"("p_tier" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_trending_score"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_run_id uuid;
BEGIN
  v_run_id := public.job_run_start('trending-score');
  BEGIN
    PERFORM public.calculate_trending_scores();
    PERFORM public.job_run_finish(v_run_id, 'SUCCESS');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('error', SQLERRM));
  END;
END;
$$;


ALTER FUNCTION "public"."trigger_trending_score"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_unusual_activity_detection"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_run_id uuid;
BEGIN
  v_run_id := public.job_run_start('unusual-activity-detector');
  BEGIN
    PERFORM public.detect_unusual_activity();
    PERFORM public.job_run_finish(v_run_id, 'SUCCESS');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.job_run_finish(v_run_id, 'ERROR', jsonb_build_object('error', SQLERRM));
  END;
END;
$$;


ALTER FUNCTION "public"."trigger_unusual_activity_detection"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unlock_signal_with_ad"("p_stock_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
                                                                                                                                                                                                                            declare
                                                                                                                                                                                                                              v_user       uuid := auth.uid();
                                                                                                                                                                                                                                v_wallet     public.token_wallets;
                                                                                                                                                                                                                                  v_today      date := (now() at time zone 'Asia/Jakarta')::date;
                                                                                                                                                                                                                                    v_is_premium boolean;
                                                                                                                                                                                                                                    begin
                                                                                                                                                                                                                                      if v_user is null then
                                                                                                                                                                                                                                          raise exception 'NOT_AUTHENTICATED';
                                                                                                                                                                                                                                            end if;

                                                                                                                                                                                                                                              select coalesce(is_premium, false) into v_is_premium from public.profiles where id = v_user;
                                                                                                                                                                                                                                                if v_is_premium then
                                                                                                                                                                                                                                                    raise exception 'PREMIUM_NO_ADS_NEEDED';
                                                                                                                                                                                                                                                      end if;

                                                                                                                                                                                                                                                        v_wallet := public.ensure_wallet_current(v_user);

                                                                                                                                                                                                                                                          if exists (
                                                                                                                                                                                                                                                              select 1 from public.signal_unlocks
                                                                                                                                                                                                                                                                  where user_id = v_user and stock_id = p_stock_id and unlock_date = v_today
                                                                                                                                                                                                                                                                    ) then
                                                                                                                                                                                                                                                                        return jsonb_build_object('status', 'ok', 'already_unlocked', true);
                                                                                                                                                                                                                                                                          end if;

                                                                                                                                                                                                                                                                            if v_wallet.ad_unlock_count >= 3 then
                                                                                                                                                                                                                                                                                raise exception 'AD_LIMIT_REACHED';
                                                                                                                                                                                                                                                                                  end if;

                                                                                                                                                                                                                                                                                    update public.token_wallets
                                                                                                                                                                                                                                                                                        set ad_unlock_count = ad_unlock_count + 1
                                                                                                                                                                                                                                                                                            where id = v_wallet.id;

                                                                                                                                                                                                                                                                                              insert into public.token_transactions (wallet_id, amount, type, reference_id)
                                                                                                                                                                                                                                                                                                  values (v_wallet.id, 0, 'AD_UNLOCK', p_stock_id);

                                                                                                                                                                                                                                                                                                    insert into public.signal_unlocks (user_id, stock_id, unlock_date, source)
                                                                                                                                                                                                                                                                                                        values (v_user, p_stock_id, v_today, 'AD')
                                                                                                                                                                                                                                                                                                            on conflict (user_id, stock_id, unlock_date) do nothing;

                                                                                                                                                                                                                                                                                                              return jsonb_build_object('status', 'ok', 'ad_unlock_count', v_wallet.ad_unlock_count + 1);
                                                                                                                                                                                                                                                                                                              end;
                                                                                                                                                                                                                                                                                                              $$;


ALTER FUNCTION "public"."unlock_signal_with_ad"("p_stock_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unlock_signal_with_token"("p_stock_id" "uuid", "p_idempotency_key" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user   uuid := auth.uid();
  v_wallet public.token_wallets;
  v_today  date := (now() at time zone 'Asia/Jakarta')::date;
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  if exists (
      select 1 from public.token_transactions
      where reference_id = p_idempotency_key and type = 'SIGNAL_UNLOCK'
    ) then
      return jsonb_build_object('status', 'ok', 'already_processed', true);
  end if;

  v_wallet := public.ensure_wallet_current(v_user);

  if exists (
      select 1 from public.signal_unlocks
      where user_id = v_user and stock_id = p_stock_id and unlock_date = v_today
    ) then
      return jsonb_build_object('status', 'ok', 'already_unlocked', true, 'balance', v_wallet.balance);
  end if;

  if v_wallet.balance < 1 then
    raise exception 'INSUFFICIENT_TOKENS';
  end if;

  update public.token_wallets set balance = balance - 1 where id = v_wallet.id;

  insert into public.token_transactions (wallet_id, amount, type, reference_id, balance_before, balance_after)
  values (v_wallet.id, -1, 'SIGNAL_UNLOCK', p_idempotency_key, v_wallet.balance, v_wallet.balance - 1);

  insert into public.signal_unlocks (user_id, stock_id, unlock_date, source)
  values (v_user, p_stock_id, v_today, 'TOKEN')
  on conflict (user_id, stock_id, unlock_date) do nothing;

  return jsonb_build_object('status', 'ok', 'balance', v_wallet.balance - 1);
end;
$$;


ALTER FUNCTION "public"."unlock_signal_with_token"("p_stock_id" "uuid", "p_idempotency_key" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."wait_for_net_response"("p_request_id" bigint, "p_max_wait_seconds" integer DEFAULT 100) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_row net._http_response%ROWTYPE;
  v_waited integer := 0;
BEGIN
  LOOP
    SELECT * INTO v_row FROM net._http_response WHERE id = p_request_id;
    IF FOUND THEN
      IF v_row.error_msg IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'status_code', v_row.status_code, 'error_msg', v_row.error_msg);
      ELSIF v_row.status_code IS NOT NULL AND v_row.status_code >= 200 AND v_row.status_code < 300 THEN
        RETURN jsonb_build_object('ok', true, 'status_code', v_row.status_code, 'content', left(v_row.content, 2000));
      ELSE
        RETURN jsonb_build_object('ok', false, 'status_code', v_row.status_code, 'content', left(v_row.content, 2000));
      END IF;
    END IF;
    IF v_waited >= p_max_wait_seconds THEN
      RETURN jsonb_build_object('ok', false, 'error_msg', 'timeout menunggu net response setelah ' || p_max_wait_seconds || 's', 'timed_out', true);
    END IF;
    PERFORM pg_sleep(1);
    v_waited := v_waited + 1;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."wait_for_net_response"("p_request_id" bigint, "p_max_wait_seconds" integer) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ad_verifications" (
    "transaction_id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "stock_id" "uuid" NOT NULL,
    "reward_item" "text",
    "reward_amount" numeric,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ad_verifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agreement_acceptances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "agreement_id" "uuid" NOT NULL,
    "accepted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agreement_acceptances" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agreements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "version" "text" NOT NULL,
    "content" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agreements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text",
    "image_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text"])))
);


ALTER TABLE "public"."ai_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "task_type" "text" NOT NULL,
    "prompt_text" "text" NOT NULL,
    "parameters" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "schedule" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "status" "text" DEFAULT 'ACTIVE'::"text" NOT NULL,
    "last_run" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "action" "text",
    "input" "jsonb" DEFAULT '{}'::"jsonb",
    "permission_decision" "text" DEFAULT 'PENDING'::"text",
    "confirmation_required" boolean DEFAULT false NOT NULL,
    "result" "jsonb",
    "audit_id" "uuid",
    "completed_at" timestamp with time zone,
    CONSTRAINT "ai_tasks_action_check" CHECK ((("action" IS NULL) OR ("action" = ANY (ARRAY['READ_MARKET_DATA'::"text", 'READ_WATCHLIST'::"text", 'READ_SIGNALS'::"text", 'READ_NEWS'::"text", 'CREATE_TRADING_PLAN'::"text", 'UPDATE_WATCHLIST'::"text", 'CREATE_ALERT'::"text", 'SEND_NOTIFICATION'::"text"])))),
    CONSTRAINT "ai_tasks_permission_decision_check" CHECK (("permission_decision" = ANY (ARRAY['ALLOW'::"text", 'DENY'::"text", 'PENDING'::"text"]))),
    CONSTRAINT "ai_tasks_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'PAUSED'::"text", 'DONE'::"text", 'FAILED'::"text"]))),
    CONSTRAINT "ai_tasks_task_type_check" CHECK (("task_type" = ANY (ARRAY['PRICE_ALERT'::"text", 'LEVEL_RETEST'::"text", 'DAILY_SUMMARY'::"text", 'UNUSUAL_VOLUME'::"text"])))
);


ALTER TABLE "public"."ai_tasks" OWNER TO "postgres";


COMMENT ON COLUMN "public"."ai_tasks"."action" IS 'Deny-by-default permission scope untuk AI Task, sesuai spec v4.1 section 71. Tidak ada FULL_ACCOUNT_ACCESS.';



COMMENT ON COLUMN "public"."ai_tasks"."permission_decision" IS 'Keputusan permission check saat task dieksekusi -- ALLOW/DENY/PENDING';



CREATE TABLE IF NOT EXISTS "public"."ai_threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_threads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_usage" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "thread_id" "uuid",
    "worker" "text" NOT NULL,
    "model" "text",
    "tokens_input" integer,
    "tokens_output" integer,
    "estimated_cost" numeric,
    "request_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_usage" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_ratings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "rating" integer NOT NULL,
    "comment" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "app_ratings_rating_check" CHECK ((("rating" >= 1) AND ("rating" <= 5)))
);


ALTER TABLE "public"."app_ratings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_id" "uuid",
    "action" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid",
    "detail" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "before_hash" "text",
    "after_hash" "text",
    "reason" "text",
    "request_id" "uuid"
);


ALTER TABLE "public"."audit_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."backtest_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "formula_version" "text" NOT NULL,
    "timeframe" "text" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "universe" "text" DEFAULT 'LQ45'::"text" NOT NULL,
    "total_stocks" integer NOT NULL,
    "total_trades" integer NOT NULL,
    "wins" integer NOT NULL,
    "losses" integer NOT NULL,
    "timeouts" integer NOT NULL,
    "win_rate" numeric NOT NULL,
    "profit_factor" numeric,
    "max_drawdown_pct" numeric NOT NULL,
    "gross_profit" numeric NOT NULL,
    "gross_loss" numeric NOT NULL,
    "passed" boolean NOT NULL,
    "fail_reasons" "text"[],
    "trade_log" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "breakevens" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "backtest_runs_timeframe_check" CHECK (("timeframe" = ANY (ARRAY['H1'::"text", 'H4'::"text", 'D1'::"text", 'W1'::"text"])))
);


ALTER TABLE "public"."backtest_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bug_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "description" "text" NOT NULL,
    "status" "text" DEFAULT 'OPEN'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bug_reports_status_check" CHECK (("status" = ANY (ARRAY['OPEN'::"text", 'IN_PROGRESS'::"text", 'RESOLVED'::"text", 'WONT_FIX'::"text"])))
);


ALTER TABLE "public"."bug_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."candles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stock_id" "uuid" NOT NULL,
    "timeframe" "text" NOT NULL,
    "ts" timestamp with time zone NOT NULL,
    "open" numeric NOT NULL,
    "high" numeric NOT NULL,
    "low" numeric NOT NULL,
    "close" numeric NOT NULL,
    "volume" numeric,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "source" "text" DEFAULT 'YAHOO'::"text",
    CONSTRAINT "candles_timeframe_check" CHECK (("timeframe" = ANY (ARRAY['H1'::"text", 'H4'::"text", 'D1'::"text", 'W1'::"text"])))
);


ALTER TABLE "public"."candles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chart_analyses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "stock_id" "uuid",
    "image_url" "text" NOT NULL,
    "ai_description" "text",
    "pattern_detected" "text",
    "support_level" numeric,
    "resistance_level" numeric,
    "engine_entry" numeric,
    "engine_sl" numeric,
    "engine_tp" numeric,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."chart_analyses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."corporate_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stock_id" "uuid" NOT NULL,
    "action_type" "text" NOT NULL,
    "ratio" numeric,
    "ex_date" "date" NOT NULL,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    CONSTRAINT "corporate_actions_action_type_check" CHECK (("action_type" = ANY (ARRAY['SPLIT'::"text", 'REVERSE_SPLIT'::"text", 'RIGHT_ISSUE'::"text", 'DELISTING'::"text", 'SUSPENSION'::"text"]))),
    CONSTRAINT "corporate_actions_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'PROCESSED'::"text"])))
);


ALTER TABLE "public"."corporate_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."earnings_calendar" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stock_id" "uuid",
    "quarter" integer NOT NULL,
    "year" integer NOT NULL,
    "announcement_date" "date" NOT NULL,
    "estimated_eps" numeric,
    "actual_eps" numeric,
    "status" "text" DEFAULT 'SCHEDULED'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "earnings_calendar_status_check" CHECK (("status" = ANY (ARRAY['SCHEDULED'::"text", 'RELEASED'::"text", 'DELAYED'::"text"])))
);


ALTER TABLE "public"."earnings_calendar" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."economic_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_name" "text" NOT NULL,
    "country" "text" NOT NULL,
    "event_date" "date" NOT NULL,
    "event_time" time without time zone,
    "impact" "text",
    "actual" "text",
    "forecast" "text",
    "previous" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "economic_events_impact_check" CHECK (("impact" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text"])))
);


ALTER TABLE "public"."economic_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."feature_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "description" "text" NOT NULL,
    "status" "text" DEFAULT 'OPEN'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "feature_requests_status_check" CHECK (("status" = ANY (ARRAY['OPEN'::"text", 'PLANNED'::"text", 'SHIPPED'::"text", 'DECLINED'::"text"])))
);


ALTER TABLE "public"."feature_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."foreign_flow" (
    "date" "date" DEFAULT (("now"() AT TIME ZONE 'Asia/Jakarta'::"text"))::"date" NOT NULL,
    "net_value" numeric DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."foreign_flow" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fundamentals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stock_id" "uuid" NOT NULL,
    "pe_ratio" numeric,
    "pb_ratio" numeric,
    "net_profit" numeric,
    "market_cap" numeric,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."fundamentals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."golden_test_cases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_code" "text" NOT NULL,
    "category" "text" NOT NULL,
    "description" "text" NOT NULL,
    "formula_version" "text" DEFAULT 'structural_v1'::"text" NOT NULL,
    "input_snapshot" "jsonb",
    "expected_structure" "jsonb",
    "expected_confluence" "jsonb",
    "expected_signal" "jsonb",
    "expected_levels" "jsonb",
    "expected_lifecycle" "jsonb",
    "expected_evidence" "jsonb",
    "status" "text" DEFAULT 'NOT_POPULATED'::"text" NOT NULL,
    "last_run_at" timestamp with time zone,
    "last_run_result" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "golden_test_cases_case_code_check" CHECK (("case_code" ~ '^GOLDEN-[0-9]{3}$'::"text")),
    CONSTRAINT "golden_test_cases_status_check" CHECK (("status" = ANY (ARRAY['NOT_POPULATED'::"text", 'READY'::"text", 'PASSING'::"text", 'FAILING'::"text"])))
);


ALTER TABLE "public"."golden_test_cases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."idx_eod_uploads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trade_date" "date" NOT NULL,
    "uploaded_by" "uuid",
    "file_name" "text",
    "row_count" integer,
    "matched_count" integer,
    "unmatched_tickers" "text"[],
    "status" "text" DEFAULT 'PROCESSED'::"text" NOT NULL,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."idx_eod_uploads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."indicators" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stock_id" "uuid" NOT NULL,
    "timeframe" "text" NOT NULL,
    "ts" timestamp with time zone NOT NULL,
    "ema5" numeric,
    "ema9" numeric,
    "ema21" numeric,
    "ema50" numeric,
    "rsi14" numeric,
    "macd_line" numeric,
    "macd_signal" numeric,
    "macd_hist" numeric,
    "stoch_k" numeric,
    "stoch_d" numeric,
    "volume_avg20" numeric,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "indicators_timeframe_check" CHECK (("timeframe" = ANY (ARRAY['H1'::"text", 'H4'::"text", 'D1'::"text", 'W1'::"text"])))
);


ALTER TABLE "public"."indicators" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."internal_secrets" (
    "key" "text" NOT NULL,
    "value" "text" NOT NULL
);


ALTER TABLE "public"."internal_secrets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."intraday_evaluations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "signal_id" "uuid" NOT NULL,
    "candle_id" "uuid",
    "checked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "price_high" numeric,
    "price_low" numeric,
    "hit_tp1" boolean DEFAULT false,
    "hit_tp2" boolean DEFAULT false,
    "hit_sl" boolean DEFAULT false,
    "ambiguous_same_candle" boolean DEFAULT false,
    "resolution_rule" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."intraday_evaluations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ipo_calendar" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_name" "text" NOT NULL,
    "ticker" "text",
    "opening_date" "date",
    "closing_date" "date",
    "listing_date" "date",
    "price_range_low" numeric,
    "price_range_high" numeric,
    "status" "text" DEFAULT 'UPCOMING'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ipo_calendar_status_check" CHECK (("status" = ANY (ARRAY['UPCOMING'::"text", 'OPEN'::"text", 'CLOSED'::"text", 'LISTED'::"text", 'CANCELLED'::"text"])))
);


ALTER TABLE "public"."ipo_calendar" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_name" "text" NOT NULL,
    "status" "text" NOT NULL,
    "detail" "jsonb",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    CONSTRAINT "job_runs_status_check" CHECK (("status" = ANY (ARRAY['RUNNING'::"text", 'SUCCESS'::"text", 'ERROR'::"text"])))
);


ALTER TABLE "public"."job_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."market_calendar" (
    "date" "date" NOT NULL,
    "is_trading_day" boolean DEFAULT true NOT NULL,
    "session_open" time without time zone,
    "session_close" time without time zone,
    "holiday_name" "text"
);


ALTER TABLE "public"."market_calendar" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."market_index" (
    "ticker" "text" NOT NULL,
    "name" "text" NOT NULL,
    "value" numeric,
    "previous_close" numeric,
    "day_high" numeric,
    "day_low" numeric,
    "quality" "text" DEFAULT 'FRESH'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "market_index_quality_check" CHECK (("quality" = ANY (ARRAY['FRESH'::"text", 'STALE'::"text", 'MISSING'::"text", 'INVALID'::"text"])))
);


ALTER TABLE "public"."market_index" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mtf_pipeline_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tier" "text" NOT NULL,
    "status" "text" DEFAULT 'RUNNING'::"text" NOT NULL,
    "stage" "text" NOT NULL,
    "timeframes" "text"[] NOT NULL,
    "tf_index" integer DEFAULT 1 NOT NULL,
    "pending_request_id" bigint NOT NULL,
    "job_run_id" "uuid" NOT NULL,
    "detail" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "offset_val" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."mtf_pipeline_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."news" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "summary" "text",
    "source" "text",
    "url" "text",
    "category" "text" NOT NULL,
    "sentiment" "text",
    "related_tickers" "text"[] DEFAULT '{}'::"text"[],
    "published_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "news_category_check" CHECK (("category" = ANY (ARRAY['global'::"text", 'domestic'::"text"]))),
    CONSTRAINT "news_sentiment_check" CHECK (("sentiment" = ANY (ARRAY['positive'::"text", 'neutral'::"text", 'negative'::"text"])))
);


ALTER TABLE "public"."news" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."news_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stock_id" "uuid",
    "event_type" "text",
    "impact_classification" "text",
    "primary_article_id" "uuid",
    "related_article_ids" "uuid"[] DEFAULT '{}'::"uuid"[],
    "evidence_summary" "text",
    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "news_events_impact_classification_check" CHECK (("impact_classification" = ANY (ARRAY['POTENTIALLY_POSITIVE'::"text", 'POTENTIALLY_NEGATIVE'::"text", 'MIXED_UNCLEAR'::"text", 'INFORMATIONAL'::"text"])))
);


ALTER TABLE "public"."news_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."news_issuer_mapping" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "article_id" "uuid" NOT NULL,
    "stock_id" "uuid" NOT NULL,
    "mapping_method" "text" NOT NULL,
    "mapping_confidence" "text" DEFAULT 'MEDIUM'::"text" NOT NULL,
    "impact" "text" DEFAULT 'INFORMATIONAL'::"text" NOT NULL,
    "source_evidence" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "news_issuer_mapping_impact_check" CHECK (("impact" = ANY (ARRAY['POTENTIALLY_POSITIVE'::"text", 'POTENTIALLY_NEGATIVE'::"text", 'MIXED_UNCLEAR'::"text", 'INFORMATIONAL'::"text"]))),
    CONSTRAINT "news_issuer_mapping_mapping_confidence_check" CHECK (("mapping_confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text"]))),
    CONSTRAINT "news_issuer_mapping_mapping_method_check" CHECK (("mapping_method" = ANY (ARRAY['EXPLICIT_TICKER'::"text", 'EXPLICIT_ISSUER_NAME'::"text", 'CORPORATE_ACTION'::"text", 'ENTITY_MATCH'::"text", 'INDUSTRY_CONTEXT'::"text", 'LOCATION_CONTEXT'::"text"])))
);


ALTER TABLE "public"."news_issuer_mapping" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_preferences" (
    "user_id" "uuid" NOT NULL,
    "master_enabled" boolean DEFAULT true NOT NULL,
    "market_alerts" boolean DEFAULT true NOT NULL,
    "signal_alerts" boolean DEFAULT true NOT NULL,
    "news_updates" boolean DEFAULT true NOT NULL,
    "economic_events" boolean DEFAULT true NOT NULL,
    "morning_briefing" boolean DEFAULT true NOT NULL,
    "unusual_activity_alert" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notification_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "category" "text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text",
    "reference_id" "uuid",
    "is_read" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "event_id" "text",
    CONSTRAINT "notifications_category_check" CHECK (("category" = ANY (ARRAY['MARKET'::"text", 'SIGNAL'::"text", 'NEWS'::"text", 'ECONOMIC_EVENT'::"text", 'MORNING_BRIEFING'::"text", 'UNUSUAL_ACTIVITY'::"text", 'SUBSCRIPTION'::"text"])))
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "external_event_id" "text" NOT NULL,
    "payment_id" "uuid",
    "payload" "jsonb" NOT NULL,
    "processed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."payment_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "subscription_id" "uuid",
    "amount" numeric NOT NULL,
    "method" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "external_payment_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payments_method_check" CHECK (("method" = ANY (ARRAY['QRIS'::"text", 'VA_BANK'::"text", 'DANA'::"text", 'OVO'::"text", 'GOPAY'::"text", 'SHOPEEPAY'::"text"]))),
    CONSTRAINT "payments_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'success'::"text", 'expired'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text",
    "risk_profile" "text",
    "is_premium" boolean DEFAULT false,
    "deleted_at" timestamp with time zone,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "is_admin" boolean DEFAULT false NOT NULL,
    CONSTRAINT "profiles_risk_profile_check" CHECK (("risk_profile" = ANY (ARRAY['konservatif'::"text", 'moderat'::"text", 'agresif'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_health" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider" "text" NOT NULL,
    "status" "text" NOT NULL,
    "latency_ms" integer,
    "detail" "jsonb",
    "checked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "provider_health_status_check" CHECK (("status" = ANY (ARRAY['UP'::"text", 'DEGRADED'::"text", 'DOWN'::"text"])))
);


ALTER TABLE "public"."provider_health" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."push_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "endpoint" "text" NOT NULL,
    "p256dh" "text" NOT NULL,
    "auth" "text" NOT NULL,
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."push_subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."quotes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stock_id" "uuid" NOT NULL,
    "price" numeric,
    "previous_close" numeric,
    "day_high" numeric,
    "day_low" numeric,
    "volume" numeric,
    "market_time" timestamp with time zone,
    "quality" "text" DEFAULT 'FRESH'::"text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "market_cap" numeric,
    "source" "text" DEFAULT 'YAHOO'::"text",
    CONSTRAINT "quotes_quality_check" CHECK (("quality" = ANY (ARRAY['FRESH'::"text", 'STALE'::"text", 'MISSING'::"text", 'INVALID'::"text"])))
);


ALTER TABLE "public"."quotes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."saved_signals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "signal_snapshot" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."saved_signals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sector_rotation_scores" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sector_id" "uuid" NOT NULL,
    "as_of_date" "date" NOT NULL,
    "relative_strength" numeric NOT NULL,
    "momentum" numeric NOT NULL,
    "label" "text" NOT NULL,
    "avg_return_5d" numeric,
    "avg_volume_change_5d" numeric,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sector_rotation_scores_label_check" CHECK (("label" = ANY (ARRAY['LEADING'::"text", 'IMPROVING'::"text", 'WEAKENING'::"text", 'LAGGING'::"text"])))
);


ALTER TABLE "public"."sector_rotation_scores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sectors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."sectors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."security_acceptance_checks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "threat" "text" NOT NULL,
    "expected_behavior" "text" NOT NULL,
    "test_status" "text" DEFAULT 'NOT_TESTED'::"text" NOT NULL,
    "last_tested_at" timestamp with time zone,
    "last_tested_by" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "security_acceptance_checks_test_status_check" CHECK (("test_status" = ANY (ARRAY['NOT_TESTED'::"text", 'PASS'::"text", 'FAIL'::"text"])))
);


ALTER TABLE "public"."security_acceptance_checks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signal_engine_versions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "formula_version" "text" NOT NULL,
    "timeframe" "text" NOT NULL,
    "backtest_run_id" "uuid",
    "is_approved" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "signal_engine_versions_timeframe_check" CHECK (("timeframe" = ANY (ARRAY['H1'::"text", 'H4'::"text", 'D1'::"text", 'W1'::"text"])))
);


ALTER TABLE "public"."signal_engine_versions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signal_evidence" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "signal_id" "uuid" NOT NULL,
    "structure" "jsonb",
    "support" "jsonb",
    "resistance" "jsonb",
    "trigger" "jsonb",
    "invalidation" "jsonb",
    "timeframes" "jsonb",
    "data_quality" "jsonb",
    "formula_version" "text",
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."signal_evidence" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signal_pipeline_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stock_id" "uuid",
    "tier" "text",
    "stage" "text" NOT NULL,
    "status" "text" NOT NULL,
    "detail" "jsonb",
    "job_run_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "signal_pipeline_events_stage_check" CHECK (("stage" = ANY (ARRAY['ingestion'::"text", 'quality'::"text", 'indicator'::"text", 'structure'::"text", 'confluence'::"text", 'signal'::"text", 'snapshot'::"text", 'notification'::"text"]))),
    CONSTRAINT "signal_pipeline_events_status_check" CHECK (("status" = ANY (ARRAY['OK'::"text", 'FAILED'::"text", 'SKIPPED'::"text"]))),
    CONSTRAINT "signal_pipeline_events_tier_check" CHECK (("tier" = ANY (ARRAY['daily'::"text", 'swing'::"text"])))
);


ALTER TABLE "public"."signal_pipeline_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signal_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "signal_id" "uuid" NOT NULL,
    "result" "text" NOT NULL,
    "r_multiple" numeric,
    "holding_minutes" integer,
    "evaluated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "signal_results_result_check" CHECK (("result" = ANY (ARRAY['WIN'::"text", 'LOSS'::"text", 'BREAKEVEN'::"text", 'INVALID'::"text"])))
);


ALTER TABLE "public"."signal_results" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signal_revisions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "original_signal_id" "uuid" NOT NULL,
    "requested_by" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "requested_changes" "jsonb" NOT NULL,
    "approval_status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "new_signal_id" "uuid",
    "audit_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "signal_revisions_approval_status_check" CHECK (("approval_status" = ANY (ARRAY['PENDING'::"text", 'APPROVED'::"text", 'REJECTED'::"text"])))
);


ALTER TABLE "public"."signal_revisions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signal_unlocks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "stock_id" "uuid" NOT NULL,
    "unlock_date" "date" DEFAULT (("now"() AT TIME ZONE 'Asia/Jakarta'::"text"))::"date" NOT NULL,
    "source" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "signal_unlocks_source_check" CHECK (("source" = ANY (ARRAY['TOKEN'::"text", 'AD'::"text", 'PREMIUM'::"text"])))
);


ALTER TABLE "public"."signal_unlocks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stock_id" "uuid",
    "direction" "text",
    "entry_price" numeric,
    "buy_area_low" numeric,
    "buy_area_high" numeric,
    "tp1" numeric,
    "tp2" numeric,
    "stop_loss" numeric,
    "status" "text" DEFAULT 'ACTIVE'::"text",
    "ai_reasoning" "jsonb",
    "triggered_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "superseded_by" "uuid",
    "timeframe" "text",
    "risk_reward" numeric,
    "formula_version" "text" DEFAULT 'baseline_v1'::"text",
    "engine_version" "text" DEFAULT 'v1'::"text",
    "support_level" numeric,
    "resistance_level" numeric,
    "evidence" "jsonb",
    "expires_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "initial_stop_loss" numeric,
    "signal_tier" "text",
    "bias_timeframe" "text",
    "confirm_timeframe" "text",
    "entry_timeframe" "text",
    "bearish_type" "text",
    "bearish_trigger" numeric,
    "invalidation" numeric,
    "downside_support_1" numeric,
    "downside_support_2" numeric,
    "entry_type" "text",
    "trigger_state" "text",
    "overextension_status" "text",
    "tp1_reason" "text",
    "tp2_reason" "text",
    "support_zone_id" "uuid",
    "resistance_zone_id" "uuid",
    "tp1_zone_id" "uuid",
    "tp2_zone_id" "uuid",
    "data_source" "text" DEFAULT 'IDX'::"text",
    "effective_at" timestamp with time zone,
    "schema_version" "text" DEFAULT 'v1'::"text",
    "data_snapshot_id" "uuid",
    CONSTRAINT "signals_bearish_type_check" CHECK ((("bearish_type" IS NULL) OR ("bearish_type" = ANY (ARRAY['BEARISH_REJECTION'::"text", 'BEARISH_BREAKDOWN'::"text", 'BEARISH_DISTRIBUTION_INDICATION'::"text", 'BEARISH_CONTINUATION'::"text"])))),
    CONSTRAINT "signals_data_source_check" CHECK ((("data_source" IS NULL) OR ("data_source" = ANY (ARRAY['IDX'::"text", 'YAHOO_FALLBACK'::"text"])))),
    CONSTRAINT "signals_direction_check" CHECK (("direction" = ANY (ARRAY['BUY'::"text", 'SELL'::"text"]))),
    CONSTRAINT "signals_entry_type_check" CHECK ((("entry_type" IS NULL) OR ("entry_type" = ANY (ARRAY['AREA'::"text", 'TRIGGER'::"text", 'RETEST'::"text", 'SUPPORT'::"text"])))),
    CONSTRAINT "signals_overextension_status_check" CHECK ((("overextension_status" IS NULL) OR ("overextension_status" = ANY (ARRAY['NORMAL'::"text", 'OVEREXTENDED'::"text", 'UNKNOWN'::"text"])))),
    CONSTRAINT "signals_signal_tier_check" CHECK (("signal_tier" = ANY (ARRAY['daily'::"text", 'swing'::"text"]))),
    CONSTRAINT "signals_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'HIT_TP1'::"text", 'HIT_TP2'::"text", 'HIT_SL'::"text", 'HIT_SL_LOCKED'::"text", 'EXPIRED'::"text", 'INVALIDATED'::"text"]))),
    CONSTRAINT "signals_timeframe_check" CHECK (("timeframe" = ANY (ARRAY['H1'::"text", 'H4'::"text", 'D1'::"text", 'W1'::"text"]))),
    CONSTRAINT "signals_trigger_state_check" CHECK ((("trigger_state" IS NULL) OR ("trigger_state" = ANY (ARRAY['INTRABAR_TOUCH'::"text", 'BREAKOUT_CANDIDATE'::"text", 'BREAKOUT_CONFIRMED'::"text", 'FAILED_BREAKOUT'::"text", 'BREAKOUT_RETEST'::"text", 'BREAKDOWN_CANDIDATE'::"text", 'BREAKDOWN_CONFIRMED'::"text", 'FAILED_BREAKDOWN'::"text", 'BREAKDOWN_RETEST'::"text"]))))
);


ALTER TABLE "public"."signals" OWNER TO "postgres";


COMMENT ON COLUMN "public"."signals"."triggered_at" IS 'Waktu sinyal ini dibuat/di-generate (jangan ditimpa saat status berubah)';



COMMENT ON COLUMN "public"."signals"."resolved_at" IS 'Waktu status berubah jadi terminal (HIT_TP1/HIT_TP2/HIT_SL/EXPIRED/INVALIDATED)';



COMMENT ON COLUMN "public"."signals"."signal_tier" IS 'daily = evaluasi D1 saja (spec v4.2 section 5.2, H1/H4 dihapus dari engine). swing = D1+W1 confluence, holding beberapa minggu.';



COMMENT ON COLUMN "public"."signals"."bias_timeframe" IS 'timeframe penentu arah/bias utama (D1 untuk daily, W1 untuk swing) -- sumber TP1/TP2.';



COMMENT ON COLUMN "public"."signals"."confirm_timeframe" IS 'timeframe konfirmasi struktur menengah -- NULL untuk daily & swing sejak v4.2 (H1/H4 dihapus, tidak ada tahap confirm terpisah).';



COMMENT ON COLUMN "public"."signals"."entry_timeframe" IS 'timeframe timing entry -- D1 untuk daily & swing sejak v4.2 (sebelumnya H1 untuk daily, sudah dihapus).';



COMMENT ON COLUMN "public"."signals"."bearish_type" IS 'Tipe bearish untuk direction=SELL, sesuai spec v4.1 section 2.2';



COMMENT ON COLUMN "public"."signals"."bearish_trigger" IS 'Bearish trigger/area untuk direction=SELL';



COMMENT ON COLUMN "public"."signals"."invalidation" IS 'Invalidation level untuk direction=SELL (kondisi bearish batal)';



COMMENT ON COLUMN "public"."signals"."downside_support_1" IS 'Support downside berikutnya #1 untuk direction=SELL';



COMMENT ON COLUMN "public"."signals"."downside_support_2" IS 'Support downside berikutnya #2 untuk direction=SELL';



COMMENT ON COLUMN "public"."signals"."entry_type" IS 'Section 56.2: AREA/TRIGGER/RETEST/SUPPORT - sumber evidence entry';



COMMENT ON COLUMN "public"."signals"."trigger_state" IS 'Section 55: breakout/breakdown state machine snapshot saat signal dibuat';



COMMENT ON COLUMN "public"."signals"."overextension_status" IS 'Section 58: NORMAL/OVEREXTENDED/UNKNOWN, hanya menggerbang BUY';



COMMENT ON COLUMN "public"."signals"."tp1_reason" IS 'Alasan semantik saat tp1 null (setup gagal validasi TP)';



COMMENT ON COLUMN "public"."signals"."tp2_reason" IS 'Section 56.4: reason wajib ada saat tp2 null, mis. NO_VALID_SECOND_RESISTANCE';



COMMENT ON COLUMN "public"."signals"."effective_at" IS 'Section 8.4/8.5 spec v4.2: kapan sinyal mulai berlaku (sesi perdagangan berikutnya), beda dari triggered_at (waktu generate).';



COMMENT ON COLUMN "public"."signals"."schema_version" IS 'Section 25.2 spec v4.2: versi schema signal untuk release traceability.';



COMMENT ON COLUMN "public"."signals"."data_snapshot_id" IS 'Section 18.2 spec v4.2: referensi snapshot data pasar yang dipakai saat generate sinyal ini.';



CREATE OR REPLACE VIEW "public"."signals_public" WITH ("security_invoker"='true') AS
 SELECT "id",
    "stock_id",
    "direction",
    "timeframe",
    "status",
    "created_at",
    "resolved_at",
    "superseded_by",
    "signal_tier"
   FROM "public"."signals";


ALTER VIEW "public"."signals_public" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stocks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ticker" "text" NOT NULL,
    "name" "text" NOT NULL,
    "sector_id" "uuid",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "trending_score" numeric,
    "trending_label" "text",
    "trending_updated_at" timestamp with time zone,
    "trending_reason" "text"
);


ALTER TABLE "public"."stocks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."structure_labels" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stock_id" "uuid" NOT NULL,
    "timeframe" "text" NOT NULL,
    "label" "text" NOT NULL,
    "price" numeric,
    "source_candle_id" "uuid",
    "detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "formula_version" "text" NOT NULL,
    "evidence" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "structure_labels_label_check" CHECK (("label" = ANY (ARRAY['HH'::"text", 'HL'::"text", 'LH'::"text", 'LL'::"text", 'SWING_HIGH'::"text", 'SWING_LOW'::"text", 'SIDEWAYS'::"text", 'UNCLEAR'::"text"]))),
    CONSTRAINT "structure_labels_timeframe_check" CHECK (("timeframe" = ANY (ARRAY['H1'::"text", 'H4'::"text", 'D1'::"text", 'W1'::"text"])))
);


ALTER TABLE "public"."structure_labels" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."structure_zones" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stock_id" "uuid" NOT NULL,
    "timeframe" "text" NOT NULL,
    "zone_type" "text" NOT NULL,
    "price_low" numeric NOT NULL,
    "price_high" numeric NOT NULL,
    "mid_price" numeric GENERATED ALWAYS AS ((("price_low" + "price_high") / (2)::numeric)) STORED,
    "source_timeframe" "text" NOT NULL,
    "source_pivot_candle_ids" "uuid"[] NOT NULL,
    "touch_count" integer DEFAULT 1 NOT NULL,
    "retest_count" integer DEFAULT 0 NOT NULL,
    "strength_score" numeric NOT NULL,
    "strength" "text" NOT NULL,
    "age_in_bars" integer DEFAULT 0 NOT NULL,
    "formula_version" "text" NOT NULL,
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "structure_zones_age_in_bars_check" CHECK (("age_in_bars" >= 0)),
    CONSTRAINT "structure_zones_check" CHECK (("price_high" >= "price_low")),
    CONSTRAINT "structure_zones_retest_count_check" CHECK (("retest_count" >= 0)),
    CONSTRAINT "structure_zones_strength_check" CHECK (("strength" = ANY (ARRAY['WEAK'::"text", 'MODERATE'::"text", 'STRONG'::"text"]))),
    CONSTRAINT "structure_zones_timeframe_check" CHECK (("timeframe" = ANY (ARRAY['H1'::"text", 'H4'::"text", 'D1'::"text", 'W1'::"text"]))),
    CONSTRAINT "structure_zones_touch_count_check" CHECK (("touch_count" >= 1)),
    CONSTRAINT "structure_zones_zone_type_check" CHECK (("zone_type" = ANY (ARRAY['SUPPORT'::"text", 'RESISTANCE'::"text"])))
);


ALTER TABLE "public"."structure_zones" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "plan" "text" DEFAULT 'premium_monthly'::"text" NOT NULL,
    "period_start" timestamp with time zone,
    "period_end" timestamp with time zone,
    "cancel_at_period_end" boolean DEFAULT false NOT NULL,
    "grace_ends_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subscriptions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'pending_cancel'::"text", 'grace'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."token_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "wallet_id" "uuid",
    "amount" integer NOT NULL,
    "type" "text" NOT NULL,
    "reference_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "balance_before" integer,
    "balance_after" integer
);


ALTER TABLE "public"."token_transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."trading_plans" (
    "user_id" "uuid" NOT NULL,
    "module_1" "text",
    "module_2" "text",
    "module_3" "text",
    "module_4" "text",
    "module_5" "text",
    "module_6" "text",
    "module_7" "text",
    "module_8" "text",
    "module_9" "text",
    "module_10" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."trading_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."unusual_activities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stock_id" "uuid" NOT NULL,
    "timestamp" timestamp with time zone DEFAULT "now"() NOT NULL,
    "price" numeric NOT NULL,
    "volume" numeric NOT NULL,
    "avg_volume_20d" numeric NOT NULL,
    "price_change_percent" numeric NOT NULL,
    "severity" "text" DEFAULT 'MEDIUM'::"text" NOT NULL,
    "baseline" numeric,
    "threshold" numeric,
    "formula" "text",
    "window_label" "text",
    "data_source" "text" DEFAULT 'yahoo_finance'::"text",
    CONSTRAINT "unusual_activities_severity_check" CHECK (("severity" = ANY (ARRAY['LOW'::"text", 'MEDIUM'::"text", 'HIGH'::"text"])))
);


ALTER TABLE "public"."unusual_activities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."watchlist_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "watchlist_id" "uuid",
    "stock_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."watchlist_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."watchlists" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."watchlists" OWNER TO "postgres";


ALTER TABLE ONLY "public"."ad_verifications"
    ADD CONSTRAINT "ad_verifications_pkey" PRIMARY KEY ("transaction_id");



ALTER TABLE ONLY "public"."agreement_acceptances"
    ADD CONSTRAINT "agreement_acceptances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agreement_acceptances"
    ADD CONSTRAINT "agreement_acceptances_user_id_agreement_id_key" UNIQUE ("user_id", "agreement_id");



ALTER TABLE ONLY "public"."agreements"
    ADD CONSTRAINT "agreements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agreements"
    ADD CONSTRAINT "agreements_version_key" UNIQUE ("version");



ALTER TABLE ONLY "public"."ai_messages"
    ADD CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_tasks"
    ADD CONSTRAINT "ai_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_threads"
    ADD CONSTRAINT "ai_threads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_usage"
    ADD CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app_ratings"
    ADD CONSTRAINT "app_ratings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."backtest_runs"
    ADD CONSTRAINT "backtest_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bug_reports"
    ADD CONSTRAINT "bug_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."candles"
    ADD CONSTRAINT "candles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."candles"
    ADD CONSTRAINT "candles_stock_id_timeframe_ts_key" UNIQUE ("stock_id", "timeframe", "ts");



ALTER TABLE ONLY "public"."chart_analyses"
    ADD CONSTRAINT "chart_analyses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."corporate_actions"
    ADD CONSTRAINT "corporate_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."earnings_calendar"
    ADD CONSTRAINT "earnings_calendar_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."earnings_calendar"
    ADD CONSTRAINT "earnings_calendar_stock_quarter_year_key" UNIQUE ("stock_id", "quarter", "year");



ALTER TABLE ONLY "public"."economic_events"
    ADD CONSTRAINT "economic_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."economic_events"
    ADD CONSTRAINT "economic_events_unique_event" UNIQUE ("event_name", "country", "event_date");



ALTER TABLE ONLY "public"."feature_requests"
    ADD CONSTRAINT "feature_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."foreign_flow"
    ADD CONSTRAINT "foreign_flow_pkey" PRIMARY KEY ("date");



ALTER TABLE ONLY "public"."fundamentals"
    ADD CONSTRAINT "fundamentals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fundamentals"
    ADD CONSTRAINT "fundamentals_stock_id_key" UNIQUE ("stock_id");



ALTER TABLE ONLY "public"."golden_test_cases"
    ADD CONSTRAINT "golden_test_cases_case_code_key" UNIQUE ("case_code");



ALTER TABLE ONLY "public"."golden_test_cases"
    ADD CONSTRAINT "golden_test_cases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."idx_eod_uploads"
    ADD CONSTRAINT "idx_eod_uploads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."idx_eod_uploads"
    ADD CONSTRAINT "idx_eod_uploads_trade_date_key" UNIQUE ("trade_date");



ALTER TABLE ONLY "public"."indicators"
    ADD CONSTRAINT "indicators_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."indicators"
    ADD CONSTRAINT "indicators_stock_id_timeframe_key" UNIQUE ("stock_id", "timeframe");



ALTER TABLE ONLY "public"."internal_secrets"
    ADD CONSTRAINT "internal_secrets_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."intraday_evaluations"
    ADD CONSTRAINT "intraday_evaluations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ipo_calendar"
    ADD CONSTRAINT "ipo_calendar_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_runs"
    ADD CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."market_calendar"
    ADD CONSTRAINT "market_calendar_pkey" PRIMARY KEY ("date");



ALTER TABLE ONLY "public"."market_index"
    ADD CONSTRAINT "market_index_pkey" PRIMARY KEY ("ticker");



ALTER TABLE ONLY "public"."mtf_pipeline_runs"
    ADD CONSTRAINT "mtf_pipeline_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."news_events"
    ADD CONSTRAINT "news_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."news_issuer_mapping"
    ADD CONSTRAINT "news_issuer_mapping_article_id_stock_id_key" UNIQUE ("article_id", "stock_id");



ALTER TABLE ONLY "public"."news_issuer_mapping"
    ADD CONSTRAINT "news_issuer_mapping_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."news"
    ADD CONSTRAINT "news_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_event_id_key" UNIQUE ("event_id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_events"
    ADD CONSTRAINT "payment_events_external_event_id_key" UNIQUE ("external_event_id");



ALTER TABLE ONLY "public"."payment_events"
    ADD CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_external_payment_id_key" UNIQUE ("external_payment_id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_health"
    ADD CONSTRAINT "provider_health_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_user_id_endpoint_key" UNIQUE ("user_id", "endpoint");



ALTER TABLE ONLY "public"."quotes"
    ADD CONSTRAINT "quotes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."quotes"
    ADD CONSTRAINT "quotes_stock_id_key" UNIQUE ("stock_id");



ALTER TABLE ONLY "public"."saved_signals"
    ADD CONSTRAINT "saved_signals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sector_rotation_scores"
    ADD CONSTRAINT "sector_rotation_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sector_rotation_scores"
    ADD CONSTRAINT "sector_rotation_scores_sector_id_as_of_date_key" UNIQUE ("sector_id", "as_of_date");



ALTER TABLE ONLY "public"."sectors"
    ADD CONSTRAINT "sectors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."security_acceptance_checks"
    ADD CONSTRAINT "security_acceptance_checks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."security_acceptance_checks"
    ADD CONSTRAINT "security_acceptance_checks_threat_key" UNIQUE ("threat");



ALTER TABLE ONLY "public"."signal_engine_versions"
    ADD CONSTRAINT "signal_engine_versions_formula_version_timeframe_key" UNIQUE ("formula_version", "timeframe");



ALTER TABLE ONLY "public"."signal_engine_versions"
    ADD CONSTRAINT "signal_engine_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signal_evidence"
    ADD CONSTRAINT "signal_evidence_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signal_evidence"
    ADD CONSTRAINT "signal_evidence_signal_id_key" UNIQUE ("signal_id");



ALTER TABLE ONLY "public"."signal_pipeline_events"
    ADD CONSTRAINT "signal_pipeline_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signal_results"
    ADD CONSTRAINT "signal_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signal_results"
    ADD CONSTRAINT "signal_results_signal_id_key" UNIQUE ("signal_id");



ALTER TABLE ONLY "public"."signal_revisions"
    ADD CONSTRAINT "signal_revisions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signal_unlocks"
    ADD CONSTRAINT "signal_unlocks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signal_unlocks"
    ADD CONSTRAINT "signal_unlocks_user_id_stock_id_unlock_date_key" UNIQUE ("user_id", "stock_id", "unlock_date");



ALTER TABLE ONLY "public"."signals"
    ADD CONSTRAINT "signals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stocks"
    ADD CONSTRAINT "stocks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stocks"
    ADD CONSTRAINT "stocks_ticker_key" UNIQUE ("ticker");



ALTER TABLE ONLY "public"."structure_labels"
    ADD CONSTRAINT "structure_labels_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."structure_zones"
    ADD CONSTRAINT "structure_zones_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."token_transactions"
    ADD CONSTRAINT "token_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."token_wallets"
    ADD CONSTRAINT "token_wallets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."token_wallets"
    ADD CONSTRAINT "token_wallets_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."trading_plans"
    ADD CONSTRAINT "trading_plans_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."unusual_activities"
    ADD CONSTRAINT "unusual_activities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."watchlist_items"
    ADD CONSTRAINT "watchlist_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."watchlists"
    ADD CONSTRAINT "watchlists_pkey" PRIMARY KEY ("id");



CREATE INDEX "corporate_actions_ex_date_status_idx" ON "public"."corporate_actions" USING "btree" ("ex_date", "status");



CREATE INDEX "corporate_actions_stock_id_idx" ON "public"."corporate_actions" USING "btree" ("stock_id");



CREATE INDEX "idx_ad_verifications_stock_id" ON "public"."ad_verifications" USING "btree" ("stock_id");



CREATE INDEX "idx_ad_verifications_user_id" ON "public"."ad_verifications" USING "btree" ("user_id");



CREATE INDEX "idx_agreement_acceptances_agreement_id" ON "public"."agreement_acceptances" USING "btree" ("agreement_id");



CREATE INDEX "idx_ai_messages_thread_id" ON "public"."ai_messages" USING "btree" ("thread_id");



CREATE INDEX "idx_ai_tasks_audit_id" ON "public"."ai_tasks" USING "btree" ("audit_id");



CREATE INDEX "idx_ai_tasks_user_id" ON "public"."ai_tasks" USING "btree" ("user_id");



CREATE INDEX "idx_ai_threads_user_id" ON "public"."ai_threads" USING "btree" ("user_id");



CREATE INDEX "idx_ai_usage_thread_id" ON "public"."ai_usage" USING "btree" ("thread_id");



CREATE INDEX "idx_ai_usage_user_id" ON "public"."ai_usage" USING "btree" ("user_id");



CREATE INDEX "idx_app_ratings_user_id" ON "public"."app_ratings" USING "btree" ("user_id");



CREATE INDEX "idx_audit_logs_actor_id" ON "public"."audit_logs" USING "btree" ("actor_id");



CREATE INDEX "idx_backtest_runs_formula_tf" ON "public"."backtest_runs" USING "btree" ("formula_version", "timeframe", "created_at" DESC);



CREATE INDEX "idx_bug_reports_user_id" ON "public"."bug_reports" USING "btree" ("user_id");



CREATE INDEX "idx_candles_stock_tf_ts" ON "public"."candles" USING "btree" ("stock_id", "timeframe", "ts" DESC);



CREATE INDEX "idx_chart_analyses_stock_id" ON "public"."chart_analyses" USING "btree" ("stock_id");



CREATE INDEX "idx_chart_analyses_user_id" ON "public"."chart_analyses" USING "btree" ("user_id");



CREATE INDEX "idx_earnings_calendar_stock_id" ON "public"."earnings_calendar" USING "btree" ("stock_id");



CREATE INDEX "idx_economic_events_date" ON "public"."economic_events" USING "btree" ("event_date");



CREATE INDEX "idx_economic_events_impact" ON "public"."economic_events" USING "btree" ("impact");



CREATE INDEX "idx_feature_requests_user_id" ON "public"."feature_requests" USING "btree" ("user_id");



CREATE INDEX "idx_idx_eod_uploads_uploaded_by" ON "public"."idx_eod_uploads" USING "btree" ("uploaded_by");



CREATE INDEX "idx_indicators_stock_tf" ON "public"."indicators" USING "btree" ("stock_id", "timeframe");



CREATE INDEX "idx_intraday_evaluations_candle_id" ON "public"."intraday_evaluations" USING "btree" ("candle_id");



CREATE INDEX "idx_intraday_evaluations_signal_id" ON "public"."intraday_evaluations" USING "btree" ("signal_id");



CREATE INDEX "idx_mtf_pipeline_runs_status" ON "public"."mtf_pipeline_runs" USING "btree" ("status");



CREATE INDEX "idx_news_events_primary_article" ON "public"."news_events" USING "btree" ("primary_article_id");



CREATE INDEX "idx_news_events_stock_id" ON "public"."news_events" USING "btree" ("stock_id");



CREATE INDEX "idx_news_issuer_mapping_article" ON "public"."news_issuer_mapping" USING "btree" ("article_id");



CREATE INDEX "idx_news_issuer_mapping_stock" ON "public"."news_issuer_mapping" USING "btree" ("stock_id");



CREATE INDEX "idx_notifications_user_created" ON "public"."notifications" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_payment_events_payment_id" ON "public"."payment_events" USING "btree" ("payment_id");



CREATE INDEX "idx_payments_subscription_id" ON "public"."payments" USING "btree" ("subscription_id");



CREATE INDEX "idx_payments_user_id" ON "public"."payments" USING "btree" ("user_id");



CREATE INDEX "idx_provider_health_provider_checked" ON "public"."provider_health" USING "btree" ("provider", "checked_at" DESC);



CREATE INDEX "idx_push_subscriptions_user_id" ON "public"."push_subscriptions" USING "btree" ("user_id");



CREATE INDEX "idx_quotes_market_cap" ON "public"."quotes" USING "btree" ("market_cap");



CREATE INDEX "idx_quotes_stock_id" ON "public"."quotes" USING "btree" ("stock_id");



CREATE INDEX "idx_saved_signals_user_id" ON "public"."saved_signals" USING "btree" ("user_id");



CREATE INDEX "idx_security_acceptance_checks_last_tested_by" ON "public"."security_acceptance_checks" USING "btree" ("last_tested_by");



CREATE INDEX "idx_signal_engine_versions_backtest_run_id" ON "public"."signal_engine_versions" USING "btree" ("backtest_run_id");



CREATE INDEX "idx_signal_evidence_signal_id" ON "public"."signal_evidence" USING "btree" ("signal_id");



CREATE INDEX "idx_signal_pipeline_events_job_run_id" ON "public"."signal_pipeline_events" USING "btree" ("job_run_id");



CREATE INDEX "idx_signal_pipeline_events_stage" ON "public"."signal_pipeline_events" USING "btree" ("stage", "status", "created_at" DESC);



CREATE INDEX "idx_signal_pipeline_events_stock_id" ON "public"."signal_pipeline_events" USING "btree" ("stock_id");



CREATE INDEX "idx_signal_revisions_approved_by" ON "public"."signal_revisions" USING "btree" ("approved_by");



CREATE INDEX "idx_signal_revisions_audit_id" ON "public"."signal_revisions" USING "btree" ("audit_id");



CREATE INDEX "idx_signal_revisions_new_signal_id" ON "public"."signal_revisions" USING "btree" ("new_signal_id");



CREATE INDEX "idx_signal_revisions_original_signal_id" ON "public"."signal_revisions" USING "btree" ("original_signal_id");



CREATE INDEX "idx_signal_revisions_requested_by" ON "public"."signal_revisions" USING "btree" ("requested_by");



CREATE INDEX "idx_signal_unlocks_stock_id" ON "public"."signal_unlocks" USING "btree" ("stock_id");



CREATE INDEX "idx_signal_unlocks_user_date" ON "public"."signal_unlocks" USING "btree" ("user_id", "unlock_date");



CREATE INDEX "idx_signals_resistance_zone_id" ON "public"."signals" USING "btree" ("resistance_zone_id");



CREATE INDEX "idx_signals_stock_status" ON "public"."signals" USING "btree" ("stock_id", "status");



CREATE INDEX "idx_signals_stock_tf_status" ON "public"."signals" USING "btree" ("stock_id", "timeframe", "status");



CREATE INDEX "idx_signals_superseded_by" ON "public"."signals" USING "btree" ("superseded_by");



CREATE INDEX "idx_signals_support_zone_id" ON "public"."signals" USING "btree" ("support_zone_id");



CREATE INDEX "idx_signals_tier_status" ON "public"."signals" USING "btree" ("signal_tier", "status") WHERE ("superseded_by" IS NULL);



CREATE INDEX "idx_signals_tp1_zone_id" ON "public"."signals" USING "btree" ("tp1_zone_id");



CREATE INDEX "idx_signals_tp2_zone_id" ON "public"."signals" USING "btree" ("tp2_zone_id");



CREATE INDEX "idx_stocks_sector_id" ON "public"."stocks" USING "btree" ("sector_id");



CREATE INDEX "idx_stocks_ticker" ON "public"."stocks" USING "btree" ("ticker");



CREATE INDEX "idx_stocks_trending_score" ON "public"."stocks" USING "btree" ("trending_score" DESC);



CREATE INDEX "idx_structure_labels_source_candle_id" ON "public"."structure_labels" USING "btree" ("source_candle_id");



CREATE INDEX "idx_structure_labels_stock_tf" ON "public"."structure_labels" USING "btree" ("stock_id", "timeframe", "detected_at" DESC);



CREATE INDEX "idx_structure_zones_generated_at" ON "public"."structure_zones" USING "btree" ("generated_at");



CREATE INDEX "idx_structure_zones_stock_tf" ON "public"."structure_zones" USING "btree" ("stock_id", "timeframe", "zone_type");



CREATE INDEX "idx_subscriptions_user_id" ON "public"."subscriptions" USING "btree" ("user_id");



CREATE INDEX "idx_token_transactions_wallet_id" ON "public"."token_transactions" USING "btree" ("wallet_id");



CREATE INDEX "idx_unusual_activities_stock_id" ON "public"."unusual_activities" USING "btree" ("stock_id");



CREATE INDEX "idx_watchlist_items_stock_id" ON "public"."watchlist_items" USING "btree" ("stock_id");



CREATE INDEX "idx_watchlist_items_watchlist_id" ON "public"."watchlist_items" USING "btree" ("watchlist_id");



CREATE INDEX "idx_watchlists_user_id" ON "public"."watchlists" USING "btree" ("user_id");



CREATE UNIQUE INDEX "ipo_calendar_ticker_unique" ON "public"."ipo_calendar" USING "btree" ("ticker") WHERE ("ticker" IS NOT NULL);



CREATE INDEX "news_published_at_idx" ON "public"."news" USING "btree" ("published_at" DESC);



CREATE INDEX "news_related_tickers_idx" ON "public"."news" USING "gin" ("related_tickers");



CREATE UNIQUE INDEX "news_url_unique_idx" ON "public"."news" USING "btree" ("url") WHERE ("url" IS NOT NULL);



CREATE INDEX "sector_rotation_scores_date_idx" ON "public"."sector_rotation_scores" USING "btree" ("as_of_date");



CREATE UNIQUE INDEX "token_transactions_type_reference_id_uniq" ON "public"."token_transactions" USING "btree" ("type", "reference_id") WHERE ("reference_id" IS NOT NULL);



CREATE OR REPLACE TRIGGER "ai_tasks_enforce_limits" BEFORE INSERT ON "public"."ai_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_ai_task_limits"();



CREATE OR REPLACE TRIGGER "ai_tasks_enforce_limits_update" BEFORE UPDATE ON "public"."ai_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_ai_task_limits_on_update"();



CREATE OR REPLACE TRIGGER "trading_plan_tier_check" BEFORE INSERT OR UPDATE ON "public"."trading_plans" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_trading_plan_tier"();



CREATE OR REPLACE TRIGGER "trg_enforce_trading_plan_module_lock" BEFORE UPDATE ON "public"."trading_plans" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_trading_plan_module_lock"();



CREATE OR REPLACE TRIGGER "trg_enforce_trading_plan_module_lock_insert" BEFORE INSERT ON "public"."trading_plans" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_trading_plan_module_lock_insert"();



CREATE OR REPLACE TRIGGER "trg_enforce_watchlist_folder_limit" BEFORE INSERT ON "public"."watchlists" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_watchlist_folder_limit"();



CREATE OR REPLACE TRIGGER "trg_enforce_watchlist_item_limit" BEFORE INSERT ON "public"."watchlist_items" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_watchlist_item_limit"();



CREATE OR REPLACE TRIGGER "trg_golden_test_cases_updated_at" BEFORE UPDATE ON "public"."golden_test_cases" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_notify_push_on_new_notification" AFTER INSERT ON "public"."notifications" FOR EACH ROW EXECUTE FUNCTION "public"."notify_push_on_new_notification"();



CREATE OR REPLACE TRIGGER "trg_notify_unusual_activity" AFTER INSERT ON "public"."unusual_activities" FOR EACH ROW EXECUTE FUNCTION "public"."notify_unusual_activity_subscribers"();



CREATE OR REPLACE TRIGGER "trg_notify_watchlist_new_signal" AFTER INSERT ON "public"."signals" FOR EACH ROW WHEN (("new"."status" = 'ACTIVE'::"text")) EXECUTE FUNCTION "public"."notify_watchlist_new_signal"();



CREATE OR REPLACE TRIGGER "trg_notify_watchlist_news" AFTER INSERT ON "public"."news" FOR EACH ROW EXECUTE FUNCTION "public"."notify_watchlist_news"();



CREATE OR REPLACE TRIGGER "trg_protect_idx_manual_candle" BEFORE UPDATE ON "public"."candles" FOR EACH ROW EXECUTE FUNCTION "public"."protect_idx_manual_candle"();



CREATE OR REPLACE TRIGGER "trg_protect_idx_manual_quote" BEFORE UPDATE ON "public"."quotes" FOR EACH ROW EXECUTE FUNCTION "public"."protect_idx_manual_quote"();



CREATE OR REPLACE TRIGGER "trg_protect_sensitive_profile_columns" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."protect_sensitive_profile_columns"();



CREATE OR REPLACE TRIGGER "trg_protect_signal_immutable" BEFORE UPDATE ON "public"."signals" FOR EACH ROW EXECUTE FUNCTION "public"."protect_signal_immutable_fields"();



CREATE OR REPLACE TRIGGER "trg_push_market_cap_to_quote" AFTER INSERT OR UPDATE ON "public"."fundamentals" FOR EACH ROW EXECUTE FUNCTION "public"."push_market_cap_to_quote"();



CREATE OR REPLACE TRIGGER "trg_record_signal_result" AFTER UPDATE ON "public"."signals" FOR EACH ROW EXECUTE FUNCTION "public"."record_signal_result"();



CREATE OR REPLACE TRIGGER "trg_sync_quote_market_cap" BEFORE INSERT OR UPDATE ON "public"."quotes" FOR EACH ROW EXECUTE FUNCTION "public"."sync_quote_market_cap"();



CREATE OR REPLACE TRIGGER "trg_sync_signal_evidence" AFTER INSERT OR UPDATE OF "evidence" ON "public"."signals" FOR EACH ROW EXECUTE FUNCTION "public"."sync_signal_evidence"();



ALTER TABLE ONLY "public"."ad_verifications"
    ADD CONSTRAINT "ad_verifications_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id");



ALTER TABLE ONLY "public"."ad_verifications"
    ADD CONSTRAINT "ad_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."agreement_acceptances"
    ADD CONSTRAINT "agreement_acceptances_agreement_id_fkey" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id");



ALTER TABLE ONLY "public"."agreement_acceptances"
    ADD CONSTRAINT "agreement_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_messages"
    ADD CONSTRAINT "ai_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."ai_threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_tasks"
    ADD CONSTRAINT "ai_tasks_audit_id_fkey" FOREIGN KEY ("audit_id") REFERENCES "public"."audit_logs"("id");



ALTER TABLE ONLY "public"."ai_tasks"
    ADD CONSTRAINT "ai_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_threads"
    ADD CONSTRAINT "ai_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_usage"
    ADD CONSTRAINT "ai_usage_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."ai_threads"("id");



ALTER TABLE ONLY "public"."ai_usage"
    ADD CONSTRAINT "ai_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."app_ratings"
    ADD CONSTRAINT "app_ratings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."bug_reports"
    ADD CONSTRAINT "bug_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."candles"
    ADD CONSTRAINT "candles_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chart_analyses"
    ADD CONSTRAINT "chart_analyses_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id");



ALTER TABLE ONLY "public"."chart_analyses"
    ADD CONSTRAINT "chart_analyses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."corporate_actions"
    ADD CONSTRAINT "corporate_actions_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id");



ALTER TABLE ONLY "public"."earnings_calendar"
    ADD CONSTRAINT "earnings_calendar_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."feature_requests"
    ADD CONSTRAINT "feature_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."fundamentals"
    ADD CONSTRAINT "fundamentals_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."idx_eod_uploads"
    ADD CONSTRAINT "idx_eod_uploads_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."indicators"
    ADD CONSTRAINT "indicators_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."intraday_evaluations"
    ADD CONSTRAINT "intraday_evaluations_candle_id_fkey" FOREIGN KEY ("candle_id") REFERENCES "public"."candles"("id");



ALTER TABLE ONLY "public"."intraday_evaluations"
    ADD CONSTRAINT "intraday_evaluations_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."news_events"
    ADD CONSTRAINT "news_events_primary_article_id_fkey" FOREIGN KEY ("primary_article_id") REFERENCES "public"."news"("id");



ALTER TABLE ONLY "public"."news_events"
    ADD CONSTRAINT "news_events_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id");



ALTER TABLE ONLY "public"."news_issuer_mapping"
    ADD CONSTRAINT "news_issuer_mapping_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "public"."news"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."news_issuer_mapping"
    ADD CONSTRAINT "news_issuer_mapping_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_events"
    ADD CONSTRAINT "payment_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."quotes"
    ADD CONSTRAINT "quotes_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."saved_signals"
    ADD CONSTRAINT "saved_signals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sector_rotation_scores"
    ADD CONSTRAINT "sector_rotation_scores_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "public"."sectors"("id");



ALTER TABLE ONLY "public"."security_acceptance_checks"
    ADD CONSTRAINT "security_acceptance_checks_last_tested_by_fkey" FOREIGN KEY ("last_tested_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."signal_engine_versions"
    ADD CONSTRAINT "signal_engine_versions_backtest_run_id_fkey" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."backtest_runs"("id");



ALTER TABLE ONLY "public"."signal_evidence"
    ADD CONSTRAINT "signal_evidence_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."signal_pipeline_events"
    ADD CONSTRAINT "signal_pipeline_events_job_run_id_fkey" FOREIGN KEY ("job_run_id") REFERENCES "public"."job_runs"("id");



ALTER TABLE ONLY "public"."signal_pipeline_events"
    ADD CONSTRAINT "signal_pipeline_events_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id");



ALTER TABLE ONLY "public"."signal_results"
    ADD CONSTRAINT "signal_results_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."signal_revisions"
    ADD CONSTRAINT "signal_revisions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."signal_revisions"
    ADD CONSTRAINT "signal_revisions_audit_id_fkey" FOREIGN KEY ("audit_id") REFERENCES "public"."audit_logs"("id");



ALTER TABLE ONLY "public"."signal_revisions"
    ADD CONSTRAINT "signal_revisions_new_signal_id_fkey" FOREIGN KEY ("new_signal_id") REFERENCES "public"."signals"("id");



ALTER TABLE ONLY "public"."signal_revisions"
    ADD CONSTRAINT "signal_revisions_original_signal_id_fkey" FOREIGN KEY ("original_signal_id") REFERENCES "public"."signals"("id");



ALTER TABLE ONLY "public"."signal_revisions"
    ADD CONSTRAINT "signal_revisions_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."signal_unlocks"
    ADD CONSTRAINT "signal_unlocks_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."signal_unlocks"
    ADD CONSTRAINT "signal_unlocks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."signals"
    ADD CONSTRAINT "signals_resistance_zone_id_fkey" FOREIGN KEY ("resistance_zone_id") REFERENCES "public"."structure_zones"("id");



ALTER TABLE ONLY "public"."signals"
    ADD CONSTRAINT "signals_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id");



ALTER TABLE ONLY "public"."signals"
    ADD CONSTRAINT "signals_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "public"."signals"("id");



ALTER TABLE ONLY "public"."signals"
    ADD CONSTRAINT "signals_support_zone_id_fkey" FOREIGN KEY ("support_zone_id") REFERENCES "public"."structure_zones"("id");



ALTER TABLE ONLY "public"."signals"
    ADD CONSTRAINT "signals_tp1_zone_id_fkey" FOREIGN KEY ("tp1_zone_id") REFERENCES "public"."structure_zones"("id");



ALTER TABLE ONLY "public"."signals"
    ADD CONSTRAINT "signals_tp2_zone_id_fkey" FOREIGN KEY ("tp2_zone_id") REFERENCES "public"."structure_zones"("id");



ALTER TABLE ONLY "public"."stocks"
    ADD CONSTRAINT "stocks_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "public"."sectors"("id");



ALTER TABLE ONLY "public"."structure_labels"
    ADD CONSTRAINT "structure_labels_source_candle_id_fkey" FOREIGN KEY ("source_candle_id") REFERENCES "public"."candles"("id");



ALTER TABLE ONLY "public"."structure_labels"
    ADD CONSTRAINT "structure_labels_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id");



ALTER TABLE ONLY "public"."structure_zones"
    ADD CONSTRAINT "structure_zones_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."token_transactions"
    ADD CONSTRAINT "token_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "public"."token_wallets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."token_wallets"
    ADD CONSTRAINT "token_wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trading_plans"
    ADD CONSTRAINT "trading_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."unusual_activities"
    ADD CONSTRAINT "unusual_activities_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."watchlist_items"
    ADD CONSTRAINT "watchlist_items_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "public"."stocks"("id");



ALTER TABLE ONLY "public"."watchlist_items"
    ADD CONSTRAINT "watchlist_items_watchlist_id_fkey" FOREIGN KEY ("watchlist_id") REFERENCES "public"."watchlists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."watchlists"
    ADD CONSTRAINT "watchlists_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE "public"."ad_verifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ad_verifications_owner_read" ON "public"."ad_verifications" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "admin manage idx_eod_uploads" ON "public"."idx_eod_uploads" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_admin" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_admin" = true)))));



CREATE POLICY "admin read ai_usage" ON "public"."ai_usage" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_admin" = true)))));



CREATE POLICY "admin_delete_earnings_calendar" ON "public"."earnings_calendar" FOR DELETE USING ("public"."is_current_user_admin"());



CREATE POLICY "admin_delete_ipo_calendar" ON "public"."ipo_calendar" FOR DELETE USING ("public"."is_current_user_admin"());



CREATE POLICY "admin_insert_earnings_calendar" ON "public"."earnings_calendar" FOR INSERT WITH CHECK ("public"."is_current_user_admin"());



CREATE POLICY "admin_insert_ipo_calendar" ON "public"."ipo_calendar" FOR INSERT WITH CHECK ("public"."is_current_user_admin"());



CREATE POLICY "admin_select_audit_logs" ON "public"."audit_logs" FOR SELECT TO "authenticated" USING ("public"."is_current_user_admin"());



CREATE POLICY "admin_select_job_runs" ON "public"."job_runs" FOR SELECT TO "authenticated" USING ("public"."is_current_user_admin"());



CREATE POLICY "admin_select_provider_health" ON "public"."provider_health" FOR SELECT TO "authenticated" USING ("public"."is_current_user_admin"());



CREATE POLICY "admin_update_bug_reports" ON "public"."bug_reports" FOR UPDATE TO "authenticated" USING ("public"."is_current_user_admin"()) WITH CHECK ("public"."is_current_user_admin"());



CREATE POLICY "admin_update_earnings_calendar" ON "public"."earnings_calendar" FOR UPDATE USING ("public"."is_current_user_admin"());



CREATE POLICY "admin_update_feature_requests" ON "public"."feature_requests" FOR UPDATE TO "authenticated" USING ("public"."is_current_user_admin"()) WITH CHECK ("public"."is_current_user_admin"());



CREATE POLICY "admin_update_ipo_calendar" ON "public"."ipo_calendar" FOR UPDATE USING ("public"."is_current_user_admin"());



ALTER TABLE "public"."agreement_acceptances" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agreements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agreements readable by all" ON "public"."agreements" FOR SELECT USING (true);



ALTER TABLE "public"."ai_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_tasks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_threads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_usage" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."app_ratings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "app_ratings_select" ON "public"."app_ratings" FOR SELECT TO "authenticated" USING (("public"."is_current_user_admin"() OR (( SELECT "auth"."uid"() AS "uid") = "user_id")));



ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."backtest_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "backtest_runs readable by admin only" ON "public"."backtest_runs" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_admin" = true)))));



ALTER TABLE "public"."bug_reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bug_reports_select" ON "public"."bug_reports" FOR SELECT TO "authenticated" USING (("public"."is_current_user_admin"() OR (( SELECT "auth"."uid"() AS "uid") = "user_id")));



ALTER TABLE "public"."candles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "candles readable by all" ON "public"."candles" FOR SELECT USING (true);



ALTER TABLE "public"."chart_analyses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chart_analyses_select_own" ON "public"."chart_analyses" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."corporate_actions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "corporate_actions_admin_delete" ON "public"."corporate_actions" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_admin" = true)))));



CREATE POLICY "corporate_actions_admin_insert" ON "public"."corporate_actions" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_admin" = true)))));



CREATE POLICY "corporate_actions_admin_update" ON "public"."corporate_actions" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_admin" = true)))));



CREATE POLICY "corporate_actions_select_authenticated" ON "public"."corporate_actions" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."earnings_calendar" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "earnings_calendar readable by all" ON "public"."earnings_calendar" FOR SELECT USING (true);



ALTER TABLE "public"."economic_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "economic_events readable by all" ON "public"."economic_events" FOR SELECT USING (true);



ALTER TABLE "public"."feature_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "feature_requests_select" ON "public"."feature_requests" FOR SELECT TO "authenticated" USING (("public"."is_current_user_admin"() OR (( SELECT "auth"."uid"() AS "uid") = "user_id")));



ALTER TABLE "public"."foreign_flow" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "foreign_flow_select_all" ON "public"."foreign_flow" FOR SELECT USING (true);



ALTER TABLE "public"."fundamentals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fundamentals readable by all" ON "public"."fundamentals" FOR SELECT USING (true);



ALTER TABLE "public"."golden_test_cases" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "golden_test_cases_admin_select" ON "public"."golden_test_cases" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_admin" = true)))));



CREATE POLICY "golden_test_cases_service_delete" ON "public"."golden_test_cases" FOR DELETE USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "golden_test_cases_service_insert" ON "public"."golden_test_cases" FOR INSERT WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "golden_test_cases_service_update" ON "public"."golden_test_cases" FOR UPDATE USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



ALTER TABLE "public"."idx_eod_uploads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."indicators" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "indicators readable by all" ON "public"."indicators" FOR SELECT USING (true);



ALTER TABLE "public"."internal_secrets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "internal_secrets_no_access" ON "public"."internal_secrets" TO "authenticated", "anon" USING (false) WITH CHECK (false);



ALTER TABLE "public"."intraday_evaluations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "intraday_evaluations readable by all" ON "public"."intraday_evaluations" FOR SELECT USING (true);



ALTER TABLE "public"."ipo_calendar" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ipo_calendar readable by all" ON "public"."ipo_calendar" FOR SELECT USING (true);



ALTER TABLE "public"."job_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."market_calendar" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "market_calendar readable by all" ON "public"."market_calendar" FOR SELECT USING (true);



ALTER TABLE "public"."market_index" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "market_index_select_all" ON "public"."market_index" FOR SELECT USING (true);



ALTER TABLE "public"."mtf_pipeline_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mtf_pipeline_runs_admin_select" ON "public"."mtf_pipeline_runs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_admin" = true)))));



ALTER TABLE "public"."news" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."news_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "news_events readable by all" ON "public"."news_events" FOR SELECT USING (true);



ALTER TABLE "public"."news_issuer_mapping" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "news_issuer_mapping_select_all" ON "public"."news_issuer_mapping" FOR SELECT USING (true);



CREATE POLICY "news_issuer_mapping_service_delete" ON "public"."news_issuer_mapping" FOR DELETE USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "news_issuer_mapping_service_insert" ON "public"."news_issuer_mapping" FOR INSERT WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "news_issuer_mapping_service_update" ON "public"."news_issuer_mapping" FOR UPDATE USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "news_select_all" ON "public"."news" FOR SELECT USING (true);



CREATE POLICY "no client access to payment_events" ON "public"."payment_events" USING (false) WITH CHECK (false);



ALTER TABLE "public"."notification_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "own agreement acceptance insert" ON "public"."agreement_acceptances" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own agreement acceptance select" ON "public"."agreement_acceptances" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own ai messages" ON "public"."ai_messages" USING ((EXISTS ( SELECT 1
   FROM "public"."ai_threads" "t"
  WHERE (("t"."id" = "ai_messages"."thread_id") AND ("t"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "own ai tasks" ON "public"."ai_tasks" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own ai threads" ON "public"."ai_threads" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own bug reports insert" ON "public"."bug_reports" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own feature requests insert" ON "public"."feature_requests" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own notification preferences" ON "public"."notification_preferences" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own notifications" ON "public"."notifications" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own rating insert" ON "public"."app_ratings" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own saved signals" ON "public"."saved_signals" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own signal unlocks" ON "public"."signal_unlocks" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own token transactions select" ON "public"."token_transactions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."token_wallets" "tw"
  WHERE (("tw"."id" = "token_transactions"."wallet_id") AND ("tw"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "own token wallet select" ON "public"."token_wallets" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own watchlist items" ON "public"."watchlist_items" USING ((EXISTS ( SELECT 1
   FROM "public"."watchlists" "w"
  WHERE (("w"."id" = "watchlist_items"."watchlist_id") AND ("w"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "own watchlists" ON "public"."watchlists" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."payment_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payments_select" ON "public"."payments" FOR SELECT TO "authenticated" USING (("public"."is_current_user_admin"() OR (( SELECT "auth"."uid"() AS "uid") = "user_id")));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_delete_own" ON "public"."profiles" FOR DELETE USING ((( SELECT "auth"."uid"() AS "uid") = "id"));



CREATE POLICY "profiles_insert_own" ON "public"."profiles" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "id"));



CREATE POLICY "profiles_select" ON "public"."profiles" FOR SELECT USING (((( SELECT "auth"."uid"() AS "uid") = "id") OR "public"."is_current_user_admin"()));



CREATE POLICY "profiles_update_own" ON "public"."profiles" FOR UPDATE USING ((( SELECT "auth"."uid"() AS "uid") = "id"));



ALTER TABLE "public"."provider_health" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "public read of sector rotation scores" ON "public"."sector_rotation_scores" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "public read of signal metadata" ON "public"."signals" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."push_subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "push_subscriptions_delete_own" ON "public"."push_subscriptions" FOR DELETE USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "push_subscriptions_insert_own" ON "public"."push_subscriptions" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "push_subscriptions_select_own" ON "public"."push_subscriptions" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."quotes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "quotes readable by all" ON "public"."quotes" FOR SELECT USING (true);



ALTER TABLE "public"."saved_signals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sector_rotation_scores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sectors" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sectors readable by all" ON "public"."sectors" FOR SELECT USING (true);



ALTER TABLE "public"."security_acceptance_checks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "security_acceptance_checks_admin_all" ON "public"."security_acceptance_checks" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_admin" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_admin" = true)))));



ALTER TABLE "public"."signal_engine_versions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "signal_engine_versions readable by all" ON "public"."signal_engine_versions" FOR SELECT USING (true);



ALTER TABLE "public"."signal_evidence" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "signal_evidence readable by all" ON "public"."signal_evidence" FOR SELECT USING (true);



ALTER TABLE "public"."signal_pipeline_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "signal_pipeline_events_admin_select" ON "public"."signal_pipeline_events" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_admin" = true)))));



CREATE POLICY "signal_pipeline_events_service_write" ON "public"."signal_pipeline_events" FOR INSERT WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



ALTER TABLE "public"."signal_results" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "signal_results readable by all" ON "public"."signal_results" FOR SELECT USING (true);



ALTER TABLE "public"."signal_revisions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "signal_revisions_admin_insert" ON "public"."signal_revisions" FOR INSERT WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_admin" = true)))) AND ("requested_by" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "signal_revisions_admin_select" ON "public"."signal_revisions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_admin" = true)))));



CREATE POLICY "signal_revisions_service_write" ON "public"."signal_revisions" FOR UPDATE USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



ALTER TABLE "public"."signal_unlocks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."signals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stocks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "stocks readable by all" ON "public"."stocks" FOR SELECT USING (true);



ALTER TABLE "public"."structure_labels" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "structure_labels readable by all" ON "public"."structure_labels" FOR SELECT USING (true);



ALTER TABLE "public"."structure_zones" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "structure_zones readable by all" ON "public"."structure_zones" FOR SELECT USING (true);



ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subscriptions_select" ON "public"."subscriptions" FOR SELECT TO "authenticated" USING (("public"."is_current_user_admin"() OR (( SELECT "auth"."uid"() AS "uid") = "user_id")));



ALTER TABLE "public"."token_transactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."token_wallets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."trading_plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "trading_plans_insert_own" ON "public"."trading_plans" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "trading_plans_select_own" ON "public"."trading_plans" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "trading_plans_update_own" ON "public"."trading_plans" FOR UPDATE USING ((( SELECT "auth"."uid"() AS "uid") = "user_id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."unusual_activities" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "unusual_activities readable by all" ON "public"."unusual_activities" FOR SELECT USING (true);



ALTER TABLE "public"."watchlist_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."watchlists" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";














































































































































































REVOKE ALL ON FUNCTION "public"."activate_subscription_from_payment"("p_payment_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."activate_subscription_from_payment"("p_payment_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_dashboard_summary"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_dashboard_summary"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_dashboard_summary"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_invalidate_signal"("p_signal_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_invalidate_signal"("p_signal_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_invalidate_signal"("p_signal_id" "uuid", "p_reason" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_record_corporate_action"("p_stock_id" "uuid", "p_action_type" "text", "p_ex_date" "date", "p_ratio" numeric, "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_record_corporate_action"("p_stock_id" "uuid", "p_action_type" "text", "p_ex_date" "date", "p_ratio" numeric, "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_record_corporate_action"("p_stock_id" "uuid", "p_action_type" "text", "p_ex_date" "date", "p_ratio" numeric, "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."calculate_trending_scores"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."calculate_trending_scores"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."compute_sector_rotation"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."compute_sector_rotation"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."credit_ad_unlock_verified"("p_user_id" "uuid", "p_stock_id" "uuid", "p_transaction_id" "text", "p_reward_item" "text", "p_reward_amount" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."credit_ad_unlock_verified"("p_user_id" "uuid", "p_stock_id" "uuid", "p_transaction_id" "text", "p_reward_item" "text", "p_reward_amount" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."deduct_token"("p_type" "text", "p_reference_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deduct_token"("p_type" "text", "p_reference_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deduct_token"("p_type" "text", "p_reference_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."detect_unusual_activity"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."detect_unusual_activity"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."dispatch_morning_briefing"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."dispatch_morning_briefing"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_ai_task_limits"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_ai_task_limits"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_ai_task_limits_on_update"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_ai_task_limits_on_update"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_trading_plan_module_lock"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_trading_plan_module_lock"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_trading_plan_module_lock_insert"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_trading_plan_module_lock_insert"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_trading_plan_tier"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_trading_plan_tier"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_watchlist_folder_limit"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_watchlist_folder_limit"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_watchlist_item_limit"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_watchlist_item_limit"() TO "service_role";



GRANT ALL ON TABLE "public"."token_wallets" TO "service_role";
GRANT SELECT ON TABLE "public"."token_wallets" TO "authenticated";



REVOKE ALL ON FUNCTION "public"."ensure_wallet_current"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ensure_wallet_current"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."execute_ai_tasks"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."execute_ai_tasks"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."expire_grace_subscriptions"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."expire_grace_subscriptions"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_for_you_stocks"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_for_you_stocks"("p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_for_you_stocks"("p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_for_you_stocks"("p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_my_wallet"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_wallet"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_signal_for_stock"("p_stock_id" "uuid", "p_tier" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_signal_for_stock"("p_stock_id" "uuid", "p_tier" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_signal_history"("p_status" "text", "p_tier" "text", "p_days" integer, "p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_signal_history"("p_status" "text", "p_tier" "text", "p_days" integer, "p_limit" integer, "p_offset" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_current_user_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_current_user_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_current_user_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."job_run_finish"("p_id" "uuid", "p_status" "text", "p_detail" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."job_run_finish"("p_id" "uuid", "p_status" "text", "p_detail" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."job_run_start"("p_job_name" "text", "p_detail" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."job_run_start"("p_job_name" "text", "p_detail" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."list_active_signals"("p_tier" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_active_signals"("p_tier" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."mtf_pipeline_poll"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mtf_pipeline_poll"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."notify_push_on_new_notification"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notify_push_on_new_notification"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."notify_subscription_renewal_h1"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notify_subscription_renewal_h1"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."notify_unusual_activity_subscribers"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notify_unusual_activity_subscribers"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."notify_watchlist_new_signal"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notify_watchlist_new_signal"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."notify_watchlist_news"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notify_watchlist_news"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."process_corporate_actions"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."process_corporate_actions"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."process_pending_corporate_actions"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."process_pending_corporate_actions"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."protect_idx_manual_candle"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."protect_idx_manual_candle"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."protect_idx_manual_quote"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."protect_idx_manual_quote"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."protect_sensitive_profile_columns"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."protect_sensitive_profile_columns"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."protect_signal_immutable_fields"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."protect_signal_immutable_fields"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."push_market_cap_to_quote"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."push_market_cap_to_quote"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."reconcile_fetch_ipo_calendar"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reconcile_fetch_ipo_calendar"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."reconcile_job_runs"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reconcile_job_runs"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_signal_result"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_signal_result"() TO "service_role";



GRANT ALL ON FUNCTION "public"."refund_token"("p_type" "text", "p_reference_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."refund_token"("p_type" "text", "p_reference_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."request_account_deletion"("p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."request_account_deletion"("p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."request_account_deletion"("p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rls_auto_enable"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_quote_market_cap"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_quote_market_cap"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_signal_evidence"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_signal_evidence"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_stock_master"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_stock_master"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_ai_task_executor"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_ai_task_executor"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_detect_unusual_activity"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_detect_unusual_activity"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_evaluate_signals"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_evaluate_signals"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_fetch_earnings_calendar"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_fetch_earnings_calendar"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_fetch_economic_calendar"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_fetch_economic_calendar"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_fetch_fundamentals"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_fetch_fundamentals"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_fetch_index"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_fetch_index"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_fetch_ipo_calendar"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_fetch_ipo_calendar"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_fetch_news"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_fetch_news"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_fetch_news"("p_scope" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_fetch_news"("p_scope" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_fetch_quotes"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_fetch_quotes"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_generate_signal_reasoning"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_generate_signal_reasoning"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_generate_trending_reason"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_generate_trending_reason"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_master_sync_stock"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_master_sync_stock"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_morning_briefing"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_morning_briefing"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_process_corporate_actions"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_process_corporate_actions"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_signal_pipeline_mtf"("p_tier" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_signal_pipeline_mtf"("p_tier" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_trending_score"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_trending_score"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_unusual_activity_detection"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_unusual_activity_detection"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."unlock_signal_with_ad"("p_stock_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."unlock_signal_with_ad"("p_stock_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."unlock_signal_with_token"("p_stock_id" "uuid", "p_idempotency_key" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."unlock_signal_with_token"("p_stock_id" "uuid", "p_idempotency_key" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unlock_signal_with_token"("p_stock_id" "uuid", "p_idempotency_key" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."wait_for_net_response"("p_request_id" bigint, "p_max_wait_seconds" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."wait_for_net_response"("p_request_id" bigint, "p_max_wait_seconds" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."wait_for_net_response"("p_request_id" bigint, "p_max_wait_seconds" integer) TO "service_role";
























GRANT ALL ON TABLE "public"."ad_verifications" TO "authenticated";
GRANT ALL ON TABLE "public"."ad_verifications" TO "service_role";



GRANT ALL ON TABLE "public"."agreement_acceptances" TO "anon";
GRANT ALL ON TABLE "public"."agreement_acceptances" TO "authenticated";
GRANT ALL ON TABLE "public"."agreement_acceptances" TO "service_role";



GRANT ALL ON TABLE "public"."agreements" TO "anon";
GRANT ALL ON TABLE "public"."agreements" TO "authenticated";
GRANT ALL ON TABLE "public"."agreements" TO "service_role";



GRANT ALL ON TABLE "public"."ai_messages" TO "anon";
GRANT ALL ON TABLE "public"."ai_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_messages" TO "service_role";



GRANT ALL ON TABLE "public"."ai_tasks" TO "anon";
GRANT ALL ON TABLE "public"."ai_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_tasks" TO "service_role";



GRANT ALL ON TABLE "public"."ai_threads" TO "anon";
GRANT ALL ON TABLE "public"."ai_threads" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_threads" TO "service_role";



GRANT ALL ON TABLE "public"."ai_usage" TO "anon";
GRANT ALL ON TABLE "public"."ai_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_usage" TO "service_role";



GRANT ALL ON TABLE "public"."app_ratings" TO "authenticated";
GRANT ALL ON TABLE "public"."app_ratings" TO "service_role";



GRANT ALL ON TABLE "public"."audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."backtest_runs" TO "anon";
GRANT ALL ON TABLE "public"."backtest_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."backtest_runs" TO "service_role";



GRANT ALL ON TABLE "public"."bug_reports" TO "anon";
GRANT ALL ON TABLE "public"."bug_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."bug_reports" TO "service_role";



GRANT ALL ON TABLE "public"."candles" TO "anon";
GRANT ALL ON TABLE "public"."candles" TO "authenticated";
GRANT ALL ON TABLE "public"."candles" TO "service_role";



GRANT ALL ON TABLE "public"."chart_analyses" TO "anon";
GRANT ALL ON TABLE "public"."chart_analyses" TO "authenticated";
GRANT ALL ON TABLE "public"."chart_analyses" TO "service_role";



GRANT ALL ON TABLE "public"."corporate_actions" TO "anon";
GRANT ALL ON TABLE "public"."corporate_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."corporate_actions" TO "service_role";



GRANT ALL ON TABLE "public"."earnings_calendar" TO "anon";
GRANT ALL ON TABLE "public"."earnings_calendar" TO "authenticated";
GRANT ALL ON TABLE "public"."earnings_calendar" TO "service_role";



GRANT ALL ON TABLE "public"."economic_events" TO "anon";
GRANT ALL ON TABLE "public"."economic_events" TO "authenticated";
GRANT ALL ON TABLE "public"."economic_events" TO "service_role";



GRANT ALL ON TABLE "public"."feature_requests" TO "anon";
GRANT ALL ON TABLE "public"."feature_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."feature_requests" TO "service_role";



GRANT ALL ON TABLE "public"."foreign_flow" TO "anon";
GRANT ALL ON TABLE "public"."foreign_flow" TO "authenticated";
GRANT ALL ON TABLE "public"."foreign_flow" TO "service_role";



GRANT ALL ON TABLE "public"."fundamentals" TO "anon";
GRANT ALL ON TABLE "public"."fundamentals" TO "authenticated";
GRANT ALL ON TABLE "public"."fundamentals" TO "service_role";



GRANT ALL ON TABLE "public"."golden_test_cases" TO "anon";
GRANT ALL ON TABLE "public"."golden_test_cases" TO "authenticated";
GRANT ALL ON TABLE "public"."golden_test_cases" TO "service_role";



GRANT ALL ON TABLE "public"."idx_eod_uploads" TO "anon";
GRANT ALL ON TABLE "public"."idx_eod_uploads" TO "authenticated";
GRANT ALL ON TABLE "public"."idx_eod_uploads" TO "service_role";



GRANT ALL ON TABLE "public"."indicators" TO "anon";
GRANT ALL ON TABLE "public"."indicators" TO "authenticated";
GRANT ALL ON TABLE "public"."indicators" TO "service_role";



GRANT ALL ON TABLE "public"."internal_secrets" TO "service_role";



GRANT ALL ON TABLE "public"."intraday_evaluations" TO "anon";
GRANT ALL ON TABLE "public"."intraday_evaluations" TO "authenticated";
GRANT ALL ON TABLE "public"."intraday_evaluations" TO "service_role";



GRANT ALL ON TABLE "public"."ipo_calendar" TO "anon";
GRANT ALL ON TABLE "public"."ipo_calendar" TO "authenticated";
GRANT ALL ON TABLE "public"."ipo_calendar" TO "service_role";



GRANT ALL ON TABLE "public"."job_runs" TO "anon";
GRANT ALL ON TABLE "public"."job_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."job_runs" TO "service_role";



GRANT ALL ON TABLE "public"."market_calendar" TO "anon";
GRANT ALL ON TABLE "public"."market_calendar" TO "authenticated";
GRANT ALL ON TABLE "public"."market_calendar" TO "service_role";



GRANT ALL ON TABLE "public"."market_index" TO "anon";
GRANT ALL ON TABLE "public"."market_index" TO "authenticated";
GRANT ALL ON TABLE "public"."market_index" TO "service_role";



GRANT ALL ON TABLE "public"."mtf_pipeline_runs" TO "anon";
GRANT ALL ON TABLE "public"."mtf_pipeline_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."mtf_pipeline_runs" TO "service_role";



GRANT ALL ON TABLE "public"."news" TO "anon";
GRANT ALL ON TABLE "public"."news" TO "authenticated";
GRANT ALL ON TABLE "public"."news" TO "service_role";



GRANT ALL ON TABLE "public"."news_events" TO "anon";
GRANT ALL ON TABLE "public"."news_events" TO "authenticated";
GRANT ALL ON TABLE "public"."news_events" TO "service_role";



GRANT ALL ON TABLE "public"."news_issuer_mapping" TO "anon";
GRANT ALL ON TABLE "public"."news_issuer_mapping" TO "authenticated";
GRANT ALL ON TABLE "public"."news_issuer_mapping" TO "service_role";



GRANT ALL ON TABLE "public"."notification_preferences" TO "anon";
GRANT ALL ON TABLE "public"."notification_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."payment_events" TO "anon";
GRANT ALL ON TABLE "public"."payment_events" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_events" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT UPDATE("full_name") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("risk_profile") ON TABLE "public"."profiles" TO "authenticated";



GRANT ALL ON TABLE "public"."provider_health" TO "anon";
GRANT ALL ON TABLE "public"."provider_health" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_health" TO "service_role";



GRANT ALL ON TABLE "public"."push_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."push_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."push_subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."quotes" TO "anon";
GRANT ALL ON TABLE "public"."quotes" TO "authenticated";
GRANT ALL ON TABLE "public"."quotes" TO "service_role";



GRANT ALL ON TABLE "public"."saved_signals" TO "anon";
GRANT ALL ON TABLE "public"."saved_signals" TO "authenticated";
GRANT ALL ON TABLE "public"."saved_signals" TO "service_role";



GRANT ALL ON TABLE "public"."sector_rotation_scores" TO "anon";
GRANT ALL ON TABLE "public"."sector_rotation_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."sector_rotation_scores" TO "service_role";



GRANT ALL ON TABLE "public"."sectors" TO "anon";
GRANT ALL ON TABLE "public"."sectors" TO "authenticated";
GRANT ALL ON TABLE "public"."sectors" TO "service_role";



GRANT ALL ON TABLE "public"."security_acceptance_checks" TO "anon";
GRANT ALL ON TABLE "public"."security_acceptance_checks" TO "authenticated";
GRANT ALL ON TABLE "public"."security_acceptance_checks" TO "service_role";



GRANT ALL ON TABLE "public"."signal_engine_versions" TO "anon";
GRANT ALL ON TABLE "public"."signal_engine_versions" TO "authenticated";
GRANT ALL ON TABLE "public"."signal_engine_versions" TO "service_role";



GRANT ALL ON TABLE "public"."signal_evidence" TO "anon";
GRANT ALL ON TABLE "public"."signal_evidence" TO "authenticated";
GRANT ALL ON TABLE "public"."signal_evidence" TO "service_role";



GRANT ALL ON TABLE "public"."signal_pipeline_events" TO "anon";
GRANT ALL ON TABLE "public"."signal_pipeline_events" TO "authenticated";
GRANT ALL ON TABLE "public"."signal_pipeline_events" TO "service_role";



GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."signal_results" TO "anon";
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."signal_results" TO "authenticated";
GRANT ALL ON TABLE "public"."signal_results" TO "service_role";



GRANT ALL ON TABLE "public"."signal_revisions" TO "anon";
GRANT ALL ON TABLE "public"."signal_revisions" TO "authenticated";
GRANT ALL ON TABLE "public"."signal_revisions" TO "service_role";



GRANT ALL ON TABLE "public"."signal_unlocks" TO "anon";
GRANT ALL ON TABLE "public"."signal_unlocks" TO "authenticated";
GRANT ALL ON TABLE "public"."signal_unlocks" TO "service_role";



GRANT ALL ON TABLE "public"."signals" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."signals" TO "anon";
GRANT SELECT("id") ON TABLE "public"."signals" TO "authenticated";



GRANT SELECT("stock_id") ON TABLE "public"."signals" TO "anon";
GRANT SELECT("stock_id") ON TABLE "public"."signals" TO "authenticated";



GRANT SELECT("direction") ON TABLE "public"."signals" TO "anon";
GRANT SELECT("direction") ON TABLE "public"."signals" TO "authenticated";



GRANT SELECT("status") ON TABLE "public"."signals" TO "anon";
GRANT SELECT("status") ON TABLE "public"."signals" TO "authenticated";



GRANT SELECT("created_at") ON TABLE "public"."signals" TO "anon";
GRANT SELECT("created_at") ON TABLE "public"."signals" TO "authenticated";



GRANT SELECT("superseded_by") ON TABLE "public"."signals" TO "anon";
GRANT SELECT("superseded_by") ON TABLE "public"."signals" TO "authenticated";



GRANT SELECT("timeframe") ON TABLE "public"."signals" TO "anon";
GRANT SELECT("timeframe") ON TABLE "public"."signals" TO "authenticated";



GRANT SELECT("resolved_at") ON TABLE "public"."signals" TO "anon";
GRANT SELECT("resolved_at") ON TABLE "public"."signals" TO "authenticated";



GRANT ALL ON TABLE "public"."signals_public" TO "anon";
GRANT ALL ON TABLE "public"."signals_public" TO "authenticated";
GRANT ALL ON TABLE "public"."signals_public" TO "service_role";



GRANT ALL ON TABLE "public"."stocks" TO "anon";
GRANT ALL ON TABLE "public"."stocks" TO "authenticated";
GRANT ALL ON TABLE "public"."stocks" TO "service_role";



GRANT ALL ON TABLE "public"."structure_labels" TO "anon";
GRANT ALL ON TABLE "public"."structure_labels" TO "authenticated";
GRANT ALL ON TABLE "public"."structure_labels" TO "service_role";



GRANT ALL ON TABLE "public"."structure_zones" TO "anon";
GRANT ALL ON TABLE "public"."structure_zones" TO "authenticated";
GRANT ALL ON TABLE "public"."structure_zones" TO "service_role";



GRANT ALL ON TABLE "public"."subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."token_transactions" TO "service_role";
GRANT SELECT ON TABLE "public"."token_transactions" TO "authenticated";



GRANT ALL ON TABLE "public"."trading_plans" TO "anon";
GRANT ALL ON TABLE "public"."trading_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."trading_plans" TO "service_role";



GRANT ALL ON TABLE "public"."unusual_activities" TO "anon";
GRANT ALL ON TABLE "public"."unusual_activities" TO "authenticated";
GRANT ALL ON TABLE "public"."unusual_activities" TO "service_role";



GRANT ALL ON TABLE "public"."watchlist_items" TO "anon";
GRANT ALL ON TABLE "public"."watchlist_items" TO "authenticated";
GRANT ALL ON TABLE "public"."watchlist_items" TO "service_role";



GRANT ALL ON TABLE "public"."watchlists" TO "anon";
GRANT ALL ON TABLE "public"."watchlists" TO "authenticated";
GRANT ALL ON TABLE "public"."watchlists" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";



































