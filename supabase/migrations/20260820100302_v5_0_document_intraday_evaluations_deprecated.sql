-- Spec v5.0 section 12.2: "intraday_evaluation" (hasil evaluasi sesi 1, bukan signal resmi).
-- Ditemukan 2 implementasi paralel: tabel kosong `intraday_evaluations` (0 baris, TIDAK direferensikan
-- oleh function/cron manapun) vs `session2_setup_previews` (337 baris, AKTIF dipakai oleh cron
-- schedule_evaluate_session2_preview sejak 18 Agustus 2026). Bukan cuma nama beda - `intraday_evaluations`
-- adalah tabel mati/tidak terpakai. Didokumentasikan di sini (bukan di-drop, biar non-destructive)
-- supaya developer/AI berikutnya tidak salah pilih tabel. Gunakan session2_setup_previews.
COMMENT ON TABLE public.intraday_evaluations IS 'DEPRECATED/TIDAK TERPAKAI (audit 20 Agustus 2026, spec v5.0 sec 12.2): implementasi asli intraday evaluation ada di session2_setup_previews (dipakai cron schedule_evaluate_session2_preview), bukan di tabel ini. Tabel ini 0 baris & tidak direferensikan function manapun. Jangan dipakai untuk fitur baru; pertimbangkan drop di migration terpisah kalau sudah dikonfirmasi aman.';

COMMENT ON TABLE public.session2_setup_previews IS 'Implementasi AKTIF dari "intraday_evaluation" per spec v5.0 section 12.2 - evaluasi setup non-final untuk sesi 2 (jam 12:10 WIB), bukan signal resmi, tidak mempengaruhi lifecycle tabel signals. Dibuat 18 Agustus 2026, dipakai cron schedule_evaluate_session2_preview.';
