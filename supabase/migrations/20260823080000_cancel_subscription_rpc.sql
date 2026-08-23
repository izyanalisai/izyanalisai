-- Fix untuk fitur "Batalkan Langganan" yang sebelumnya patah total: frontend
-- (app/berlangganan/page.tsx) sudah diperbaiki untuk memanggil RPC
-- cancel_subscription(), TAPI RPC tersebut belum pernah dibuat di database
-- sama sekali -- akibatnya tiap user klik "Batalkan Langganan" akan dapat
-- error (jujur ditampilkan, tidak lagi silent-fail seperti bug sebelumnya,
-- tapi fiturnya tetap tidak berfungsi).
--
-- cancel_subscription(): SECURITY DEFINER, auth check via auth.uid(),
-- idempotent (kalau sudah pending_cancel/expired, return already_cancelled
-- tanpa error), audit log ke audit_logs. Premium TETAP aktif sampai
-- period_end -- ini "cancel di akhir periode", bukan cancel instan.
CREATE OR REPLACE FUNCTION public.cancel_subscription()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid;
  v_sub public.subscriptions;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_sub
  FROM public.subscriptions
  WHERE user_id = v_user_id
    AND status IN ('active', 'grace')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('already_cancelled', true);
  END IF;

  IF v_sub.cancel_at_period_end THEN
    RETURN jsonb_build_object('already_cancelled', true);
  END IF;

  UPDATE public.subscriptions
  SET status = 'pending_cancel',
      cancel_at_period_end = true
  WHERE id = v_sub.id;

  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, detail)
  VALUES (v_user_id, 'SUBSCRIPTION_CANCEL_REQUESTED', 'subscriptions', v_sub.id,
          jsonb_build_object('period_end', v_sub.period_end));

  RETURN jsonb_build_object('already_cancelled', false, 'period_end', v_sub.period_end);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_subscription() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_subscription() TO authenticated;

COMMENT ON FUNCTION public.cancel_subscription() IS
  'Membatalkan langganan di akhir periode (set status=pending_cancel, cancel_at_period_end=true). Premium tetap aktif sampai period_end. SECURITY DEFINER, idempotent, audit logged. Menggantikan update client-side langsung yang diblokir RLS secara silent (bug ditemukan 22 Agustus 2026).';

-- expire_active_subscriptions() sebelumnya CUMA mengecek status='active' --
-- subscription yang sudah di-cancel (status='pending_cancel') tidak pernah
-- tertangkap sama sekali walau period_end sudah lewat, jadi cancel_at_period_end
-- yang di-set RPC di atas tidak akan pernah benar-benar berefek. Diperbaiki
-- supaya kedua status ditangani sama.
CREATE OR REPLACE FUNCTION public.expire_active_subscriptions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.subscriptions
    SET status = 'expired'
    WHERE status IN ('active', 'pending_cancel')
      AND period_end IS NOT NULL
      AND period_end < now();

  UPDATE public.profiles p
    SET is_premium = false
    FROM public.subscriptions s
    WHERE s.user_id = p.id
      AND s.status = 'expired'
      AND p.is_premium = true
      AND NOT EXISTS (
        SELECT 1 FROM public.subscriptions s2
        WHERE s2.user_id = p.id AND s2.status IN ('active', 'grace', 'pending_cancel')
      );
END;
$$;

COMMENT ON FUNCTION public.expire_active_subscriptions() IS
  'Expire subscription yang period_end sudah lewat, baik masih active maupun sudah pending_cancel (fix 23 Agustus 2026 -- sebelumnya pending_cancel tidak pernah tertangkap sama sekali sehingga cancel_at_period_end tidak fungsional).';

GRANT ALL ON FUNCTION public.expire_active_subscriptions() TO service_role;

-- expire_active_subscriptions() ternyata TIDAK PERNAH dijadwalkan cron
-- manapun (dicek: cuma didefinisikan + di-grant, tidak ada cron.schedule
-- yang memanggilnya) -- artinya subscription yang period_end-nya sudah
-- lewat tidak akan pernah otomatis pindah status ke 'expired' kecuali
-- dipanggil manual. Fix cancel_subscription() di atas jadi tidak lengkap
-- tanpa ini. Dijadwalkan tiap jam, cukup sering untuk granularitas harian
-- tanpa membebani database.
SELECT cron.schedule(
  'expire-active-subscriptions-hourly',
  '0 * * * *',
  $$SELECT public.expire_active_subscriptions();$$
);
