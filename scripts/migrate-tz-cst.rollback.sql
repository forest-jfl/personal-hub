-- ============================================================================
-- scripts/migrate-tz-cst.sql 的回滚（personal_hub 库）：-8h 还原并清除迁移标记
--
-- 用法（仅在迁移后确认需要回退时执行；默认库须为 personal_hub）
--   docker compose exec -T db mariadb -uroot -p"$DB_ROOT_PASSWORD" personal_hub \
--     < scripts/migrate-tz-cst.rollback.sql
--
-- 本脚本是迁移脚本的**逐条镜像**：迁移改了哪些行、哪些列，这里就原样反向改回来。
-- 三分类与 seed 清单必须与迁移脚本逐字一致（npm run check:tz 会对账），
-- 否则回滚会漏改控制台文章、或误改 seed 展示日期。
--
-- 注意
--   · 先删标记再反向更新，否则 @todo 守卫会挡住下面的 UPDATE。
--   · 回滚同样受 posts.updated_at 的 ON UPDATE 影响，故一律显式赋值该列。
--   · 若迁移后已经产生过新数据（新行按 CST 写入），回滚会把它们一并 -8h，
--     那部分本不该回退。所以回滚只在「迁移后无新增写入」时可安全使用；
--     否则应改为按 id 范围回退。真正稳妥的兜底是迁移前的 mysqldump。
-- ============================================================================

-- 同迁移脚本：固定连接字符集/排序规则，否则 @mig 与列比较会报 1267。
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @mig := '2026-09-16-db-tz-cst';
SET @seed_slugs := 'gpt6-astra-thoughts,72h-model-war,nvidia-huggingface-acquisition,chinese-llm-going-global,ai-as-daily-commodity,byte-dance-ai-loan,ai-coding-rule-spec-harness,ai-prompt-constraints-first,agents-md-context-engineering,ai-tdd-workflow,docker-volume-mysql-notes,why-blog-in-2026,self-host-blog-caddy-docker,digital-minimalism-30days,city-ride-autumn,cotd-cafe-notes,light-wellness-park-running,balcony-plants-therapy,skill-swap-community';

START TRANSACTION;

DELETE FROM schema_migrations WHERE id = @mig;

-- ① 抓取行：两列都曾被 +8h → 一起 -8h
UPDATE posts
   SET created_at = DATE_SUB(created_at, INTERVAL 8 HOUR),
       updated_at = DATE_SUB(updated_at, INTERVAL 8 HOUR)
 WHERE source IS NOT NULL;

-- ② 手工行·控制台创建（不在 seed 清单）：两列都曾被 +8h
UPDATE posts
   SET created_at = DATE_SUB(created_at, INTERVAL 8 HOUR),
       updated_at = DATE_SUB(updated_at, INTERVAL 8 HOUR)
 WHERE source IS NULL
   AND FIND_IN_SET(slug, @seed_slugs) = 0;

-- ③ 手工行·seed 创建：只有 updated_at 曾被 +8h（created_at 是展示日期，迁移时未动）
--    条件与迁移一致 —— 迁移只对 updated_at <> created_at 的行动手，这里也只看这些行。
UPDATE posts
   SET updated_at = DATE_SUB(updated_at, INTERVAL 8 HOUR)
 WHERE source IS NULL
   AND FIND_IN_SET(slug, @seed_slugs) > 0
   AND updated_at <> created_at;

UPDATE users          SET created_at = DATE_SUB(created_at, INTERVAL 8 HOUR);
UPDATE files          SET created_at = DATE_SUB(created_at, INTERVAL 8 HOUR);
UPDATE remote_cmd_log SET created_at = DATE_SUB(created_at, INTERVAL 8 HOUR);

COMMIT;

SELECT '已回滚，标记剩余行数应为 0：' AS note;
SELECT COUNT(*) AS remaining_marker FROM schema_migrations WHERE id = @mig;

SELECT '== 手工行分类（seed 行 created_at 秒位应仍为 00）==' AS check_note;
SELECT SUM(FIND_IN_SET(slug, @seed_slugs) > 0) AS seed_rows,
       SUM(SECOND(created_at) = 0)             AS sec_zero_rows,
       SUM(FIND_IN_SET(slug, @seed_slugs) = 0) AS console_rows
  FROM posts WHERE source IS NULL;
