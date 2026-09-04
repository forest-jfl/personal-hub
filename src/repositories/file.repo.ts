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
