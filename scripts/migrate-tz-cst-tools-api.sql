-- ============================================================================
-- 时区基线迁移（tools_api 库）：与 personal_hub 同一批决策
--
-- 为什么同一批
--   tools_api 库住在**同一个 db 容器**里 —— `TZ: Asia/Shanghai` 一改，两个库
--   的 `DEFAULT CURRENT_TIMESTAMP` 同时从 UTC 切到 CST。若不一起迁移存量，
--   这个库会留下「旧行 UTC + 新行 CST」的混合口径，性质与 personal_hub 相同。
--
-- 迁移范围
--   ✅ 迁移
--     api_account.created_at   走 DB 默认值（INSERT 不含该列）→ UTC
--     api_key.created_at       同上
--   ⛔ 不迁移
--     api_key.last_used_at     由 api-service 应用层按业务时区传参
--     api_usage.day / api_usage_hour.hour / hit_daily.day / hit_path.day / hit_search.day
--                              同上，全为应用层算好的日期/小时
--     （api-service 有门禁 scripts/check_sql_timezone.py 禁止 SQL 内出现
--       CURDATE()/NOW() 做业务判断，故这些列不依赖 DB 时区，改容器时区不影响。）
--
-- 幂等 / 时序 / 执行
--   同 scripts/migrate-tz-cst.sql；默认库须为 tools_api。
--   ⚠️ 本机（开发机）也存在同名 tools_api 库，切勿在本机执行本脚本 ——
--      只应指向服务器容器内的库。
-- ============================================================================

-- 固定连接字符集与排序规则，理由同 scripts/migrate-tz-cst.sql：
-- 用户变量的排序规则取自连接，与列不一致会报 ERROR 1267 并使事务整体回滚；
-- 而 Windows mysql CLI 默认 gbk 连接会让脚本里的中文字面量写坏（且不报错）。
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id         VARCHAR(64)  NOT NULL COMMENT '迁移标识',
  applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note       VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @mig  := '2026-09-16-db-tz-cst';
SET @todo := (SELECT COUNT(*) = 0 FROM schema_migrations WHERE id = @mig);

SELECT @todo AS should_apply_now;

START TRANSACTION;

UPDATE api_account SET created_at = DATE_ADD(created_at, INTERVAL 8 HOUR) WHERE @todo;
UPDATE api_key     SET created_at = DATE_ADD(created_at, INTERVAL 8 HOUR) WHERE @todo;

INSERT INTO schema_migrations (id, note)
SELECT @mig, 'db 容器改 TZ=Asia/Shanghai 前的存量时间列 +8h（UTC→CST）'
 WHERE @todo;

COMMIT;

SELECT '== 迁移后范围 ==' AS check_note;
SELECT 'api_account' AS t, MIN(created_at) mn, MAX(created_at) mx, COUNT(*) n FROM api_account
UNION ALL
SELECT 'api_key', MIN(created_at), MAX(created_at), COUNT(*) FROM api_key;

SELECT '== 迁移标记 ==' AS check_note;
SELECT id, applied_at, note FROM schema_migrations WHERE id = @mig;
