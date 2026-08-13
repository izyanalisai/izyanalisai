CREATE OR REPLACE FUNCTION public.trigger_evaluate_signals()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_url text;
  v_key text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE WARNING 'evaluate-signals: project_url atau service_role_key belum diset di Vault';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := v_url || '/functions/v1/evaluate-signals',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json')
  );
END;
$$;

SELECT cron.schedule('evaluate-signals-session1', '5-59/5 2-4 * * 1-5', $$SELECT public.trigger_evaluate_signals();$$);
SELECT cron.schedule('evaluate-signals-session2a', '35-59/5 6 * * 1-5', $$SELECT public.trigger_evaluate_signals();$$);
SELECT cron.schedule('evaluate-signals-session2b', '0-55/5 7 * * 1-5', $$SELECT public.trigger_evaluate_signals();$$);
