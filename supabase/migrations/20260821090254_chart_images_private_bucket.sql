-- Pastikan bucket chart-images bersifat private (tidak public),
-- sesuai spec v5.0 section 21.3: chart upload adalah untrusted & wajib signed URL.
update storage.buckets
set public = false
where id = 'chart-images';
