-- ============================================================================
-- 时区基线迁移（personal_hub 库）：把「由 DB 默认值写入」的历史时间列统一到北京时间（+8h）
--
-- 背景
--   db 容器原先未设 TZ（= UTC），于是 `DEFAULT CURRENT_TIMESTAMP` 落库的是 UTC
--   墙上时间；而 app 容器用 dbDateTimeInTz() 显式写的是北京时间。两者混用，
--   posts.created_at 一列里同时存在相差 8 小时的两类值。
--   docker-compose.yml 给 db 服务加上 `TZ: Asia/Shanghai` 后新写入会统一到 CST，
--   但**存量不会被追溯修正** —— 表里时间列全是 DATETIME（不是 TIMESTAMP），
--   DATETIME 原样存墙上时间、不做时区换算，所以必须显式 +8h。
--
-- 为什么可以简单 +8h
--   中国全境恒为 UTC+8 且不实行夏令时，不存在 DST 跳变，直接加 8 小时即可，
--   无需按历史日期分段处理。
--
-- 迁移范围（逐项判定依据已用线上数据核对）
--   ✅ 迁移
--     posts.created_at   WHERE source IS NOT NULL   抓取行，走 DB 默认值 → UTC
--     posts.updated_at   全部                        走默认值 / ON UPDATE → UTC
--     users.created_at   全部                        走默认值 → UTC
--     files.created_at   全部                        走默认值 → UTC
--     remote_cmd_log.created_at  全部                走默认值 → UTC
--   ⛔ 不迁移（已是正确口径，动了反而错）
--     posts.created_at   WHERE source IS NULL   seed-blog-posts.mjs 显式写入的
--                         「文章展示日期」（人为设定 9:00–21:30、秒位恒 00），
--                         它本身就是北京时间语义，不是 UTC 时刻。
--     posts.fetched_at              app 用 dbDateTimeInTz 显式写北京时间
--     feed_fetch_log.created_at     app 显式写北京时间（见 feed.repo.ts 注释）
--     sessions.expires              unix 时间戳，与时区无关。
--
--   另一库 tools_api 的同批迁移见 scripts/migrate-tz-cst-tools-api.sql。
--
-- 幂等
--   靠 schema_migrations 标记表守卫；全部 UPDATE 都带 `WHERE @todo`，
--   重复执行时 @todo=0 → 命中 0 行 → 空事务 + 不重复写标记。
--   ⚠️ 切勿手工去掉该守卫：二次 +8h 会把时间推到未来。
--
-- 执行（默认库须为 personal_hub）
--   docker compose exec -T db mariadb -uroot -p"$DB_ROOT_PASSWORD" personal_hub \
--     < scripts/migrate-tz-cst.sql
--   回滚见 scripts/migrate-tz-cst.rollback.sql
--
-- 时序要求
--   与「重建 db 容器使 TZ 生效」必须紧邻进行，且期间不能有写入：
--   迁移已完成而容器仍为 UTC 时，任何 UPDATE 都会把 updated_at 写回 UTC（时间倒退）。
--   操作时先停 app / tools-api，再迁移，再重建容器，最后起服务。
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  id         VARCHAR(64)  NOT NULL COMMENT '迁移标识',
  applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note       VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @mig  := '2026-09-16-db-tz-cst';
SET @todo := (SELECT COUNT(*) = 0 FROM schema_migrations WHERE id = @mig);

SELECT @todo AS should_apply_now;   -- 1 = 本次执行；0 = 已迁移过，下面所有 UPDATE 命中 0 行

START TRANSACTION;

-- ---- posts：抓取行两列都是 UTC -------------------------------------------------
-- 必须同时显式赋值 updated_at：该列是 ON UPDATE CURRENT_TIMESTAMP，
-- 只改 created_at 会触发它被自动刷成当前时间（那会直接毁掉这一列）。
UPDATE posts
   SET created_at = DATE_ADD(created_at, INTERVAL 8 HOUR),
       updated_at = DATE_ADD(updated_at, INTERVAL 8 HOUR)
 WHERE source IS NOT NULL
   AND @todo;

-- ---- posts：手工行仅 updated_at 是 UTC（被后续 UPDATE 刷过）---------------------
-- created_at 是 seed 的人为展示日期，保持不动。此处显式赋值 updated_at，
-- 同样是为了避开 ON UPDATE 自动值。
UPDATE posts
   SET updated_at = DATE_ADD(updated_at, INTERVAL 8 HOUR)
 WHERE source IS NULL
   AND @todo;

-- ---- 其余走 DB 默认值的表 ------------------------------------------------------
UPDATE users          SET created_at = DATE_ADD(created_at, INTERVAL 8 HOUR) WHERE @todo;
UPDATE files          SET created_at = DATE_ADD(created_at, INTERVAL 8 HOUR) WHERE @todo;
UPDATE remote_cmd_log SET created_at = DATE_ADD(created_at, INTERVAL 8 HOUR) WHERE @todo;

INSERT INTO schema_migrations (id, note)
SELECT @mig, 'db 容器改 TZ=Asia/Shanghai 前的存量时间列 +8h（UTC→CST）'
 WHERE @todo;

COMMIT;

-- ---- 迁移后自检（人工核对）----------------------------------------------------
-- 关键断言：抓取行的 created_at 应等于 fetched_at ——
-- 两者本是同一时刻（抓取入库），只是原先一个走 DB 默认值(UTC)、一个由应用显式写(CST)。
SELECT '== 抓取行 created_at 应已等于 fetched_at（不等则口径仍不一致）==' AS check_note;
SELECT COUNT(*) AS rows_total,
       SUM(created_at = fetched_at) AS rows_created_eq_fetched,
       SUM(created_at <> fetched_at) AS rows_still_mismatched
  FROM posts WHERE source IS NOT NULL;

SELECT '== 各列迁移后范围 ==' AS check_note;
SELECT 'posts_feed' AS t, MIN(created_at) mn_created, MAX(created_at) mx_created,
       MIN(updated_at) mn_updated, MAX(updated_at) mx_updated, COUNT(*) n
  FROM posts WHERE source IS NOT NULL
UNION ALL
SELECT 'posts_manual(created 刻意不动)',
       MIN(created_at), MAX(created_at), MIN(updated_at), MAX(updated_at), COUNT(*)
  FROM posts WHERE source IS NULL
UNION ALL
SELECT 'users', NULL, MIN(created_at), NULL, NULL, COUNT(*) FROM users
UNION ALL
SELECT 'files', NULL, MIN(created_at), NULL, NULL, COUNT(*) FROM files
UNION ALL
SELECT 'remote_cmd_log', NULL, MIN(created_at), NULL, NULL, COUNT(*) FROM remote_cmd_log
UNION ALL
SELECT 'feed_fetch_log(不动)', NULL, MIN(created_at), NULL, NULL, COUNT(*) FROM feed_fetch_log;

SELECT '== 迁移标记 ==' AS check_note;
SELECT id, applied_at, note FROM schema_migrations WHERE id = @mig;
