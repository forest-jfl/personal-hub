-- ============================================================================
-- scripts/migrate-tz-cst.sql 的回滚（personal_hub 库）：-8h 还原并清除迁移标记
--
-- 用法（仅在迁移后确认需要回退时执行；默认库须为 personal_hub）
--   docker compose exec -T db mariadb -uroot -p"$DB_ROOT_PASSWORD" personal_hub \
--     < scripts/migrate-tz-cst.rollback.sql
--
-- 注意
--   · 先删标记再反向更新，否则 @todo 守卫会挡住下面的 UPDATE。
--   · 回滚同样受 posts.updated_at 的 ON UPDATE 影响，故一律显式赋值该列。
--   · 若迁移后已经产生过新数据（新行按 CST 写入），回滚会把它们一并 -8h，
--     那部分本不该回退。所以回滚只在「迁移后无新增写入」时可安全使用；
--     否则应改为按 id 范围回退。真正稳妥的兜底是迁移前的 mysqldump。
-- ============================================================================

SET @mig := '2026-09-16-db-tz-cst';

START TRANSACTION;

DELETE FROM schema_migrations WHERE id = @mig;

UPDATE posts
   SET created_at = DATE_SUB(created_at, INTERVAL 8 HOUR),
       updated_at = DATE_SUB(updated_at, INTERVAL 8 HOUR)
 WHERE source IS NOT NULL;

UPDATE posts
   SET updated_at = DATE_SUB(updated_at, INTERVAL 8 HOUR)
 WHERE source IS NULL;

UPDATE users          SET created_at = DATE_SUB(created_at, INTERVAL 8 HOUR);
UPDATE files          SET created_at = DATE_SUB(created_at, INTERVAL 8 HOUR);
UPDATE remote_cmd_log SET created_at = DATE_SUB(created_at, INTERVAL 8 HOUR);

COMMIT;

SELECT '已回滚，标记剩余行数应为 0：' AS note;
SELECT COUNT(*) AS remaining_marker FROM schema_migrations WHERE id = @mig;
