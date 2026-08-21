-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

SET check_function_bodies = false;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE DELETE, INSERT, UPDATE ON TABLES FROM anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE DELETE, INSERT, UPDATE ON TABLES FROM authenticated;

REVOKE ALL ON FUNCTION public.activate_subscription_from_payment(uuid) FROM authenticated;

CREATE OR REPLACE FUNCTION public.admin_dashboard_summary()
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
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

  SELECT COUNT(*) INTO v_open_bug_reports FROM bug_reports WHERE status NOT IN ('CLOSED','RESOLVED');
  SELECT COUNT(*) INTO v_open_feature_requests FROM feature_requests WHERE status NOT IN ('CLOSED','DONE');
  SELECT COUNT(*) INTO v_pending_payments FROM payments WHERE status = 'PENDING';
  SELECT COUNT(*) INTO v_failed_jobs_24h FROM job_runs
    WHERE status = 'ERROR' AND started_at > now() - interval '24 hours';
  SELECT round(avg(rating)::numeric, 2), count(*) INTO v_app_rating_avg, v_app_rating_count
    FROM app_ratings;

  -- Queue Depth: pipeline MTF yang masih RUNNING (spec 26.2 worker monitoring)
  SELECT COUNT(*) INTO v_queue_depth FROM mtf_pipeline_runs WHERE status = 'RUNNING';

  -- Cron error hari ini (WIB), buat "Cron error" widget spec 20.2
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

REVOKE ALL ON FUNCTION public.assert_signal_candles_fresh() FROM authenticated;

CREATE FUNCTION public.auto_backup()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  AS $function$
BEGIN
  -- Trigger backup via pg_dump schedule
    -- Atau pakai Supabase CLI di local/Vercel cron
      PERFORM net.http_post(
          url := 'https://your-backup-endpoint.com/backup',
              headers := '{"Content-Type": "application/json"}'::jsonb,
                  body := '{"project": "izyanalisai"}'::jsonb
                    );
                    END;
                    $function$;

GRANT ALL ON FUNCTION public.auto_backup() TO authenticated;

GRANT ALL ON FUNCTION public.auto_backup() TO service_role;

REVOKE ALL ON FUNCTION public.calculate_trending_scores() FROM authenticated;

