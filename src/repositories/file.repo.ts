import { pool } from '../db/connection';
import { FileMeta } from '../models/types';

export async function createFile(input: {
  original_name: string;
  stored_name: string;
  mime: string;
  size: number;
  owner_id: number;
}): Promise<FileMeta> {
  const [result] = await pool.query(
    'INSERT INTO files (original_name, stored_name, mime, size, owner_id) VALUES (?, ?, ?, ?, ?)',
    [input.original_name, input.stored_name, input.mime, input.size, input.owner_id]
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

export async function listFiles(): Promise<FileMeta[]> {
  const [rows] = await pool.query('SELECT * FROM files ORDER BY created_at DESC');
  return rows as FileMeta[];
}

export async function deleteFile(id: number): Promise<void> {
  await pool.query('DELETE FROM files WHERE id = ?', [id]);
}
