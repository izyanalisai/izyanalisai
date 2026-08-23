-- Fix bug: admin_dashboard_summary() menghitung pending_payments dengan
-- WHERE status = 'PENDING' (uppercase), padahal kolom payments.status
-- punya CHECK constraint yang cuma izinkan lowercase
-- ('pending','success','expired','failed') sesuai yang dipakai
-- midtrans-webhook. Akibatnya counter "pending_payments" di admin
-- dashboard selalu tampil 0 walau ada payment pending sungguhan --
-- tidak error, cuma salah data (ditemukan di audit 22 Agustus 2026).
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
  -- FIX: 'PENDING' (uppercase) -> 'pending' (lowercase), sesuai payments_status_check
  SELECT COUNT(*) INTO v_pending_payments FROM payments WHERE status = 'pending';
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
