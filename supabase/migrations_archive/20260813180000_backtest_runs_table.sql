-- Tabel hasil backtest, wajib ada sesuai dokumen STRUKTUR LENGKAP FINAL 9.3.1:
-- threshold +5/-5 wajib divalidasi backtest 50 saham LQ45 periode 2024-2026
-- sebelum dianggap layak produksi (Win Rate >=55%, Profit Factor >=1.5,
-- Max Drawdown <=25%). Tiap perubahan bobot indikator wajib dicatat
-- sebagai formula_version baru, jadi hasil backtest juga harus disimpan
-- per formula_version -- bukan angka lepas yang cuma tampil sekali di layar.

create table public.backtest_runs (
  id uuid default gen_random_uuid() primary key,
  formula_version text not null,
  timeframe text not null check (timeframe in ('H1','H4','D1','W1')),
  period_start date not null,
  period_end date not null,
  universe text not null default 'LQ45',
  total_stocks int not null,
  total_trades int not null,
  wins int not null,
  losses int not null,
  timeouts int not null,
  win_rate numeric not null,
  profit_factor numeric,
  max_drawdown_pct numeric not null,
  gross_profit numeric not null,
  gross_loss numeric not null,
  passed boolean not null,
  fail_reasons text[],
  trade_log jsonb,
  created_at timestamptz default now()
);

alter table public.backtest_runs enable row level security;

create policy "backtest_runs readable by all" on public.backtest_runs
  for select using (true);

grant select on public.backtest_runs to anon, authenticated;
grant all on public.backtest_runs to service_role;

create index idx_backtest_runs_formula_tf on public.backtest_runs (formula_version, timeframe, created_at desc);
