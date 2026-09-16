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
--   中国全境恒为 UTC+8 且不实行夏令时，不存在 DST 跳变，直接加 8 小时即可。
--
-- 迁移范围（逐条判定依据均以线上数据核对过；库内时间列仅此 7 列，无遗漏）
--   ✅ 迁移
--     posts.created_at   WHERE source IS NOT NULL        抓取入库，走 DB 默认值 → UTC
--     posts.created_at   WHERE source IS NULL 且非 seed   控制台创建，走 DB 默认值 → UTC
--     posts.updated_at   全部（除 seed 行从未被刷新者）    走 DB 默认值 / ON UPDATE → UTC
--     users.created_at   全部                            走 DB 默认值 → UTC
--     files.created_at   全部                            走 DB 默认值 → UTC
--     remote_cmd_log.created_at  全部                     走 DB 默认值 → UTC
--   ⛔ 不迁移（已是正确口径，动了反而错）
--     posts.created_at   WHERE source IS NULL 且在 seed 清单内
--         seed-blog-posts.mjs 显式写入的「文章展示日期」（人为设定 9:00–21:30、
--         秒位恒 00），它本身就是北京时间语义，不是 UTC 时刻。
--     posts.fetched_at              app 用 dbDateTimeInTz 显式写北京时间
--     feed_fetch_log.created_at     app 显式写北京时间
--     sessions.expires              unix 时间戳，与时区无关。
--
-- 为什么手工行要按 slug 再拆一次
--   第一版只按 `source IS NULL` 判为「seed 写入」，线上数据推翻了它：
--   20 条手工行里 19 条在 seed 清单内（created_at 秒位恒 00），另有 1 条
--   `站点上线-半山日志-改版发布`（秒位 33）—— 它是控制台创建的第一篇，
--   created_at 走 DB 默认值。若一并跳过，它的展示日期会永远早 8 小时。
--   故 discriminant 取「slug 是否在 seed 清单内」，而非「是否 seed 过」。
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

-- 固定连接字符集与排序规则 —— 不可省，实测踩过两个独立的坑：
--   · 用户变量与字符串比较时的排序规则**取自连接**。MySQL 8 的 utf8mb4 连接默认
--     是 utf8mb4_0900_ai_ci，与库里 utf8mb4_unicode_ci 的列相比直接报
--     `ERROR 1267 Illegal mix of collations`，整条事务回滚、迁移静默不做。
--   · 反过来，Windows 的 mysql CLI 默认连接字符集是 **gbk**（实测），此时本脚本正文里
--     的中文字面量会被当成 gbk 字节解读 → 写进 note 列就是乱码，且不报错。
-- set names 一行同时消掉这两者，使脚本行为不再依赖客户端默认值。
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id         VARCHAR(64)  NOT NULL COMMENT '迁移标识',
  applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note       VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @mig  := '2026-09-16-db-tz-cst';
SET @todo := (SELECT COUNT(*) = 0 FROM schema_migrations WHERE id = @mig);

-- seed 清单：判别「created_at 是人为展示日期」的行。必须与
-- scripts/seed-blog-posts.mjs 的 slug 集合逐条一致 —— npm run check:tz 会对账防漂移。
-- 用 FIND_IN_SET 而非 IN，避免把清单拆成一长串字面量。
-- （其排序规则匹配依赖上面的 SET NAMES，勿删。）
SET @seed_slugs := 'gpt6-astra-thoughts,72h-model-war,nvidia-huggingface-acquisition,chinese-llm-going-global,ai-as-daily-commodity,byte-dance-ai-loan,ai-coding-rule-spec-harness,ai-prompt-constraints-first,agents-md-context-engineering,ai-tdd-workflow,docker-volume-mysql-notes,why-blog-in-2026,self-host-blog-caddy-docker,digital-minimalism-30days,city-ride-autumn,cotd-cafe-notes,light-wellness-park-running,balcony-plants-therapy,skill-swap-community';

SELECT @todo AS should_apply_now;   -- 1 = 本次执行；0 = 已迁移过，下面所有 UPDATE 命中 0 行

START TRANSACTION;

-- ---- ① posts：抓取行，created_at 与 updated_at 都是 UTC -------------------------
-- 必须同时显式赋值 updated_at：该列是 ON UPDATE CURRENT_TIMESTAMP，
-- 只改 created_at 会触发它被自动刷成当前时间（那会直接毁掉这一列）。
UPDATE posts
   SET created_at = DATE_ADD(created_at, INTERVAL 8 HOUR),
       updated_at = DATE_ADD(updated_at, INTERVAL 8 HOUR)
 WHERE source IS NOT NULL
   AND @todo;

