-- Bound, existing trigger functions retain their triggers; direct client EXECUTE is unnecessary.
-- Permission changes only. This migration does not replace any trigger or function body.
DO $$
DECLARE
  function_names text[] := ARRAY['assert_signal_candles_fresh','enforce_ai_task_limits','enforce_ai_task_limits_on_update','enforce_trading_plan_module_lock','enforce_trading_plan_module_lock_insert','enforce_trading_plan_tier','enforce_watchlist_folder_limit','enforce_watchlist_item_limit','handle_new_user','notify_push_on_new_notification','notify_unusual_activity_subscribers','notify_watchlist_new_signal','notify_watchlist_news','protect_idx_manual_quote','protect_sensitive_profile_columns','protect_signal_immutable_fields','push_market_cap_to_quote','record_signal_result','sync_quote_market_cap','sync_signal_evidence'];
  found_count int;
  fname text;
BEGIN
  SELECT count(*) INTO found_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = ANY(function_names)
    AND p.prosecdef
    AND pg_get_function_result(p.oid) = 'trigger'
    AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid AND NOT t.tgisinternal);
  IF found_count <> cardinality(function_names) THEN
    RAISE EXCEPTION 'TRIGGER_ACL_INVENTORY_CHANGED: expected %, found %', cardinality(function_names), found_count;
  END IF;
  FOREACH fname IN ARRAY function_names LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated', fname);
  END LOOP;
END $$;