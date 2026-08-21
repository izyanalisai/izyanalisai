-- Spec v5.0 section 20.2 (MVP Admin minimum)
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

CREATE OR REPLACE FUNCTION public.admin_trigger_signal_generation(p_tier text, p_reason text DEFAULT 'manual trigger by admin')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing int;
BEGIN
  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF p_tier NOT IN ('daily','swing') THEN
    RAISE EXCEPTION 'tier tidak dikenal: %', p_tier;
  END IF;

  SELECT count(*) INTO v_existing FROM public.mtf_pipeline_runs WHERE tier = p_tier AND status = 'RUNNING';
  IF v_existing > 0 THEN
    RETURN jsonb_build_object('triggered', false, 'reason', 'pipeline tier ini masih RUNNING, tunggu selesai dulu');
  END IF;

  INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, reason, detail, created_at)
  VALUES (gen_random_uuid(), auth.uid(), 'MANUAL_SIGNAL_GENERATION', 'mtf_pipeline', NULL, p_reason,
    jsonb_build_object('tier', p_tier), now());

  PERFORM public.trigger_signal_pipeline_mtf(p_tier);

  RETURN jsonb_build_object('triggered', true, 'tier', p_tier);
END;
$function$;
