import { pool } from '../db/connection';
import { FileMeta } from '../models/types';

export async function createFile(input: {
  original_name: string;
  stored_name: string;
  mime: string;
  size: number;
  owner_id: number;
  public_token: string;
}): Promise<FileMeta> {
  const [result] = await pool.query(
    'INSERT INTO files (original_name, stored_name, mime, size, owner_id, public_token) VALUES (?, ?, ?, ?, ?, ?)',
    [input.original_name, input.stored_name, input.mime, input.size, input.owner_id, input.public_token]
  );
  const id = (result as any).insertId;
  const file = await getFileById(id);
  if (!file) throw new Error('创建文件记录失败');
  return file;
}

export async function getFileById(id: number): Promise<FileMeta | null> {
  const [rows] = await pool.query('SELECT * FROM files WHERE id = ? LIMIT 1', [id]);
  return (rows as FileMeta[])[0] ?? null;
}

/** 按 id + 公开令牌取文件（用于文章内图片的免登录访问）。 */
export async function getFileByToken(id: number, token: string): Promise<FileMeta | null> {
  const [rows] = await pool.query('SELECT * FROM files WHERE id = ? AND public_token = ? LIMIT 1', [
    id,
    token,
  ]);
  return (rows as FileMeta[])[0] ?? null;
}

export async function listFiles(ownerId?: number): Promise<FileMeta[]> {
  if (ownerId !== undefined) {
    const [rows] = await pool.query('SELECT * FROM files WHERE owner_id = ? ORDER BY created_at DESC', [
      ownerId,
    ]);
    return rows as FileMeta[];
  }
  const [rows] = await pool.query('SELECT * FROM files ORDER BY created_at DESC');
  return rows as FileMeta[];
}

export async function deleteFile(id: number): Promise<void> {
  await pool.query('DELETE FROM files WHERE id = ?', [id]);
}

/** 统计某用户已用文件空间（字节）。 */
export async function sumUserUsedBytes(ownerId: number): Promise<number> {
  const [rows] = await pool.query('SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE owner_id = ?', [
    ownerId,
  ]);
  return Number((rows as Array<{ used: number }>)[0]?.used ?? 0);
}

/** 为存量文件补发公开令牌（一次性迁移）。 */
export async function backfillPublicTokens(): Promise<number> {
  const [rows] = await pool.query("SELECT id FROM files WHERE public_token = ''");
  const list = rows as Array<{ id: number }>;
  for (const row of list) {
    await pool.query('UPDATE files SET public_token = ? WHERE id = ?', [
      Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2),
      row.id,
    ]);
  }
  return list.length;
}

/**
 * 修复历史乱码文件名：multer/busboy 默认按 latin1 解码 multipart 文件名，
 * UTF-8 中文名会被存成 "æµ‹è¯•..."。本函数检测并还原为正确 UTF-8。
 */
export function decodeOriginalName(raw: string): string {
  // 纯 ASCII 无需处理；已含非 Latin-1 字符说明是正常 Unicode
  if (/^[\x00-\x7F]*$/.test(raw)) return raw;
  if ([...raw].some((c) => c.charCodeAt(0) > 255)) return raw;
  const buf = Buffer.from(raw, 'latin1');
  const fixed = buf.toString('utf8');
  // 含替换符或无法还原则保留原值
  if (fixed !== raw && fixed.indexOf('\uFFFD') === -1 && Buffer.from(fixed, 'utf8').equals(buf)) {
    return fixed;
  }
  return raw;
}

/** 修复存量库中的乱码文件名，返回修复条数。 */
export async function fixMojibakeNames(): Promise<number> {
  const [rows] = await pool.query('SELECT id, original_name FROM files');
  const list = rows as Array<{ id: number; original_name: string }>;
  let fixed = 0;
  for (const row of list) {
    const name = decodeOriginalName(row.original_name || '');
    if (name !== row.original_name) {
      await pool.query('UPDATE files SET original_name = ? WHERE id = ?', [name, row.id]);
      fixed += 1;
    }
  }
  return fixed;
}
