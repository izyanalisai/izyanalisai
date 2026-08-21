CREATE INDEX IF NOT EXISTS idx_session2_setup_previews_nearby_zone_id
  ON public.session2_setup_previews (nearby_zone_id);

ALTER FUNCTION public.get_next_signal_expiry(timestamp with time zone, text) SET search_path = public;
ALTER FUNCTION public.fix_signal_expiry_on_insert() SET search_path = public;

DROP POLICY IF EXISTS rate_limit_hits_deny_all ON public.rate_limit_hits;
CREATE POLICY rate_limit_hits_deny_all ON public.rate_limit_hits
  FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);
