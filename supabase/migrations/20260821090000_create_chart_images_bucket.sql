-- Migration: chart-images storage bucket
-- Spec 21.3: chart upload wajib punya maximum file size, allowed MIME,
-- allowed extension, safe storage, signed/public URL policy.
--
-- Ditemukan saat audit: bucket ini dipakai aktif oleh app/chat/page.tsx dan
-- supabase/functions/analyze-chart/index.ts, dan sudah dikonfirmasi ADA di
-- database live (dibuat manual lewat Dashboard) - tapi belum pernah tercatat
-- di migration manapun karena bucket/storage config bukan bagian dari schema
-- "public" yang di-track `supabase db pull` (lihat supabase/config.toml,
-- schemas = ["public", "graphql_public"]). Kalau project di-restore dari
-- nol, migration ini yang akan membuat ulang bucket-nya.
--
-- CATATAN: 3 RLS policy untuk bucket ini (own-folder upload/delete, public
-- read) SUDAH ADA di database live dengan nama chart_images_own_upload,
-- chart_images_own_delete, chart_images_public_read - sengaja TIDAK
-- diduplikasi di sini supaya tidak ada 2 set policy dengan efek yang sama.
-- Kalau project di-restore dari nol dan policy itu ikut hilang, buat ulang
-- manual dengan definisi yang sama seperti di atas.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chart-images',
  'chart-images',
  true,
  5242880, -- 5 MB, selaras dengan validasi client di app/chat/page.tsx
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
