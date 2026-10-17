-- Izy: callable business RPCs remain intact. Privileged internal jobs and the
-- arbitrary-user wallet helper must never be directly callable over PostgREST.
-- SECURITY DEFINER wrappers (get_my_wallet/unlock_*) execute as their owner.
DO $$
DECLARE
  protected_names text[] := ARRAY[
    'ensure_wallet_current',
    'trigger_fetch_quotes',
    'trigger_evaluate_signals',
    'trigger_ai_task_executor',
    'trigger_detect_unusual_activity',
    'mtf_pipeline_poll',
    'retry_signal_pipeline_mtf_if_needed',
    'process_pending_corporate_actions'
  ];
  item record;
  found_names text[] := ARRAY[]::text[];
BEGIN
  FOR item IN
    SELECT p.oid, p.proname,
           pg_get_function_identity_arguments(p.oid) AS arguments
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(protected_names)
      AND p.prosecdef
  LOOP
    IF item.proname = ANY(found_names) THEN
      RAISE EXCEPTION 'Unexpected overload for protected Izy RPC: %', item.proname;
    END IF;
    found_names := array_append(found_names, item.proname);
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated',
      item.proname, item.arguments
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role',
      item.proname, item.arguments
    );
    IF has_function_privilege('anon', item.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', item.oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', item.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Protected Izy RPC ACL verification failed: %', item.proname;
    END IF;
  END LOOP;
  IF cardinality(found_names) <> cardinality(protected_names) THEN
    RAISE EXCEPTION 'Protected Izy RPC inventory mismatch: found %, expected %',
      cardinality(found_names), cardinality(protected_names);
  END IF;
END $$;
