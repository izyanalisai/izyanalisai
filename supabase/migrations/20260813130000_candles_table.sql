create table public.candles (
  id uuid default gen_random_uuid() primary key,
  stock_id uuid not null references public.stocks(id) on delete cascade,
  timeframe text not null check (timeframe in ('H1','H4','D1','W1')),
  ts timestamptz not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume numeric,
  created_at timestamptz default now(),
  unique(stock_id, timeframe, ts)
);

alter table public.candles enable row level security;

create policy "candles readable by all" on public.candles
  for select using (true);

grant select on public.candles to anon, authenticated;
grant all on public.candles to service_role;

create index idx_candles_stock_tf_ts on public.candles (stock_id, timeframe, ts desc);
