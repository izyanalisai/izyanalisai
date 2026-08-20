-- Kolom ini sudah ada di production tapi belum pernah tercatat sebagai
-- migration (kemungkinan ditambahkan manual lewat SQL Editor). File ini
-- cuma "mencatat" state yang sudah ada, pakai IF NOT EXISTS supaya aman
-- dijalankan di local shadow db (db pull / db reset) maupun di production.

alter table public.signals
  add column if not exists resolved_at timestamptz;

alter table public.signals
  add column if not exists gate_passed boolean not null default false;
