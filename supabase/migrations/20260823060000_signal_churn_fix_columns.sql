-- Churn fix untuk generate-signals-mtf (lihat index.ts versi baru) + persiapan
-- backtest statistical gate (spec v6.1 section 3).
--
-- superseded_unresolved: TRUE kalau sinyal ini disupersede murni karena cron
-- generate-signals-mtf jalan lagi dan levelnya TIDAK beneran berubah (churn
-- artefak, bukan setup baru). Sinyal begini tidak pernah sempat dievaluasi
-- evaluate-signals (statusnya langsung INVALIDATED sebelum sempat HIT_TP/HIT_SL),
-- jadi harus dikecualikan dari winrate/backtest historis kalau dipakai sebagai
-- data -- dan berguna buat dashboard admin memantau seberapa sering churn terjadi.
-- Default FALSE: supersede karena setup beneran berubah (kasus normal) tetap FALSE.
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS superseded_unresolved boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.signals.superseded_unresolved IS
  'TRUE kalau signal ini di-supersede oleh generate-signals-mtf padahal level (buy_area/tp1/tp2/stop_loss/support/resistance) tidak beneran berubah -- artefak churn cron, bukan setup baru. Kecualikan dari agregasi win rate/backtest historis.';

-- backtest_runs: kolom untuk gate statistik binomial test (spec v6.1 section 3).
-- p_value dari binomial_cdf(X >= observed_wins | n = total_trades_resolved, p = 0.5),
-- H0: true win rate <= 0.5. total_trades_resolved mengecualikan trade UNFILLED
-- (kena batas Auto Reject ARA/ARB T+1) dari denominator win rate/expectancy,
-- unfilled_count mencatatnya terpisah supaya tidak hilang dari laporan.
ALTER TABLE public.backtest_runs
  ADD COLUMN IF NOT EXISTS p_value double precision,
  ADD COLUMN IF NOT EXISTS total_trades_resolved integer,
  ADD COLUMN IF NOT EXISTS unfilled_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.backtest_runs.p_value IS
  'Binomial test p-value: P(X >= observed_wins | n = total_trades_resolved, p = 0.5). H0 = true win rate <= 0.5. Gate PASS butuh p_value < 0.05 DAN win_rate_pct >= 55 DAN expectancy > 0 (spec v6.1 section 3). NULL = belum dihitung ulang dengan gate ini.';

COMMENT ON COLUMN public.backtest_runs.total_trades_resolved IS
  'Jumlah trade yang benar-benar resolve (HIT_TP/HIT_SL/EXPIRED), dipakai sebagai n di binomial test -- TIDAK termasuk trade UNFILLED (lihat unfilled_count).';

COMMENT ON COLUMN public.backtest_runs.unfilled_count IS
  'Jumlah trade yang T+1-nya kena batas Auto Reject IDX (ARA/ARB) sehingga entry tidak pernah benar-benar terisi -- dicatat terpisah, dikecualikan dari win rate/expectancy/total_trades_resolved (spec v6.1 section 3).';