CREATE OR REPLACE FUNCTION public.check_rate_limit (
  p_scope          text,
  p_identity       text,
  p_max_hits       integer,
  p_window_seconds integer DEFAULT 60
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
DECLARE
  v_window_start timestamptz;
  v_key text;
  v_count integer;
BEGIN
  -- window dibulatkan ke bawah per p_window_seconds (fixed window)
  v_window_start := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  v_key := p_scope || ':' || coalesce(p_identity, 'anon');

  INSERT INTO public.rate_limit_hits (bucket_key, window_start, hit_count)
  VALUES (v_key, v_window_start, 1)
  ON CONFLICT (bucket_key, window_start)
  DO UPDATE SET hit_count = rate_limit_hits.hit_count + 1
  RETURNING hit_count INTO v_count;

  RETURN v_count <= p_max_hits;
END;
$function$;

COMMENT ON FUNCTION public.check_rate_limit(text,text,integer,integer) IS 'Return true kalau masih di bawah limit (boleh lanjut), false kalau sudah kelebihan. Dipanggil di awal RPC publik yang rawan abuse.';

REVOKE ALL ON FUNCTION public.compute_sector_rotation() FROM authenticated;

REVOKE ALL ON FUNCTION public.credit_ad_unlock_verified(uuid, uuid, text, text, numeric) FROM authenticated;

CREATE OR REPLACE FUNCTION public.deduct_token (
  p_type         text,
  p_reference_id uuid DEFAULT NULL::uuid
)
  RETURNS TABLE (
    balance         integer,
    already_charged boolean
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_wallet_id uuid;
  v_balance integer;
  v_balance_before integer;
  v_last_reset date;
  v_today_wib date := (now() AT TIME ZONE 'Asia/Jakarta')::date;
  v_is_premium boolean;
  v_is_admin boolean;
  v_daily_grant integer;
  v_period_days integer;
  v_existing_id uuid;
  v_grant_before integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  IF p_type IS NULL OR p_type = '' THEN
    RAISE EXCEPTION 'INVALID_TYPE';
  END IF;

  IF NOT public.check_rate_limit('deduct_token', v_user_id::text, 20, 60) THEN
    RAISE EXCEPTION 'RATE_LIMITED: terlalu banyak percobaan, coba lagi sebentar' USING ERRCODE = '42901';
  END IF;

  -- Admin/founder bypass: unlimited token, no deduction, no ledger entry
  SELECT p.is_admin INTO v_is_admin FROM public.profiles p WHERE p.id = v_user_id;
  IF v_is_admin IS TRUE THEN
    RETURN QUERY SELECT 999999, false;
    RETURN;
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

    INSERT INTO public.token_transactions (wallet_id, amount, type, balance_before, balance_after)
    VALUES (v_wallet_id, v_balance, 'DAILY_GRANT', 0, v_balance);
  ELSIF v_today_wib - v_last_reset >= v_period_days THEN
    v_grant_before := v_balance;

    UPDATE public.token_wallets AS tw
      SET balance = v_daily_grant, last_reset_date = v_today_wib
      WHERE tw.id = v_wallet_id
      RETURNING tw.balance INTO v_balance;

    INSERT INTO public.token_transactions (wallet_id, amount, type, balance_before, balance_after)
    VALUES (v_wallet_id, v_balance - v_grant_before, 'DAILY_GRANT', v_grant_before, v_balance);
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
$function$;

REVOKE ALL ON FUNCTION public.detect_unusual_activity() FROM authenticated;

REVOKE ALL ON FUNCTION public.dispatch_morning_briefing() FROM authenticated;

REVOKE ALL ON FUNCTION public.enforce_ai_task_limits_on_update() FROM authenticated;

REVOKE ALL ON FUNCTION public.enforce_ai_task_limits() FROM authenticated;

REVOKE ALL ON FUNCTION public.enforce_trading_plan_module_lock_insert() FROM authenticated;

REVOKE ALL ON FUNCTION public.enforce_trading_plan_module_lock() FROM authenticated;

REVOKE ALL ON FUNCTION public.enforce_trading_plan_tier() FROM authenticated;

REVOKE ALL ON FUNCTION public.enforce_watchlist_folder_limit() FROM authenticated;

REVOKE ALL ON FUNCTION public.enforce_watchlist_item_limit() FROM authenticated;

REVOKE ALL ON FUNCTION public.ensure_wallet_current(uuid) FROM authenticated;

REVOKE ALL ON FUNCTION public.execute_ai_tasks() FROM authenticated;

REVOKE ALL ON FUNCTION public.expire_active_subscriptions() FROM authenticated;

REVOKE ALL ON FUNCTION public.expire_grace_subscriptions() FROM authenticated;

CREATE OR REPLACE FUNCTION public.fix_signal_expiry_on_insert()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO 'public'
  AS $function$
DECLARE
  v_correct_expiry timestamptz;
BEGIN
  -- Hanya fix kalau expires_at di-set ke hari yang sama dengan created_at (bug lama)
  -- atau kalau expires_at < NOW() + 12 jam (terlalu cepat expire)
  IF NEW.expires_at IS NULL OR NEW.expires_at < NOW() + INTERVAL '12 hours' THEN
    v_correct_expiry := get_next_signal_expiry(NOW(), COALESCE(NEW.timeframe, 'daily'));
    NEW.expires_at := v_correct_expiry;
    RAISE LOG 'fix_signal_expiry_on_insert: override expires_at untuk signal % dari % ke %',
      NEW.id, OLD.expires_at, v_correct_expiry;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_telegram_link_code()
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
DECLARE
  v_code text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- hapus kode lama milik user ini yang belum dipakai, biar gak numpuk
  DELETE FROM public.telegram_link_codes WHERE user_id = auth.uid() AND used_at IS NULL;

  v_code := lpad(floor(random() * 1000000)::text, 6, '0');

  INSERT INTO public.telegram_link_codes (code, user_id)
  VALUES (v_code, auth.uid());

  RETURN v_code;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_next_signal_expiry (
  from_ts timestamp with time zone DEFAULT now(),
  tier    text                     DEFAULT 'daily'::text
)
  RETURNS timestamp WITH time zone
  LANGUAGE plpgsql
  STABLE
  SET search_path TO 'public'
  AS $function$
DECLARE
  v_wib_now      date;
  v_next_date    date;
  v_session_close time;
  v_expiry       timestamptz;
  v_days_to_skip int;
BEGIN
  -- Konversi ke WIB (UTC+7) untuk cek tanggal hari ini
  v_wib_now := (from_ts AT TIME ZONE 'Asia/Jakarta')::date;

  -- Swing: skip 1 trading day extra (jadi minimal 2 hari trading ke depan)
  v_days_to_skip := CASE WHEN tier = 'swing' THEN 1 ELSE 0 END;

  -- Cari next trading day setelah hari ini (skip hari ini karena signal dibuat after market)
  SELECT date, session_close
  INTO v_next_date, v_session_close
  FROM market_calendar
  WHERE date > v_wib_now
    AND is_trading_day = true
  ORDER BY date
  LIMIT 1
  OFFSET v_days_to_skip;

  -- Fallback: kalau market_calendar kosong / tidak ada data, pakai +1 hari 15:50 WIB
  IF v_next_date IS NULL THEN
    v_next_date    := v_wib_now + 1;
    v_session_close := '15:50:00'::time;
  END IF;

  -- Kalau session_close NULL (harusnya tidak karena is_trading_day=true), fallback 15:50
  IF v_session_close IS NULL THEN
    v_session_close := '15:50:00'::time;
  END IF;

  -- Gabungkan tanggal + waktu, interpret sebagai WIB, konversi ke UTC timestamptz
  v_expiry := (v_next_date || ' ' || v_session_close)::timestamp AT TIME ZONE 'Asia/Jakarta';

  RETURN v_expiry;
END;
$function$;

COMMENT ON FUNCTION public.get_next_signal_expiry(timestamp with time zone,text) IS 'Hitung expires_at signal berdasarkan market_calendar. 
   Selalu menunjuk ke session_close next trading day (atau +1 hari lagi untuk swing).
   Dipanggil dari generate-signals-mtf dan sebagai safety net trigger.';

REVOKE ALL ON FUNCTION public.get_signal_history(text, text, integer) FROM authenticated;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM authenticated;

REVOKE ALL ON FUNCTION public.job_run_finish(uuid, text, jsonb) FROM authenticated;

REVOKE ALL ON FUNCTION public.job_run_start(text, jsonb) FROM authenticated;

REVOKE ALL ON FUNCTION public.mtf_pipeline_poll() FROM authenticated;

CREATE OR REPLACE FUNCTION public.notify_push_on_new_notification()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
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

  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'worker_shared_secret';
  IF v_url IS NULL OR v_key IS NULL OR v_secret IS NULL THEN
    RETURN NEW;
  END IF;

  -- Web Push (kalau user punya subscription browser)
  IF EXISTS (SELECT 1 FROM public.push_subscriptions WHERE user_id = NEW.user_id) THEN
    SELECT net.http_post(
      url := v_url || '/functions/v1/send-web-push',
      headers := jsonb_build_object('Authorization','Bearer ' || v_key,'Content-Type','application/json','x-worker-secret', v_secret),
      body := jsonb_build_object('user_id', NEW.user_id,'title', NEW.title,'body', NEW.body,'category', NEW.category,'reference_id', NEW.reference_id),
      timeout_milliseconds := 15000
    ) INTO v_req_id;
  END IF;

  -- Telegram (spec v5.0 section 19, kalau user punya chat_id aktif)
  IF EXISTS (SELECT 1 FROM public.telegram_subscriptions WHERE user_id = NEW.user_id AND is_active = true) THEN
    SELECT net.http_post(
      url := v_url || '/functions/v1/send-telegram-notification',
      headers := jsonb_build_object('Authorization','Bearer ' || v_key,'Content-Type','application/json','x-worker-secret', v_secret),
      body := jsonb_build_object('user_id', NEW.user_id,'title', NEW.title,'body', NEW.body,'category', NEW.category,'reference_id', NEW.reference_id),
      timeout_milliseconds := 15000
    ) INTO v_req_id;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.notify_push_on_new_notification() IS 'Trigger di tabel notifications: fan-out ke Web Push (send-web-push) dan Telegram (send-telegram-notification, spec v5.0 section 19) sesuai notification_preferences user. Diupdate 20 Agustus 2026 buat nambahin channel Telegram.';

REVOKE ALL ON FUNCTION public.notify_subscription_renewal_h1() FROM authenticated;

REVOKE ALL ON FUNCTION public.notify_unusual_activity_subscribers() FROM authenticated;

REVOKE ALL ON FUNCTION public.notify_watchlist_new_signal() FROM authenticated;

REVOKE ALL ON FUNCTION public.notify_watchlist_news() FROM authenticated;

REVOKE ALL ON FUNCTION public.process_corporate_actions() FROM authenticated;

REVOKE ALL ON FUNCTION public.process_pending_corporate_actions() FROM authenticated;

REVOKE ALL ON FUNCTION public.protect_idx_manual_candle() FROM authenticated;

REVOKE ALL ON FUNCTION public.protect_idx_manual_quote() FROM authenticated;

REVOKE ALL ON FUNCTION public.protect_sensitive_profile_columns() FROM authenticated;

REVOKE ALL ON FUNCTION public.protect_signal_immutable_fields() FROM authenticated;

REVOKE ALL ON FUNCTION public.push_market_cap_to_quote() FROM authenticated;

REVOKE ALL ON FUNCTION public.reconcile_fetch_ipo_calendar() FROM authenticated;

REVOKE ALL ON FUNCTION public.reconcile_job_runs() FROM authenticated;

REVOKE ALL ON FUNCTION public.record_signal_result() FROM authenticated;

REVOKE ALL ON FUNCTION public.retry_signal_pipeline_mtf_if_needed(text) FROM authenticated;

REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM authenticated;

REVOKE ALL ON FUNCTION public.sync_corporate_action_detections() FROM authenticated;

REVOKE ALL ON FUNCTION public.sync_quote_market_cap() FROM authenticated;

REVOKE ALL ON FUNCTION public.sync_signal_evidence() FROM authenticated;

REVOKE ALL ON FUNCTION public.sync_stock_master() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_ai_task_executor() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_detect_unusual_activity() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_evaluate_session2_preview() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_evaluate_signals() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_fetch_earnings_calendar() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_fetch_economic_calendar() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_fetch_fundamentals() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_fetch_idx_eod() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_fetch_index() FROM authenticated;

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
    RETURN; -- run terakhir sukses (atau belum ada run), skip retry
  END IF;

  PERFORM public.trigger_fetch_ipo_calendar();
END;
$function$;

REVOKE ALL ON FUNCTION public.trigger_fetch_ipo_calendar() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_fetch_news(text) FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_fetch_quotes() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_generate_signal_reasoning() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_generate_trending_reason() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_master_sync_stock() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_morning_briefing() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_process_corporate_actions() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_signal_pipeline_mtf(text) FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_signal_regen_if_yahoo(text) FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_sync_corporate_action_detections() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_trending_score() FROM authenticated;

REVOKE ALL ON FUNCTION public.trigger_unusual_activity_detection() FROM authenticated;

CREATE OR REPLACE FUNCTION public.unlock_signal_with_ad (
  p_stock_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  v_user       uuid := auth.uid();
  v_wallet     public.token_wallets;
  v_today      date := (now() at time zone 'Asia/Jakarta')::date;
  v_is_premium boolean;
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  IF NOT public.check_rate_limit('unlock_signal_with_ad', v_user::text, 15, 60) THEN
    RAISE EXCEPTION 'RATE_LIMITED: terlalu banyak percobaan unlock, coba lagi sebentar' USING ERRCODE = '42901';
  END IF;

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
$function$;

CREATE OR REPLACE FUNCTION public.unlock_signal_with_token (
  p_stock_id        uuid,
  p_idempotency_key uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
declare
  v_user   uuid := auth.uid();
  v_wallet public.token_wallets;
  v_today  date := (now() at time zone 'Asia/Jakarta')::date;
  v_is_admin boolean;
begin
  if v_user is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  IF NOT public.check_rate_limit('unlock_signal_with_token', v_user::text, 15, 60) THEN
    RAISE EXCEPTION 'RATE_LIMITED: terlalu banyak percobaan unlock, coba lagi sebentar' USING ERRCODE = '42901';
  END IF;

  select p.is_admin into v_is_admin from public.profiles p where p.id = v_user;

  if exists (
      select 1 from public.token_transactions
      where reference_id = p_idempotency_key and type = 'SIGNAL_UNLOCK'
    ) then
      return jsonb_build_object('status', 'ok', 'already_processed', true);
  end if;

  -- Admin/founder bypass: unlock without spending tokens
  if v_is_admin is true then
    insert into public.signal_unlocks (user_id, stock_id, unlock_date, source)
    values (v_user, p_stock_id, v_today, 'ADMIN')
    on conflict (user_id, stock_id, unlock_date) do nothing;

    return jsonb_build_object('status', 'ok', 'balance', 999999);
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
$function$;

REVOKE ALL ON public.ad_verifications FROM anon;

REVOKE ALL ON public.app_ratings FROM anon;

REVOKE ALL ON public.internal_secrets FROM anon;

REVOKE ALL ON public.internal_secrets FROM authenticated;

ALTER TABLE public.news
  ADD COLUMN is_catalyst boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN public.news.is_catalyst IS 'Spec 13.5: true kalau sentiment positive + ada ticker ter-mapping. Badge 🔥 Katalis di UI. TIDAK otomatis berarti bullish.';

ALTER TABLE public.news
  ADD COLUMN impact text;

COMMENT ON COLUMN public.news.impact IS 'Spec 13.6: klasifikasi dampak berita, terpisah dari sentiment. Nilai: potentially_positive/potentially_negative/mixed_unclear/informational.';

ALTER TABLE public.news
  ADD CONSTRAINT news_impact_check
    CHECK (impact IS NULL OR (impact = ANY (ARRAY['potentially_positive'::text, 'potentially_negative'::text, 'mixed_unclear'::text, 'informational'::text])));

REVOKE ALL ON public.profiles FROM anon;

COMMENT ON TABLE public.rate_limit_hits IS 'Fixed-window rate limiter. bucket_key = "<scope>:<identity>:<window_start_epoch>". Dibersihkan otomatis oleh cleanup_rate_limit_hits via cron.';

REVOKE SELECT ON public.signal_results FROM anon;

REVOKE SELECT ON public.signal_results FROM authenticated;

REVOKE DELETE, INSERT, MAINTAIN, REFERENCES, TRIGGER, TRUNCATE, UPDATE ON public.signals FROM anon;

REVOKE DELETE, INSERT, MAINTAIN, REFERENCES, TRIGGER, TRUNCATE, UPDATE ON public.signals FROM authenticated;

COMMENT ON TABLE public.telegram_link_codes IS 'Spec v5.0 section 19: kode sekali pakai (15 menit) buat menghubungkan akun IzyAnalisAi ke chat Telegram user. Alur: user generate kode via RPC generate_telegram_link_code() di app -> user kirim /start <kode> ke bot -> edge function telegram-webhook validasi kode -> insert ke telegram_subscriptions.';

REVOKE ALL ON public.token_transactions FROM anon;

REVOKE DELETE, INSERT, MAINTAIN, REFERENCES, TRIGGER, TRUNCATE, UPDATE ON public.token_transactions FROM authenticated;

REVOKE ALL ON public.token_wallets FROM anon;

REVOKE DELETE, INSERT, MAINTAIN, REFERENCES, TRIGGER, TRUNCATE, UPDATE ON public.token_wallets FROM authenticated;

COMMENT ON TRIGGER trg_fix_signal_expiry ON public.signals IS 'Safety net: override expires_at kalau di-set terlalu pendek (< 12 jam dari sekarang).
   Ini handle kasus generate-signals-mtf masih pakai hardcode 15:30 WIB hari yang sama.';
