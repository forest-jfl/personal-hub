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
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS posts (
  id         INT          NOT NULL AUTO_INCREMENT,
  title      VARCHAR(255) NOT NULL,
  slug       VARCHAR(255) NOT NULL,
  content    MEDIUMTEXT   NOT NULL,
  category   VARCHAR(64)  NOT NULL DEFAULT '',
  views      INT          NOT NULL DEFAULT 0,
  status     ENUM('draft', 'published') NOT NULL DEFAULT 'draft',
  author_id  INT          NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_slug (slug),
  KEY idx_status (status),
  KEY idx_category (category),
  CONSTRAINT fk_post_author FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE CASCADE
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

-- 注意：会话表 sessions 由 express-mysql-session 自动创建，无需在此定义。
