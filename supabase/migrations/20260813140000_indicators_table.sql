create table public.indicators (
  id uuid default gen_random_uuid() primary key,
  stock_id uuid not null references public.stocks(id) on delete cascade,
  timeframe text not null check (timeframe in ('H1','H4','D1','W1')),
  ts timestamptz not null,
  ema5 numeric,
  ema9 numeric,
  ema21 numeric,
  ema50 numeric,
  rsi14 numeric,
  macd_line numeric,
  macd_signal numeric,
  macd_hist numeric,
  stoch_k numeric,
  stoch_d numeric,
  volume_avg20 numeric,
  updated_at timestamptz default now(),
  unique(stock_id, timeframe)
);

alter table public.indicators enable row level security;

create policy "indicators readable by all" on public.indicators
  for select using (true);

grant select on public.indicators to anon, authenticated;
grant all on public.indicators to service_role;

create index idx_indicators_stock_tf on public.indicators (stock_id, timeframe);
