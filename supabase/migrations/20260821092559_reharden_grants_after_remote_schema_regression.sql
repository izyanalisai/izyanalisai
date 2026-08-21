-- Regresi: migration remote_schema tanggal 21 Agustus 2026 CREATE OR REPLACE beberapa function
-- dan reset grant EXECUTE ke default (PUBLIC), sehingga hardening 20 Agustus hilang lagi.
-- Terapkan ulang + perketat beberapa function baru yang belum pernah di-guard.

-- 1) Function admin (sudah ada guard is_current_user_admin() di dalam) -- cabut dari anon saja,
--    authenticated tetap perlu supaya admin (yang login) bisa pakai.
REVOKE EXECUTE ON FUNCTION public.admin_dismiss_corporate_action_detection(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_promote_corporate_action_detection(uuid, text, date, numeric, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_trigger_signal_generation(text, text) FROM anon;

-- 2) Function cron/internal murni (tidak ada guard sama sekali, tidak pernah dipanggil user) --
--    cabut total dari anon & authenticated. Tetap bisa dipanggil oleh pg_cron (role postgres) dan service_role.
REVOKE EXECUTE ON FUNCTION public.expire_active_subscriptions() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_rate_limit_hits() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auto_backup() FROM anon, authenticated;

-- 3) upsert_signal_watch_state: TIDAK ADA guard sama sekali & bisa dipakai nulis data watch-state
--    palsu untuk saham manapun kalau dipanggil dari anon/authenticated. Ini dipanggil engine
--    lewat service_role dari edge function, jadi aman dicabut dari anon & authenticated.
REVOKE EXECUTE ON FUNCTION public.upsert_signal_watch_state(uuid, text, text, text, text, numeric, numeric, text, text, text, numeric, numeric, numeric, text, text) FROM anon, authenticated;

-- 4) auto_backup belum punya SET search_path (lint function_search_path_mutable) -- set eksplisit.
ALTER FUNCTION public.auto_backup() SET search_path = public;
