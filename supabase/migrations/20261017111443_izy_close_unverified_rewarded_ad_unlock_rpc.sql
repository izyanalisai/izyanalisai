-- Deprecated direct ad unlock does not verify an ad impression.
-- Only the Google-signed AdMob SSV callback may credit rewards, through
-- the service-role-only credit_ad_unlock_verified RPC.
DO $$
DECLARE
  unsafe_fn oid := 'public.unlock_signal_with_ad(uuid)'::regprocedure::oid;
  verified_fn oid := 'public.credit_ad_unlock_verified(uuid,uuid,text,text,numeric)'::regprocedure::oid;
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = unsafe_fn) THEN
    RAISE EXCEPTION 'Deprecated privileged ad-unlock function was not found';
  END IF;
  REVOKE ALL ON FUNCTION public.unlock_signal_with_ad(uuid)
    FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.unlock_signal_with_ad(uuid) TO service_role;
  IF has_function_privilege('anon', unsafe_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', unsafe_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', unsafe_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'Deprecated ad-unlock ACL verification failed';
  END IF;
  IF has_function_privilege('anon', verified_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', verified_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', verified_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'Verified AdMob credit privilege must remain service-role-only';
  END IF;
END $$;
