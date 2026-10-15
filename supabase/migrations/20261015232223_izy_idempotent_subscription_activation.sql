-- Prevent duplicate subscription extension when Midtrans retries a settlement
-- or when webhook and user-triggered reconciliation race.
CREATE OR REPLACE FUNCTION public.activate_subscription_from_payment(p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_payment public.payments;
  v_sub_id uuid;
BEGIN
  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND'; END IF;

  -- This link is written in the same transaction as the subscription update.
  -- Waiting concurrent calls re-read the locked row and do not grant 30 more days.
  IF v_payment.subscription_id IS NOT NULL THEN
    RETURN jsonb_build_object('status','already_activated',
                              'subscription_id',v_payment.subscription_id);
  END IF;
  IF v_payment.status IN ('failed','expired') THEN
    RAISE EXCEPTION 'PAYMENT_NOT_PAYABLE';
  END IF;
  SELECT id INTO v_sub_id FROM public.subscriptions
  WHERE user_id = v_payment.user_id
    AND status IN ('active','pending_cancel','grace')
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_sub_id IS NOT NULL THEN
    UPDATE public.subscriptions
      SET status='active',
          period_start=COALESCE(period_start,now()),
          period_end=GREATEST(COALESCE(period_end,now()),now())+INTERVAL '30 days',
          cancel_at_period_end=false,
          grace_ends_at=NULL
    WHERE id=v_sub_id;
  ELSE
    INSERT INTO public.subscriptions(user_id,status,plan,period_start,period_end)
    VALUES(v_payment.user_id,'active','premium_monthly',now(),now()+INTERVAL '30 days')
    RETURNING id INTO v_sub_id;
  END IF;
  UPDATE public.payments SET subscription_id=v_sub_id WHERE id=p_payment_id;
  UPDATE public.profiles SET is_premium=true WHERE id=v_payment.user_id;
  RETURN jsonb_build_object('status','ok','subscription_id',v_sub_id);
END;
$$;
REVOKE ALL ON FUNCTION public.activate_subscription_from_payment(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.activate_subscription_from_payment(uuid)
  TO service_role;
