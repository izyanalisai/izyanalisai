create table public.quotes (
  id uuid default gen_random_uuid() primary key,
  stock_id uuid not null references public.stocks(id) on delete cascade,
  price numeric,
  previous_close numeric,
  day_high numeric,
  day_low numeric,
  volume numeric,
  market_time timestamptz,
  quality text default 'FRESH' check (quality in ('FRESH','STALE','MISSING','INVALID')),
  updated_at timestamptz default now(),
  unique(stock_id)
);

alter table public.quotes enable row level security;

create policy "quotes readable by all" on public.quotes
  for select using (true);

grant select on public.quotes to anon, authenticated;
grant all on public.quotes to service_role;

create index idx_quotes_stock_id on public.quotes(stock_id);
