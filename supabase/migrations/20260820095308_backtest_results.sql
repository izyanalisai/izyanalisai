-- Migration: backtest_results dan backtest_runs
-- Ditulis: 2026-08-20
-- Deskripsi: Tabel untuk menyimpan hasil backtest signal

CREATE TABLE public.backtest_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  description text,
  strategy_name text NOT NULL,
  timeframe text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  stock_count int NOT NULL DEFAULT 0,
  trade_count int NOT NULL DEFAULT 0,
  win_rate numeric NOT NULL DEFAULT 0,
  total_return_pct numeric NOT NULL DEFAULT 0,
  avg_rr numeric NOT NULL DEFAULT 0,
  max_drawdown_pct numeric,
  sharpe_ratio numeric,
  profit_factor numeric,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  finished_at timestamp with time zone
);

ALTER TABLE public.backtest_runs
  ADD CONSTRAINT backtest_runs_pkey PRIMARY KEY (id);

GRANT ALL ON public.backtest_runs TO service_role;
GRANT SELECT ON public.backtest_runs TO anon, authenticated;

CREATE INDEX idx_backtest_runs_strategy_tf ON public.backtest_runs (strategy_name, timeframe);

CREATE TABLE public.backtest_trades (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  run_id uuid NOT NULL,
  stock_id uuid NOT NULL,
  ticker text NOT NULL,
  direction text NOT NULL, -- BUY / SELL
  entry_ts timestamp with time zone NOT NULL,
  entry_price numeric NOT NULL,
  exit_ts timestamp with time zone,
  exit_price numeric,
  stop_loss numeric,
  take_profit numeric,
  pnl_pct numeric,
  result text NOT NULL, -- WIN / LOSS / BREAKEVEN
  exit_reason text, -- HIT_TP / HIT_SL / SIGNAL_REVERSAL / EXPIRED
  bars_in_trade int DEFAULT 0,
  strategy_params jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.backtest_trades
  ADD CONSTRAINT backtest_trades_pkey PRIMARY KEY (id);

ALTER TABLE public.backtest_trades
  ADD CONSTRAINT backtest_trades_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.backtest_runs(id) ON DELETE CASCADE;

ALTER TABLE public.backtest_trades
  ADD CONSTRAINT backtest_trades_direction_check CHECK (direction = ANY (ARRAY['BUY', 'SELL']));

ALTER TABLE public.backtest_trades
  ADD CONSTRAINT backtest_trades_result_check CHECK (result = ANY (ARRAY['WIN', 'LOSS', 'BREAKEVEN']));

GRANT ALL ON public.backtest_trades TO service_role;
GRANT SELECT ON public.backtest_trades TO anon, authenticated;

CREATE INDEX idx_backtest_trades_run_id ON public.backtest_trades (run_id);
CREATE INDEX idx_backtest_trades_stock_id ON public.backtest_trades (stock_id);
CREATE INDEX idx_backtest_trades_result ON public.backtest_trades (result);
