alter table public.signals
  add column timeframe text check (timeframe in ('H1','H4','D1','W1')),
  add column risk_reward numeric,
  add column formula_version text default 'baseline_v1',
  add column engine_version text default 'v1',
  add column support_level numeric,
  add column resistance_level numeric,
  add column evidence jsonb,
  add column expires_at timestamptz;

create index idx_signals_stock_tf_status on public.signals (stock_id, timeframe, status);
