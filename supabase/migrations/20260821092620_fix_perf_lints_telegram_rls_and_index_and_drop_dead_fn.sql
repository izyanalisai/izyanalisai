-- perf: bungkus auth.uid() dengan (select auth.uid()) biar tidak re-evaluate per row
ALTER POLICY select_own_link_code ON public.telegram_link_codes
  USING ((select auth.uid()) = user_id);

ALTER POLICY select_own_telegram_subscription ON public.telegram_subscriptions
  USING ((select auth.uid()) = user_id);

ALTER POLICY delete_own_telegram_subscription ON public.telegram_subscriptions
  USING ((select auth.uid()) = user_id);

ALTER POLICY insert_own_telegram_subscription ON public.telegram_subscriptions
  WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY update_own_telegram_subscription ON public.telegram_subscriptions
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- perf: index untuk FK yang belum ke-cover
CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_user_id ON public.telegram_link_codes(user_id);

-- cleanup: drop overload get_signal_history(3 args) yang sudah tidak dipakai frontend manapun
-- (frontend cuma manggil versi 5 args yang jsonb). Overload lama ini tidak exposed ke anon/authenticated
-- jadi tidak exploitable, tapi tetap dead code yang membingungkan (duplikat nama function).
DROP FUNCTION IF EXISTS public.get_signal_history(text, text, integer);
