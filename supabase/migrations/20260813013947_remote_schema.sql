-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

SET check_function_bodies = false;

DROP EXTENSION pg_net;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO service_role;

CREATE OR REPLACE FUNCTION public.handle_new_user()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  AS $function$
begin
  insert into public.profiles (id, full_name, created_at)
    values (new.id, new.raw_user_meta_data->>'full_name', now());
      return new;
      end;
      $function$;

CREATE TABLE public.profiles (
  id           uuid                     NOT NULL,
  full_name    text,
  risk_profile text,
  is_premium   boolean                  DEFAULT false,
  deleted_at   timestamp with time zone,
  is_active    boolean                  DEFAULT true,
  created_at   timestamp with time zone DEFAULT now()
);

ALTER TABLE public.profiles
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_risk_profile_check CHECK (risk_profile = ANY (ARRAY['konservatif'::text, 'moderat'::text, 'agresif'::text]));

GRANT ALL ON public.profiles TO anon;

GRANT ALL ON public.profiles TO authenticated;

GRANT ALL ON public.profiles TO service_role;

CREATE POLICY "own profile" ON public.profiles
  USING ((auth.uid() = id));

CREATE TABLE public.saved_signals (
  id              uuid                     DEFAULT gen_random_uuid() NOT NULL,
  user_id         uuid,
  signal_snapshot jsonb                    NOT NULL,
  created_at      timestamp with time zone DEFAULT now()
);

ALTER TABLE public.saved_signals
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.saved_signals
  ADD CONSTRAINT saved_signals_pkey PRIMARY KEY (id);

ALTER TABLE public.saved_signals
  ADD CONSTRAINT saved_signals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

GRANT ALL ON public.saved_signals TO anon;

GRANT ALL ON public.saved_signals TO authenticated;

GRANT ALL ON public.saved_signals TO service_role;

CREATE POLICY "own saved signals" ON public.saved_signals
  USING ((auth.uid() = user_id));

