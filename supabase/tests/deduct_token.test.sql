-- Test SQL untuk fungsi public.deduct_token() -- prioritas test #1 di dokumen v6.2 §4
-- (token deduction: atomicity, idempotency, double-spend prevention).
--
-- Kenapa bentuknya SQL, bukan deno test seperti file test lain di repo ini:
-- deduct_token() adalah PL/pgSQL SECURITY DEFINER yang baca auth.uid() dan pakai
-- SELECT ... FOR UPDATE row lock langsung ke tabel token_wallets/token_transactions --
-- logikanya TIDAK bisa diekstrak ke modul TS murni seperti signature.ts/logic.ts,
-- jadi harus ditest sebagai SQL terhadap Postgres beneran (lokal/branch, BUKAN production).
--
-- Cara jalanin (pilih salah satu):
--   1. Bikin Supabase branch dulu (isolasi dari data production), lalu:
--      supabase db execute -f supabase/tests/deduct_token.test.sql --db-url <branch-db-url>
--   2. Atau psql lokal (supabase start) kalau sudah setup local dev:
--      psql "$(supabase status -o env | grep DB_URL)" -f supabase/tests/deduct_token.test.sql
--
-- CATATAN: v_test_user_id di bawah sudah diisi UUID user beneran (508feff4-8333-40dc-a36c-578cd0ebd4d0,
-- user pertama di tabel profiles). Kalau mau jalanin di branch/local yang datanya beda, cek dulu
-- user itu ada, atau ganti ke UUID user lain yang ada di environment situ.
--
-- JANGAN dijalankan langsung ke database production -- ini bikin & hapus wallet dummy,
-- tapi tetap insert row nyata ke token_transactions kalau ada yang gagal di tengah jalan.
--
-- LIMITASI JUJUR: test di bawah jalan dalam SATU koneksi/transaksi berurutan, jadi cuma
-- membuktikan idempotency + insufficient-token check, BELUM membuktikan FOR UPDATE benar2
-- mencegah race condition kalau 2 request konkuren beneran nembak barengan (butuh 2 koneksi
-- paralel, misal via dblink/pg_background atau script k6/deno bombarding endpoint RPC
-- sungguhan -- belum dibuat di sini, masuk next step kalau mau full-cover TEST 4 dokumen v6.2).

DO $$
DECLARE
  v_test_user_id uuid := '508feff4-8333-40dc-a36c-578cd0ebd4d0';
  v_ref_id uuid := gen_random_uuid();
  v_balance_1 integer;
  v_charged_1 boolean;
  v_balance_2 integer;
  v_charged_2 boolean;
  v_wallet_balance_before integer;
  v_wallet_balance_after integer;
BEGIN
  -- Simulasikan konteks PostgREST authenticated (auth.uid() = v_test_user_id)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_test_user_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);

  -- Bersihkan sisa test run sebelumnya (kalau ada)
  DELETE FROM public.token_transactions WHERE wallet_id IN (SELECT id FROM public.token_wallets WHERE user_id = v_test_user_id);
  DELETE FROM public.token_wallets WHERE user_id = v_test_user_id;

  -- === TEST 1: deduct pertama kali harus sukses & balance turun 1 dari daily grant ===
  SELECT balance, already_charged INTO v_balance_1, v_charged_1
  FROM public.deduct_token('ai_task', v_ref_id);

  ASSERT v_charged_1 = false, 'TEST 1 GAGAL: charge pertama harusnya already_charged=false';
  ASSERT v_balance_1 = 4, format('TEST 1 GAGAL: expect balance 4 (grant 5 - 1), dapat %s', v_balance_1);
  RAISE NOTICE 'TEST 1 OK: charge pertama sukses, balance=%', v_balance_1;

  -- === TEST 2: panggil ULANG dengan reference_id SAMA -- harus idempotent, TIDAK dipotong lagi ===
  SELECT balance, already_charged INTO v_balance_2, v_charged_2
  FROM public.deduct_token('ai_task', v_ref_id);

  ASSERT v_charged_2 = true, 'TEST 2 GAGAL: panggilan kedua dengan reference_id sama harusnya already_charged=true (idempotent)';
  ASSERT v_balance_2 = v_balance_1, format('TEST 2 GAGAL: balance harusnya TETAP %s (tidak dipotong lagi), dapat %s', v_balance_1, v_balance_2);
  RAISE NOTICE 'TEST 2 OK: idempotency terjaga, balance tetap=%', v_balance_2;

  -- === TEST 3: reference_id BEDA -- harus dipotong lagi (bukan false-positive idempotent) ===
  SELECT balance INTO v_wallet_balance_before FROM public.deduct_token('ai_task', gen_random_uuid());
  ASSERT v_wallet_balance_before = v_balance_1 - 1, format('TEST 3 GAGAL: expect balance %s, dapat %s', v_balance_1 - 1, v_wallet_balance_before);
  RAISE NOTICE 'TEST 3 OK: reference_id beda tetap dipotong, balance=%', v_wallet_balance_before;

  -- === TEST 4: habiskan sisa token, lalu pastikan INSUFFICIENT_TOKENS ke-raise saat balance 0 ===
  UPDATE public.token_wallets SET balance = 0 WHERE user_id = v_test_user_id;
  BEGIN
    PERFORM public.deduct_token('ai_task', gen_random_uuid());
    RAISE EXCEPTION 'TEST 4 GAGAL: harusnya raise INSUFFICIENT_TOKENS saat balance 0, malah sukses';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'INSUFFICIENT_TOKENS' THEN
      RAISE NOTICE 'TEST 4 OK: INSUFFICIENT_TOKENS ke-raise dengan benar saat balance habis';
    ELSE
      RAISE EXCEPTION 'TEST 4 GAGAL: exception salah, expect INSUFFICIENT_TOKENS, dapat: %', SQLERRM;
    END IF;
  END;

  -- Cleanup
  DELETE FROM public.token_transactions WHERE wallet_id IN (SELECT id FROM public.token_wallets WHERE user_id = v_test_user_id);
  DELETE FROM public.token_wallets WHERE user_id = v_test_user_id;

  RAISE NOTICE '=== SEMUA TEST deduct_token LULUS ===';
END $$;
