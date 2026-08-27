import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { pool } from './connection';
import { config } from '../config';
import { logger } from '../utils/logger';

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

  await seedAdmin();
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
