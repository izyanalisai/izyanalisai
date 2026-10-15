-- Prevent client invocation of operational or financial SECURITY DEFINER RPCs.
REVOKE ALL ON FUNCTION public.activate_subscription_from_payment(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_subscription_from_payment(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.aggregate_walkforward_backtest(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_bandarmologi_proxy_batch(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auto_backup()
  FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_walkforward_trades_batch
  ON public.backtest_walkforward_trades (batch_id);
CREATE INDEX IF NOT EXISTS idx_walkforward_trades_stock
  ON public.backtest_walkforward_trades (stock_id);
