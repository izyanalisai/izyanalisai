-- Rate-limit accounting is an internal helper, not a public RPC.
-- Its scope, identity, threshold, and time window are caller-controlled.
-- All SQL consumer functions have SECURITY DEFINER and continue to run with
-- their owner's permissions; service_role remains available to workers.
DO $$
DECLARE
  fn oid := 'public.check_rate_limit(text,text,integer,integer)'::regprocedure::oid;
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = fn) THEN
    RAISE EXCEPTION 'Expected SECURITY DEFINER rate limiter is absent';
  END IF;
  REVOKE ALL ON FUNCTION public.check_rate_limit(text,text,integer,integer)
    FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.check_rate_limit(text,text,integer,integer)
    TO service_role;
  IF has_function_privilege('authenticated', fn, 'EXECUTE')
     OR has_function_privilege('anon', fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'Rate limiter EXECUTE privilege verification failed';
  END IF;
END $$;
