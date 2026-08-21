-- Root cause ketahuan: REVOKE ... FROM anon saja tidak cukup, karena function baru
-- otomatis dapat GRANT EXECUTE ke PUBLIC (default Postgres) saat dibuat via CREATE FUNCTION.
-- Role 'anon' otomatis ikut PUBLIC grant itu meskipun sudah di-REVOKE khusus dari anon.
-- Fix yang benar: REVOKE FROM PUBLIC dulu, baru GRANT balik eksplisit ke role yang memang perlu.

-- 1) Admin-guarded functions: cabut dari PUBLIC, grant balik ke authenticated saja (admin login sebagai authenticated)
REVOKE EXECUTE ON FUNCTION public.admin_dismiss_corporate_action_detection(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_dismiss_corporate_action_detection(uuid, text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.admin_promote_corporate_action_detection(uuid, text, date, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_promote_corporate_action_detection(uuid, text, date, numeric, text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.admin_trigger_signal_generation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_trigger_signal_generation(text, text) TO authenticated;

-- 2) Cron/internal-only functions: cabut total dari PUBLIC. Tidak di-grant balik ke anon/authenticated
--    sama sekali -- hanya bisa jalan lewat pg_cron (role postgres, tidak kena grant check ini)
--    dan service_role (service_role Supabase bypass grant check biasa).
REVOKE EXECUTE ON FUNCTION public.expire_active_subscriptions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_rate_limit_hits() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auto_backup() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_signal_watch_state(uuid, text, text, text, text, numeric, numeric, text, text, text, numeric, numeric, numeric, text, text) FROM PUBLIC;
