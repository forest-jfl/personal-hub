import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { pool } from './connection';
import { config } from '../config';
import { logger } from '../utils/logger';
import { backfillPublicTokens } from '../repositories/file.repo';

// 构建后位于 dist/db，__dirname/../../schema.sql 指向项目根；ts-node 下同理。
const SCHEMA_PATH = path.resolve(__dirname, '..', '..', 'schema.sql');

/** 读取 schema.sql 并按语句执行（幂等，全部 IF NOT EXISTS）。 */
export async function runMigrations(): Promise<void> {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  // 先按行去掉 -- 注释（避免注释与首个建表语句粘连被整体过滤掉）
  const cleaned = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const statements = cleaned
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    await pool.query(stmt);
  }
  logger.info('数据库结构已确保（schema.sql）');

  await ensureColumns();
  await seedAdmin();
}

/** 存量库补列：posts.category / posts.views / users.status / files.public_token（schema.sql 的 IF NOT EXISTS 只管建表）。 */
async function ensureColumns(): Promise<void> {
  const wanted: Array<{ table: string; column: string; ddl: string }> = [
    { table: 'posts', column: 'category', ddl: "ALTER TABLE posts ADD COLUMN category VARCHAR(64) NOT NULL DEFAULT ''" },
    { table: 'posts', column: 'views', ddl: 'ALTER TABLE posts ADD COLUMN views INT NOT NULL DEFAULT 0' },
    { table: 'users', column: 'status', ddl: "ALTER TABLE users ADD COLUMN status ENUM('active', 'disabled') NOT NULL DEFAULT 'active'" },
    { table: 'files', column: 'public_token', ddl: "ALTER TABLE files ADD COLUMN public_token VARCHAR(64) NOT NULL DEFAULT ''" },
  ];
  for (const item of wanted) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [item.table, item.column]
    );
    const n = (rows as Array<{ n: number }>)[0]?.n ?? 0;
    if (!n) {
      await pool.query(item.ddl);
      logger.info({ table: item.table, column: item.column }, '已补充缺失列');
    }
  }
  // 为存量文件补发公开令牌
  const backfilled = await backfillPublicTokens();
  if (backfilled > 0) logger.info({ count: backfilled }, '已为存量文件补发公开令牌');
}

/** 若不存在则播种初始管理员（凭据来自环境变量）。 */
async function seedAdmin(): Promise<void> {
  const [rows] = await pool.query('SELECT id FROM users WHERE username = ? LIMIT 1', [
    config.admin.username,
  ]);
  if (Array.isArray(rows) && (rows as unknown[]).length > 0) return;

  const hash = await bcrypt.hash(config.admin.password, 12);
  await pool.query(
    'INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)',
    [config.admin.username, config.admin.displayName, hash, 'admin']
  );
  logger.info({ username: config.admin.username }, '已播种初始管理员账号');
}