CREATE TABLE public.sectors (
  id         uuid                     DEFAULT gen_random_uuid() NOT NULL,
  name       text                     NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.sectors
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sectors
  ADD CONSTRAINT sectors_pkey PRIMARY KEY (id);

GRANT ALL ON public.sectors TO anon;

GRANT ALL ON public.sectors TO authenticated;

GRANT ALL ON public.sectors TO service_role;

CREATE POLICY "sectors readable by all" ON public.sectors
  FOR SELECT
  USING (true);

CREATE TABLE public.signals (
  id               uuid                     DEFAULT gen_random_uuid() NOT NULL,
  stock_id         uuid,
  direction        text,
  entry_price      numeric,
  buy_area_low     numeric,
  buy_area_high    numeric,
  tp1              numeric,
  tp2              numeric,
  stop_loss        numeric,
  confidence_score numeric,
  status           text                     DEFAULT 'ACTIVE'::text,
  ai_reasoning     jsonb,
  triggered_at     timestamp with time zone,
  created_at       timestamp with time zone DEFAULT now(),
  superseded_by    uuid
);

ALTER TABLE public.signals
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.signals
  ADD CONSTRAINT signals_direction_check CHECK (direction = ANY (ARRAY['BUY'::text, 'SELL'::text, 'HOLD'::text]));

ALTER TABLE public.signals
  ADD CONSTRAINT signals_pkey PRIMARY KEY (id);

ALTER TABLE public.signals
  ADD CONSTRAINT signals_status_check CHECK (status = ANY (ARRAY['ACTIVE'::text, 'HIT_TP1'::text, 'HIT_TP2'::text, 'HIT_SL'::text, 'EXPIRED'::text, 'INVALIDATED'::text]));

ALTER TABLE public.signals
  ADD CONSTRAINT signals_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.signals(id);

GRANT ALL ON public.signals TO anon;

GRANT ALL ON public.signals TO authenticated;

GRANT ALL ON public.signals TO service_role;

CREATE INDEX idx_signals_stock_status ON public.signals (stock_id, status);

CREATE POLICY "signals readable by all" ON public.signals
  FOR SELECT
  USING (true);

CREATE TABLE public.stocks (
  id         uuid                     DEFAULT gen_random_uuid() NOT NULL,
  ticker     text                     NOT NULL,
  name       text                     NOT NULL,
  sector_id  uuid,
  is_active  boolean                  DEFAULT true,
  created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.stocks
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.stocks
  ADD CONSTRAINT stocks_pkey PRIMARY KEY (id);

ALTER TABLE public.signals
  ADD CONSTRAINT signals_stock_id_fkey FOREIGN KEY (stock_id) REFERENCES public.stocks(id);

ALTER TABLE public.stocks
  ADD CONSTRAINT stocks_sector_id_fkey FOREIGN KEY (sector_id) REFERENCES public.sectors(id);

ALTER TABLE public.stocks
  ADD CONSTRAINT stocks_ticker_key UNIQUE (ticker);

GRANT ALL ON public.stocks TO anon;

GRANT ALL ON public.stocks TO authenticated;

GRANT ALL ON public.stocks TO service_role;

CREATE INDEX idx_stocks_ticker ON public.stocks (ticker);

CREATE POLICY "stocks readable by all" ON public.stocks
  FOR SELECT
  USING (true);

CREATE TABLE public.token_transactions (
  id           uuid                     DEFAULT gen_random_uuid() NOT NULL,
  wallet_id    uuid,
  amount       integer                  NOT NULL,
  type         text                     NOT NULL,
  reference_id uuid,
  created_at   timestamp with time zone DEFAULT now()
);

ALTER TABLE public.token_transactions
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.token_transactions
  ADD CONSTRAINT token_transactions_pkey PRIMARY KEY (id);

GRANT ALL ON public.token_transactions TO anon;

GRANT ALL ON public.token_transactions TO authenticated;

GRANT ALL ON public.token_transactions TO service_role;

CREATE TABLE public.token_wallets (
  id              uuid    DEFAULT gen_random_uuid() NOT NULL,
  user_id         uuid,
  balance         integer DEFAULT 5,
  last_reset_date date    DEFAULT CURRENT_DATE
);

CREATE POLICY "own token transactions" ON public.token_transactions
  USING ((EXISTS ( SELECT 1
   FROM public.token_wallets tw
  WHERE ((tw.id = token_transactions.wallet_id) AND (tw.user_id = auth.uid())))));

ALTER TABLE public.token_wallets
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.token_wallets
  ADD CONSTRAINT token_wallets_pkey PRIMARY KEY (id);

ALTER TABLE public.token_transactions
  ADD CONSTRAINT token_transactions_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES public.token_wallets(id) ON DELETE CASCADE;

ALTER TABLE public.token_wallets
  ADD CONSTRAINT token_wallets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.token_wallets
  ADD CONSTRAINT token_wallets_user_id_key UNIQUE (user_id);

GRANT ALL ON public.token_wallets TO anon;

GRANT ALL ON public.token_wallets TO authenticated;

GRANT ALL ON public.token_wallets TO service_role;

CREATE POLICY "own token wallet" ON public.token_wallets
  USING ((auth.uid() = user_id));

CREATE TABLE public.watchlist_items (
  id           uuid                     DEFAULT gen_random_uuid() NOT NULL,
  watchlist_id uuid,
  stock_id     uuid,
  created_at   timestamp with time zone DEFAULT now()
);

ALTER TABLE public.watchlist_items
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.watchlist_items
  ADD CONSTRAINT watchlist_items_pkey PRIMARY KEY (id);

ALTER TABLE public.watchlist_items
  ADD CONSTRAINT watchlist_items_stock_id_fkey FOREIGN KEY (stock_id) REFERENCES public.stocks(id);

GRANT ALL ON public.watchlist_items TO anon;

GRANT ALL ON public.watchlist_items TO authenticated;

GRANT ALL ON public.watchlist_items TO service_role;

CREATE TABLE public.watchlists (
  id         uuid                     DEFAULT gen_random_uuid() NOT NULL,
  user_id    uuid,
  name       text                     NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE POLICY "own watchlist items" ON public.watchlist_items
  USING ((EXISTS ( SELECT 1
   FROM public.watchlists w
  WHERE ((w.id = watchlist_items.watchlist_id) AND (w.user_id = auth.uid())))));

ALTER TABLE public.watchlists
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.watchlists
  ADD CONSTRAINT watchlists_pkey PRIMARY KEY (id);

ALTER TABLE public.watchlist_items
  ADD CONSTRAINT watchlist_items_watchlist_id_fkey FOREIGN KEY (watchlist_id) REFERENCES public.watchlists(id) ON DELETE CASCADE;

ALTER TABLE public.watchlists
  ADD CONSTRAINT watchlists_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

GRANT ALL ON public.watchlists TO anon;

GRANT ALL ON public.watchlists TO authenticated;

GRANT ALL ON public.watchlists TO service_role;

CREATE POLICY "own watchlists" ON public.watchlists
  USING ((auth.uid() = user_id));
