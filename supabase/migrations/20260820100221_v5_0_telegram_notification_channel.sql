-- Spec v5.0 section 19: Notification platform = Web Push + Telegram Bot (WhatsApp = POST-LAUNCH, skip)
-- Table to store user's linked Telegram chat_id (like push_subscriptions but for Telegram)
CREATE TABLE IF NOT EXISTS public.telegram_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  last_sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, chat_id)
);

COMMENT ON TABLE public.telegram_subscriptions IS 'Spec v5.0 section 19: channel notifikasi Telegram Bot (selain Web Push). Dibuat 20 Agustus 2026. chat_id didapat dari webhook /start bot Telegram, dihubungkan ke user via kode link sekali pakai (link_code di profiles atau tabel terpisah, TBD saat implementasi edge function telegram-webhook).';

ALTER TABLE public.telegram_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_telegram_subscription" ON public.telegram_subscriptions
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "insert_own_telegram_subscription" ON public.telegram_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "update_own_telegram_subscription" ON public.telegram_subscriptions
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "delete_own_telegram_subscription" ON public.telegram_subscriptions
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.telegram_subscriptions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegram_subscriptions TO authenticated;
GRANT ALL ON public.telegram_subscriptions TO service_role;

CREATE INDEX IF NOT EXISTS idx_telegram_subscriptions_user_active
  ON public.telegram_subscriptions(user_id) WHERE is_active = true;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at' AND pronamespace = 'public'::regnamespace) THEN
    EXECUTE 'CREATE TRIGGER trg_telegram_subscriptions_updated_at
      BEFORE UPDATE ON public.telegram_subscriptions
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()';
  END IF;
END $$;
