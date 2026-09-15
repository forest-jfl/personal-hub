-- Personal Hub 数据库结构
-- 兼容 MySQL 5.7+ / MariaDB 10.3+
-- 由 src/db/migrate.ts 在启动时自动执行（IF NOT EXISTS 幂等）

CREATE TABLE IF NOT EXISTS users (
  id           INT          NOT NULL AUTO_INCREMENT,
  username     VARCHAR(64)  NOT NULL,
  display_name VARCHAR(128) NOT NULL DEFAULT '',
  password_hash VARCHAR(255) NOT NULL,
  role         ENUM('admin', 'user') NOT NULL DEFAULT 'user',
  status       ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  register_ip  VARCHAR(64)  NOT NULL DEFAULT '',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 说明：source / source_guid 允许为 NULL（手工撰写文章为 NULL），
-- 以配合唯一键 uk_source_guid 实现「抓取条目硬去重」而不影响存量手工文章
-- （MySQL/MariaDB 唯一索引允许多行 NULL）。
CREATE TABLE IF NOT EXISTS posts (
  id           INT          NOT NULL AUTO_INCREMENT,
  title        VARCHAR(255) NOT NULL,
  slug         VARCHAR(255) NOT NULL,
  content      MEDIUMTEXT   NOT NULL,
  category     VARCHAR(64)  NOT NULL DEFAULT '',
  views        INT          NOT NULL DEFAULT 0,
  -- 封面：存图床路径（/api/public/files/:id/:token）或 https 外链；空串 = 无封面。
  -- 刻意存地址而不是 files.id：正文插图用的也是同一形态，
  -- 两处一致就不必为了取封面再 JOIN 一次 files。
  cover        VARCHAR(512) NOT NULL DEFAULT '',
  status       ENUM('draft', 'published') NOT NULL DEFAULT 'draft',
  author_id    INT          NOT NULL,
  -- ---- 每日抓取来源信息（手工文章全为 NULL / 空串）----
  source       VARCHAR(32)  NULL DEFAULT NULL COMMENT '来源标识，如 sspai / infoq',
  source_name  VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '来源展示名',
  source_url   VARCHAR(768) NOT NULL DEFAULT '' COMMENT '原文链接',
  source_guid  VARCHAR(191) NULL DEFAULT NULL COMMENT '源条目唯一 ID（guid/id）',
  fetched_at   DATETIME     NULL DEFAULT NULL COMMENT '抓取入库时间',
  content_hash CHAR(32)     NOT NULL DEFAULT '' COMMENT '正文摘要指纹，用于更新判断',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_slug (slug),
  UNIQUE KEY uk_source_guid (source, source_guid),
  KEY idx_status (status),
  KEY idx_category (category),
  KEY idx_source_fetched (source, fetched_at),
  CONSTRAINT fk_post_author FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 每日抓取任务的执行留痕（每源每次一行），供控制台查看任务健康度
CREATE TABLE IF NOT EXISTS feed_fetch_log (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  run_id      VARCHAR(40)  NOT NULL DEFAULT '' COMMENT '同一次任务运行的批次标识',
  source      VARCHAR(32)  NOT NULL DEFAULT '',
  source_name VARCHAR(64)  NOT NULL DEFAULT '',
  mode        VARCHAR(16)  NOT NULL DEFAULT 'live' COMMENT 'live | dry-run',
  ok          TINYINT      NOT NULL DEFAULT 0,
  items_found INT          NOT NULL DEFAULT 0,
  items_new   INT          NOT NULL DEFAULT 0,
  items_upd   INT          NOT NULL DEFAULT 0,
  items_skip  INT          NOT NULL DEFAULT 0,
  duration_ms INT          NOT NULL DEFAULT 0,
  error       VARCHAR(512) NOT NULL DEFAULT '',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_created (created_at),
  KEY idx_source (source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS files (
  id            INT          NOT NULL AUTO_INCREMENT,
  original_name VARCHAR(255) NOT NULL,
  stored_name   VARCHAR(255) NOT NULL,
  mime          VARCHAR(128) NOT NULL DEFAULT '',
  size          BIGINT       NOT NULL DEFAULT 0,
  owner_id      INT          NOT NULL,
  public_token  VARCHAR(64)  NOT NULL DEFAULT '',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_owner (owner_id),
  CONSTRAINT fk_file_owner FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 远程控制命令审计日志（谁在什么时候执行了什么命令、结果如何）
CREATE TABLE IF NOT EXISTS remote_cmd_log (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  user_id    INT          NOT NULL,
  username   VARCHAR(64)  NOT NULL DEFAULT '',
  command    VARCHAR(64)  NOT NULL,
  args       VARCHAR(512) NOT NULL DEFAULT '',
  ok         TINYINT      NOT NULL DEFAULT 0,
  output     TEXT         NULL,
  ip         VARCHAR(64)  NOT NULL DEFAULT '',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 注意：会话表 sessions 由 express-mysql-session 自动创建，无需在此定义。
