-- Implementasi binomial test untuk gate backtest statistik (spec v6.1 §3).
-- Postgres/Supabase tidak punya binomial CDF bawaan, jadi dihitung manual
-- di sini pakai penjumlahan log-space (aman untuk n besar, tanpa ekstensi
-- tambahan apapun).
--
-- H0: true win rate <= 0.5 (sinyal tidak lebih baik dari lempar koin).
-- p_value = P(X >= observed_wins | n = total_trades_resolved, p = 0.5)
--         = Sum_{k=observed_wins}^{n} C(n,k) * 0.5^n
-- Gate PASS butuh p_value < 0.05 DAN win_rate_pct >= 55 DAN expectancy > 0.

CREATE OR REPLACE FUNCTION public.binomial_sf(observed_wins integer, n integer)
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  log_term double precision; -- log2 dari satu suku C(n,k)*0.5^n
  total double precision := 0;
  k integer;
  log_c double precision := 0; -- log2(C(n,k)) berjalan, update inkremental
BEGIN
  IF n IS NULL OR n <= 0 THEN
    RETURN NULL;
  END IF;
  IF observed_wins IS NULL THEN
    RETURN NULL;
  END IF;
  IF observed_wins <= 0 THEN
    RETURN 1.0;
  END IF;
  IF observed_wins > n THEN
    RETURN 0.0;
  END IF;

  -- log2(C(n,0)) = 0, lalu increment: log2(C(n,k)) = log2(C(n,k-1)) + log2(n-k+1) - log2(k)
  log_c := 0;
  FOR k IN 1..observed_wins LOOP
    log_c := log_c + log(2, (n - k + 1)::double precision) - log(2, k::double precision);
  END LOOP;

  -- Sum_{k=observed_wins}^{n} C(n,k) * 0.5^n, dihitung log-space lalu
  -- di-exponentiate satu per satu dengan running sum ternormalisasi
  -- supaya tidak overflow untuk n besar.
  total := 0;
  FOR k IN observed_wins..n LOOP
    IF k > observed_wins THEN
      log_c := log_c + log(2, (n - k + 1)::double precision) - log(2, k::double precision);
    END IF;
    log_term := log_c - n::double precision; -- - n*log2(2) = -n, karena 0.5^n = 2^-n
    total := total + power(2::double precision, log_term);
  END LOOP;

  IF total > 1.0 THEN
    total := 1.0;
  END IF;
  RETURN total;
END;
$$;

COMMENT ON FUNCTION public.binomial_sf IS
  'Binomial survival function P(X >= observed_wins | n, p=0.5), one-sided, dihitung log-space tanpa ekstensi tambahan. Dipakai sebagai p_value gate backtest (spec v6.1 section 3).';

-- Trigger: setiap insert/update pada backtest_runs, hitung ulang p_value
-- otomatis dari win_trades & total_trades_resolved yang ada di row itu.
-- Kalau total_trades_resolved belum diisi manual, fallback ke total_trades
-- (asumsi tidak ada trade UNFILLED yang dikecualikan).
CREATE OR REPLACE FUNCTION public.backtest_runs_compute_p_value()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.total_trades_resolved IS NULL THEN
    NEW.total_trades_resolved := NEW.total_trades - COALESCE(NEW.unfilled_count, 0);
  END IF;
  NEW.p_value := public.binomial_sf(NEW.win_trades, NEW.total_trades_resolved);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_backtest_runs_compute_p_value ON public.backtest_runs;
CREATE TRIGGER trg_backtest_runs_compute_p_value
  BEFORE INSERT OR UPDATE OF win_trades, total_trades, total_trades_resolved, unfilled_count
  ON public.backtest_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.backtest_runs_compute_p_value();

COMMENT ON FUNCTION public.backtest_runs_compute_p_value IS
  'Auto-hitung p_value (binomial test, H0: win rate <= 0.5) setiap kali backtest_runs diinsert/diupdate, dari win_trades dan total_trades_resolved (fallback: total_trades - unfilled_count). Spec v6.1 section 3.';

-- Backfill: hitung p_value untuk row backtest_runs yang sudah ada
-- (misal baseline_v1, LQ45, D1, 1769 trade) supaya tidak NULL.
UPDATE public.backtest_runs
SET total_trades_resolved = total_trades - COALESCE(unfilled_count, 0)
WHERE total_trades_resolved IS NULL;

UPDATE public.backtest_runs
SET p_value = public.binomial_sf(win_trades, total_trades_resolved)
WHERE p_value IS NULL AND total_trades_resolved IS NOT NULL;
