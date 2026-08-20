-- Migration: corporate_action_detections + admin review functions
-- Sync dari production Supabase (dibuat 18 Agustus 2026, belum ada di repo migrations)
-- Spec ref: v5.0 section 18.1 / 18.3 (Corporate Action Detection - staging area AI+Regex)
-- Section 32.1: migration repository harus selalu sinkron dengan database production.

create table if not exists public.corporate_action_detections (
  id uuid primary key default gen_random_uuid(),
  stock_id uuid not null references public.stocks(id),
  news_event_id uuid not null references public.news_events(id),
  detected_action_type text,
  detection_method text not null default 'REGEX',
  evidence_summary text,
  status text not null default 'NEW',
  promoted_corporate_action_id uuid references public.corporate_actions(id),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  detected_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.corporate_action_detections is
  'Section 18.1/18.3 spec v5.0: staging area buat hasil deteksi AI+Regex dari news_events (event_type=AKSI_KORPORASI) sebelum admin promote ke corporate_actions. Berita untrusted, jadi tidak boleh langsung auto-invalidate signal.';

-- index buat FK yang belum ke-cover (performance lint)
create index if not exists idx_corporate_action_detections_stock_id
  on public.corporate_action_detections(stock_id);
create index if not exists idx_corporate_action_detections_promoted_id
  on public.corporate_action_detections(promoted_corporate_action_id);
create index if not exists idx_corporate_action_detections_reviewed_by
  on public.corporate_action_detections(reviewed_by);

alter table public.corporate_action_detections enable row level security;

create policy "admin can view detections"
  on public.corporate_action_detections
  for select
  to authenticated
  using (is_current_user_admin());

-- Function: admin_dismiss_corporate_action_detection
create or replace function public.admin_dismiss_corporate_action_detection(
  p_detection_id uuid,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $function$
begin
  if not public.is_current_user_admin() then
    raise exception 'forbidden: admin only';
  end if;

  update public.corporate_action_detections
    set status = 'DISMISSED',
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        evidence_summary = coalesce(evidence_summary,'') || case when p_notes is not null then (' | dismiss note: ' || p_notes) else '' end
    where id = p_detection_id and status = 'NEW';
end;
$function$;

revoke all on function public.admin_dismiss_corporate_action_detection(uuid, text) from public;
grant execute on function public.admin_dismiss_corporate_action_detection(uuid, text) to authenticated;
grant execute on function public.admin_dismiss_corporate_action_detection(uuid, text) to service_role;

-- Function: admin_promote_corporate_action_detection
create or replace function public.admin_promote_corporate_action_detection(
  p_detection_id uuid,
  p_action_type text,
  p_ex_date date,
  p_ratio numeric default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_detection record;
  v_new_id uuid;
begin
  if not public.is_current_user_admin() then
    raise exception 'forbidden: admin only';
  end if;

  select * into v_detection from public.corporate_action_detections where id = p_detection_id;
  if v_detection is null then
    raise exception 'detection not found';
  end if;
  if v_detection.status <> 'NEW' then
    raise exception 'detection sudah diproses (status=%)', v_detection.status;
  end if;

  v_new_id := public.admin_record_corporate_action(
    v_detection.stock_id, p_action_type, p_ex_date, p_ratio, p_notes
  );

  update public.corporate_action_detections
    set status = 'PROMOTED',
        promoted_corporate_action_id = v_new_id,
        reviewed_by = auth.uid(),
        reviewed_at = now()
    where id = p_detection_id;

  return v_new_id;
end;
$function$;

revoke all on function public.admin_promote_corporate_action_detection(uuid, text, date, numeric, text) from public;
grant execute on function public.admin_promote_corporate_action_detection(uuid, text, date, numeric, text) to authenticated;
grant execute on function public.admin_promote_corporate_action_detection(uuid, text, date, numeric, text) to service_role;

-- Note: EXECUTE dari role anon sengaja TIDAK di-grant (fix security lint 19/20 Agustus 2026) --
-- kedua function ini admin-only via is_current_user_admin() internal check, anon tidak butuh akses sama sekali.
