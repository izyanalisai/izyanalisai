-- Worker 9 (AI Task Executor): tiap 5 menit, 24/7 (poin 14.2).
CREATE OR REPLACE FUNCTION public.trigger_ai_task_executor()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
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

SELECT cron.schedule('ai-task-executor', '*/5 * * * *', $$SELECT public.trigger_ai_task_executor();$$);

-- Worker 10 (Unusual Activity Detector): tiap 5 menit saat sesi pasar (poin 14.2).
CREATE OR REPLACE FUNCTION public.trigger_detect_unusual_activity()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_url text; v_key text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE WARNING 'detect-unusual-activity: project_url/service_role_key belum di Vault'; RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_url || '/functions/v1/detect-unusual-activity',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json')
  );
END; $$;

SELECT cron.schedule('unusual-activity-session1', '5-59/5 2-4 * * 1-5', $$SELECT public.trigger_detect_unusual_activity();$$);
SELECT cron.schedule('unusual-activity-session2a', '35-59/5 6 * * 1-5', $$SELECT public.trigger_detect_unusual_activity();$$);
SELECT cron.schedule('unusual-activity-session2b', '0-55/5 7 * * 1-5', $$SELECT public.trigger_detect_unusual_activity();$$);
