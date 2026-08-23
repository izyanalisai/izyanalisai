-- Cleanup (23 Agustus 2026): master-sync-corporate-actions dan
-- process-corporate-actions-daily jalan di jam yang sama (22:00) dan
-- proses row corporate_actions PENDING yang sama. master-sync-corporate-actions
-- panggil process_corporate_actions() versi lama, sementara
-- process-corporate-actions-daily panggil versi yang sudah ada fix audit_logs
-- (entity_type/entity_id) dan job_run_start/finish tracking. Drop yang lama.
select cron.unschedule('master-sync-corporate-actions');
