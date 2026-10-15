-- Enforce one unresolved provider payment per user atomically across workers.
-- A provider timeout is not a definitive rejection, so the pending order must
-- be reconciled before another charge may be attempted.
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_pending_per_user
  ON public.payments (user_id) WHERE status='pending';
