-- Spec v5.0 section 19: melengkapi Telegram Bot channel.
CREATE TABLE IF NOT EXISTS public.telegram_link_codes (
  code text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  used_at timestamptz
);
COMMENT ON TABLE public.telegram_link_codes IS 'Spec v5.0 section 19: kode sekali pakai (15 menit) buat menghubungkan akun IzyAnalisAi ke chat Telegram user.';

ALTER TABLE public.telegram_link_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_own_link_code" ON public.telegram_link_codes FOR SELECT TO authenticated USING (auth.uid() = user_id);
REVOKE ALL ON public.telegram_link_codes FROM anon, authenticated;
GRANT SELECT ON public.telegram_link_codes TO authenticated;
GRANT ALL ON public.telegram_link_codes TO service_role;

CREATE OR REPLACE FUNCTION public.generate_telegram_link_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  DELETE FROM public.telegram_link_codes WHERE user_id = auth.uid() AND used_at IS NULL;
  v_code := lpad(floor(random() * 1000000)::text, 6, '0');
  INSERT INTO public.telegram_link_codes (code, user_id) VALUES (v_code, auth.uid());
  RETURN v_code;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_telegram_link_code() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.generate_telegram_link_code() TO authenticated;

CREATE OR REPLACE FUNCTION public.notify_push_on_new_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pref record;
  v_allowed boolean := true;
  v_url text; v_key text; v_secret text; v_req_id bigint;
BEGIN
  SELECT * INTO v_pref FROM public.notification_preferences WHERE user_id = NEW.user_id;

  IF v_pref IS NOT NULL THEN
    IF v_pref.master_enabled = false THEN
      v_allowed := false;
    ELSIF NEW.category = 'MARKET' AND v_pref.market_alerts = false THEN v_allowed := false;
    ELSIF NEW.category = 'SIGNAL' AND v_pref.signal_alerts = false THEN v_allowed := false;
    ELSIF NEW.category = 'NEWS' AND v_pref.news_updates = false THEN v_allowed := false;
    ELSIF NEW.category = 'ECONOMIC_EVENT' AND v_pref.economic_events = false THEN v_allowed := false;
    ELSIF NEW.category = 'MORNING_BRIEFING' AND v_pref.morning_briefing = false THEN v_allowed := false;
    ELSIF NEW.category = 'UNUSUAL_ACTIVITY' AND v_pref.unusual_activity_alert = false THEN v_allowed := false;
    END IF;
  END IF;

  IF NOT v_allowed THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'worker_shared_secret';
  IF v_url IS NULL OR v_key IS NULL OR v_secret IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM public.push_subscriptions WHERE user_id = NEW.user_id) THEN
    SELECT net.http_post(
      url := v_url || '/functions/v1/send-web-push',
      headers := jsonb_build_object('Authorization','Bearer ' || v_key,'Content-Type','application/json','x-worker-secret', v_secret),
      body := jsonb_build_object('user_id', NEW.user_id,'title', NEW.title,'body', NEW.body,'category', NEW.category,'reference_id', NEW.reference_id),
      timeout_milliseconds := 15000
    ) INTO v_req_id;
  END IF;

  IF EXISTS (SELECT 1 FROM public.telegram_subscriptions WHERE user_id = NEW.user_id AND is_active = true) THEN
    SELECT net.http_post(
      url := v_url || '/functions/v1/send-telegram-notification',
      headers := jsonb_build_object('Authorization','Bearer ' || v_key,'Content-Type','application/json','x-worker-secret', v_secret),
      body := jsonb_build_object('user_id', NEW.user_id,'title', NEW.title,'body', NEW.body,'category', NEW.category,'reference_id', NEW.reference_id),
      timeout_milliseconds := 15000
    ) INTO v_req_id;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_push_on_new_notification() IS 'Trigger di tabel notifications: fan-out ke Web Push dan Telegram sesuai notification_preferences user. Diupdate 20 Agustus 2026 buat nambahin channel Telegram.';
