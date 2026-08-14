-- ============================================================
-- FIX 1: Tutup celah paywall — tabel signals bisa dibaca full
-- kolom (buy_area, tp1, tp2, sl, ai_reasoning) oleh siapa saja
-- lewat REST API langsung, tembus token/ad/premium unlock.
-- ============================================================

create or replace view public.signals_public
with (security_invoker = true) as
select
  id,
  stock_id,
  direction,
  timeframe,
  status,
  created_at,
  resolved_at,
  superseded_by
from public.signals;

grant select on public.signals_public to anon, authenticated;

revoke select on public.signals from anon, authenticated;

drop policy if exists "signals readable by all" on public.signals;

-- ============================================================
-- FIX 2: Cabut EXECUTE dari role anon untuk fungsi token/wallet
-- ============================================================
revoke execute on function public.unlock_signal_with_token(uuid, uuid) from anon;
revoke execute on function public.unlock_signal_with_ad(uuid) from anon;
revoke execute on function public.deduct_token(text, uuid) from anon;
revoke execute on function public.credit_ad_unlock(uuid) from anon;
revoke execute on function public.get_my_wallet() from anon;
revoke execute on function public.ensure_wallet_current(uuid) from anon;

-- ============================================================
-- FIX 3: search_path mutable
-- ============================================================
alter function public.trigger_ai_task_executor() set search_path = '';
alter function public.enforce_ai_task_limits() set search_path = '';
alter function public.enforce_ai_task_limits_on_update() set search_path = '';
alter function public.trigger_detect_unusual_activity() set search_path = '';
alter function public.trigger_fetch_news() set search_path = '';
