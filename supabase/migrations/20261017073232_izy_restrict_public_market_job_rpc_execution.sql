-- Direct API clients must not execute privileged scheduled market jobs.
-- Keep internal scheduler and service_role execution intact; user-facing RPCs are untouched.
DO $$
DECLARE
  protected_names text[] := ARRAY[
    'calculate_trending_scores',
    'compute_fear_greed_index',
    'compute_sector_rotation',
    'detect_unusual_activity',
    'reconcile_fetch_ipo_calendar',
    'trigger_fetch_news',
    'trigger_signal_pipeline_mtf'
  ];
  item record;
  found_names text[] := ARRAY[]::text[];
BEGIN
  FOR item IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS arguments
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(protected_names)
      AND p.prosecdef
  LOOP
    IF item.proname = ANY(found_names) THEN
      RAISE EXCEPTION 'Unexpected overload for protected market job: %', item.proname;
    END IF;
    found_names := array_append(found_names, item.proname);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated',
                   item.proname, item.arguments);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role',
                   item.proname, item.arguments);
    IF has_function_privilege('anon', item.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', item.oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', item.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Market job ACL verification failed: %', item.proname;
    END IF;
  END LOOP;
  IF cardinality(found_names) <> cardinality(protected_names) THEN
    RAISE EXCEPTION 'Protected market job inventory changed: found %, expected %',
      cardinality(found_names), cardinality(protected_names);
  END IF;
END $$;
