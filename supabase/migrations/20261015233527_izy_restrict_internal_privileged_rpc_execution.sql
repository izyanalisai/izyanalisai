-- Deny direct public RPC access to privileged internal jobs and ad verification.
-- Verified against hosted Supabase on 2026-10-15. service_role retains EXECUTE;
-- user-facing rate limits, token-wallet, and admin-guarded APIs are unchanged.
DO $$
DECLARE
  p record;
  protected_names text[] := ARRAY[
    'credit_ad_unlock_verified', 'run_token_ledger_tests',
    'job_run_start', 'job_run_finish', 'upsert_signal_watch_state',
    'sync_stock_master', 'dispatch_morning_briefing',
    'execute_ai_tasks', 'cleanup_rate_limit_hits'
  ];
  found_count integer := 0;
BEGIN
  FOR p IN
    SELECT n.nspname AS schema_name, proc.proname AS function_name,
           pg_get_function_identity_arguments(proc.oid) AS arguments
    FROM pg_proc proc
    JOIN pg_namespace n ON n.oid = proc.pronamespace
    WHERE n.nspname = 'public' AND proc.proname = ANY(protected_names)
      AND proc.prosecdef
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC, anon, authenticated',
                   p.schema_name, p.function_name, p.arguments);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO service_role',
                   p.schema_name, p.function_name, p.arguments);
    found_count := found_count + 1;
  END LOOP;
  IF found_count < cardinality(protected_names) THEN
    RAISE EXCEPTION 'Privileged RPC guard incomplete: found %, expected at least %',
                    found_count, cardinality(protected_names);
  END IF;
END $$;
