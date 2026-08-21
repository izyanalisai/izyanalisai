-- Fix: get_signal_history versi lama tidak mengembalikan field downside_support_2
-- untuk signal SELL (Bearish Alert), padahal Stock Detail SELL butuh field itu
-- (spec v5.0 section 6.2 & 9.4). Tambahkan downside_support_2 ke output + unlock gating-nya.
CREATE OR REPLACE FUNCTION public.get_signal_history(
  p_status text DEFAULT NULL::text,
  p_tier text DEFAULT NULL::text,
  p_days integer DEFAULT NULL::integer,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_user uuid := auth.uid();
  v_is_premium boolean := false;
  v_result jsonb;
begin
  if v_user is not null then
    select coalesce(is_premium, false) into v_is_premium from public.profiles where id = v_user;
  end if;

  select jsonb_agg(row_to_json(t)) into v_result from (
    select
      sg.id, st.ticker, st.name as stock_name, sg.direction, sg.timeframe, sg.signal_tier,
      sg.status, sg.created_at, sg.resolved_at, sr.result, sr.r_multiple,
      case when v_is_premium or (v_user is not null and exists (
        select 1 from public.signal_unlocks su
        where su.user_id = v_user and su.stock_id = sg.stock_id
          and su.unlock_date between (sg.created_at at time zone 'Asia/Jakarta')::date
                                  and coalesce((sg.resolved_at at time zone 'Asia/Jakarta')::date, (now() at time zone 'Asia/Jakarta')::date)
      )) then true else false end as unlocked,
      -- preview gratis (sama seperti Stock Detail): Buy Area untuk BUY, Downside Support untuk SELL
      sg.entry_price,
      sg.buy_area_low,
      sg.buy_area_high,
      sg.downside_support_1,
      -- field terkunci di bawah ini butuh unlock, sama untuk BUY maupun SELL
      case when v_is_premium or (v_user is not null and exists (
        select 1 from public.signal_unlocks su
        where su.user_id = v_user and su.stock_id = sg.stock_id
          and su.unlock_date between (sg.created_at at time zone 'Asia/Jakarta')::date
                                  and coalesce((sg.resolved_at at time zone 'Asia/Jakarta')::date, (now() at time zone 'Asia/Jakarta')::date)
      )) then sg.tp1 else null end as tp1,
      case when v_is_premium or (v_user is not null and exists (
        select 1 from public.signal_unlocks su
        where su.user_id = v_user and su.stock_id = sg.stock_id
          and su.unlock_date between (sg.created_at at time zone 'Asia/Jakarta')::date
                                  and coalesce((sg.resolved_at at time zone 'Asia/Jakarta')::date, (now() at time zone 'Asia/Jakarta')::date)
      )) then sg.tp2 else null end as tp2,
      case when v_is_premium or (v_user is not null and exists (
        select 1 from public.signal_unlocks su
        where su.user_id = v_user and su.stock_id = sg.stock_id
          and su.unlock_date between (sg.created_at at time zone 'Asia/Jakarta')::date
                                  and coalesce((sg.resolved_at at time zone 'Asia/Jakarta')::date, (now() at time zone 'Asia/Jakarta')::date)
      )) then sg.stop_loss else null end as stop_loss,
      case when v_is_premium or (v_user is not null and exists (
        select 1 from public.signal_unlocks su
        where su.user_id = v_user and su.stock_id = sg.stock_id
          and su.unlock_date between (sg.created_at at time zone 'Asia/Jakarta')::date
                                  and coalesce((sg.resolved_at at time zone 'Asia/Jakarta')::date, (now() at time zone 'Asia/Jakarta')::date)
      )) then sg.bearish_trigger else null end as bearish_trigger,
      case when v_is_premium or (v_user is not null and exists (
        select 1 from public.signal_unlocks su
        where su.user_id = v_user and su.stock_id = sg.stock_id
          and su.unlock_date between (sg.created_at at time zone 'Asia/Jakarta')::date
                                  and coalesce((sg.resolved_at at time zone 'Asia/Jakarta')::date, (now() at time zone 'Asia/Jakarta')::date)
      )) then sg.invalidation else null end as invalidation,
      case when v_is_premium or (v_user is not null and exists (
        select 1 from public.signal_unlocks su
        where su.user_id = v_user and su.stock_id = sg.stock_id
          and su.unlock_date between (sg.created_at at time zone 'Asia/Jakarta')::date
                                  and coalesce((sg.resolved_at at time zone 'Asia/Jakarta')::date, (now() at time zone 'Asia/Jakarta')::date)
      )) then sg.downside_support_2 else null end as downside_support_2
    from public.signals sg
    join public.stocks st on st.id = sg.stock_id
    left join public.signal_results sr on sr.signal_id = sg.id
    where sg.status in ('HIT_TP1','HIT_TP2','HIT_SL','HIT_SL_LOCKED','EXPIRED','INVALIDATED')
      and (p_status is null or sg.status = p_status)
      and (p_tier is null or sg.signal_tier = p_tier)
      and (p_days is null or sg.created_at >= now() - (p_days || ' days')::interval)
    order by sg.created_at desc
    limit p_limit offset p_offset
  ) t;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;