-- ---- ② posts：手工行·控制台创建（不在 seed 清单），两列都是 UTC ------------------
-- 同 ①，显式赋值 updated_at 以避开 ON UPDATE 自动值。
UPDATE posts
   SET created_at = DATE_ADD(created_at, INTERVAL 8 HOUR),
       updated_at = DATE_ADD(updated_at, INTERVAL 8 HOUR)
 WHERE source IS NULL
   AND FIND_IN_SET(slug, @seed_slugs) = 0
   AND @todo;

-- ---- ③ posts：手工行·seed 创建，只修 updated_at --------------------------------
-- created_at 是 seed 写入的展示日期（北京时间语义），保持不动。
-- updated_at 初值与 created_at 相同（同为北京时间）→ 只有被后续 UPDATE 刷新过
-- （`UPDATE posts SET views = views+1` 也会触发 ON UPDATE）才变成 UTC，故加
-- `updated_at <> created_at` 条件；未刷新过的行两列都保持原样。
UPDATE posts
   SET updated_at = DATE_ADD(updated_at, INTERVAL 8 HOUR)
 WHERE source IS NULL
   AND FIND_IN_SET(slug, @seed_slugs) > 0
   AND updated_at <> created_at
   AND @todo;

-- ---- ④ 其余走 DB 默认值的表 ----------------------------------------------------
UPDATE users          SET created_at = DATE_ADD(created_at, INTERVAL 8 HOUR) WHERE @todo;
UPDATE files          SET created_at = DATE_ADD(created_at, INTERVAL 8 HOUR) WHERE @todo;
UPDATE remote_cmd_log SET created_at = DATE_ADD(created_at, INTERVAL 8 HOUR) WHERE @todo;

INSERT INTO schema_migrations (id, note)
SELECT @mig, 'db 容器改 TZ=Asia/Shanghai 前的存量时间列 +8h（UTC→CST）'
 WHERE @todo;

COMMIT;

-- ---- 迁移后自检（人工核对）----------------------------------------------------
-- 关键断言：抓取行的 created_at 与 fetched_at 必须落在同一时刻附近。
-- 两者本是同一次抓取：fetched_at 由 app 在抓取开始时一次性打上，created_at 走 DB 默认值
-- （逐行 INSERT 那一刻），所以**末行天然会晚 1 秒左右** —— 线上实测 18 条里 17 条 0 秒、
-- 1 条 -1 秒。因此不能断言「完全相等」（那会永远报一条假红，反而训练人忽略它），
-- 要断言的是「没有整小时级的差」：>60 秒的行必须为 0。
SELECT '== ① 抓取行 created_at 与 fetched_at 的口径一致性（rows_bad 必须为 0）==' AS check_note;
SELECT COUNT(*) AS rows_total,
       SUM(created_at = fetched_at) AS rows_exact,
       SUM(ABS(TIMESTAMPDIFF(SECOND, created_at, fetched_at)) <= 60) AS rows_within_60s,
       MAX(ABS(TIMESTAMPDIFF(SECOND, created_at, fetched_at))) AS max_abs_diff_sec,
       SUM(ABS(TIMESTAMPDIFF(SECOND, created_at, fetched_at)) > 60) AS rows_bad
  FROM posts WHERE source IS NOT NULL;

SELECT '== ② 手工行分类计数：seed 行 created_at 必须保持秒位 00（未被误迁移）==' AS check_note;
SELECT SUM(FIND_IN_SET(slug, @seed_slugs) > 0) AS seed_rows,
       SUM(SECOND(created_at) = 0)             AS sec_zero_rows,
       SUM(FIND_IN_SET(slug, @seed_slugs) = 0) AS console_rows
  FROM posts WHERE source IS NULL;

SELECT '== ③ 各列迁移后范围 ==' AS check_note;
SELECT 'posts_feed' AS t, MIN(created_at) mn_created, MAX(created_at) mx_created,
       MIN(updated_at) mn_updated, MAX(updated_at) mx_updated, COUNT(*) n
  FROM posts WHERE source IS NOT NULL
UNION ALL
SELECT 'posts_manual（created_at 不迁移）',
       MIN(created_at), MAX(created_at), MIN(updated_at), MAX(updated_at), COUNT(*)
  FROM posts WHERE source IS NULL
UNION ALL
SELECT 'users', NULL, MIN(created_at), NULL, NULL, COUNT(*) FROM users
UNION ALL
SELECT 'files', NULL, MIN(created_at), NULL, NULL, COUNT(*) FROM files
UNION ALL
SELECT 'remote_cmd_log', NULL, MIN(created_at), NULL, NULL, COUNT(*) FROM remote_cmd_log
UNION ALL
SELECT 'feed_fetch_log（不迁移）', NULL, MIN(created_at), NULL, NULL, COUNT(*) FROM feed_fetch_log;

SELECT '== ④ 迁移标记 ==' AS check_note;
SELECT id, applied_at, note FROM schema_migrations WHERE id = @mig;
