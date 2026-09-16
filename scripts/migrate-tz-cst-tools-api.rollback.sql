-- ============================================================================
-- scripts/migrate-tz-cst-tools-api.sql 的回滚（tools_api 库）
--
-- 用法（默认库须为 tools_api）
--   docker compose exec -T db mariadb -uroot -p"$DB_ROOT_PASSWORD" tools_api \
--     < scripts/migrate-tz-cst-tools-api.rollback.sql
-- ============================================================================

SET @mig := '2026-09-16-db-tz-cst';

START TRANSACTION;

DELETE FROM schema_migrations WHERE id = @mig;

UPDATE api_account SET created_at = DATE_SUB(created_at, INTERVAL 8 HOUR);
UPDATE api_key     SET created_at = DATE_SUB(created_at, INTERVAL 8 HOUR);

COMMIT;

SELECT '已回滚，标记剩余行数应为 0：' AS note;
SELECT COUNT(*) AS remaining_marker FROM schema_migrations WHERE id = @mig;
