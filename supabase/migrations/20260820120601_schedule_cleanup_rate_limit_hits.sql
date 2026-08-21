SELECT cron.schedule(
  'cleanup-rate-limit-hits-daily',
  '30 17 * * *',
  $$SELECT public.cleanup_rate_limit_hits();$$
);
