-- Subscription housekeeping must not be callable by untrusted users.
-- Normal cancel_subscription and other end-user RPCs remain unchanged.
-- No customer subscription or notification rows are modified here.
DO $$
DECLARE
  fn_name text;
  fn_oid oid;
  internal_functions text[] := ARRAY[
    'expire_active_subscriptions',
    'expire_grace_subscriptions',
    'notify_subscription_renewal_h1'
  ];
BEGIN
  FOREACH fn_name IN ARRAY internal_functions LOOP
    fn_oid := to_regprocedure(format('public.%I()',fn_name))::oid;
    IF fn_oid IS NULL OR NOT (
      SELECT p.prosecdef AND p.prokind = 'f' FROM pg_proc p WHERE p.oid = fn_oid
    ) THEN
      RAISE EXCEPTION 'Expected internal SECURITY DEFINER function not found: %',fn_name;
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated',fn_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I() TO service_role',fn_name);
    IF has_function_privilege('anon',fn_oid,'EXECUTE')
       OR has_function_privilege('authenticated',fn_oid,'EXECUTE')
       OR NOT has_function_privilege('service_role',fn_oid,'EXECUTE') THEN
      RAISE EXCEPTION 'Unexpected subscription housekeeping ACL: %',fn_name;
    END IF;
  END LOOP;
END $$;
