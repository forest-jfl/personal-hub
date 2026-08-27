import { pool } from '../db/connection';
import { User, PublicUser, Role } from '../models/types';

export function toPublicUser(u: User): PublicUser {
  const { password_hash, ...rest } = u;
  return rest;
}

export async function createUser(input: {
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
}): Promise<User> {
  const [result] = await pool.query(
    'INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)',
    [input.username, input.display_name, input.password_hash, input.role]
  );
  const id = (result as any).insertId;
  const created = await findById(id);
  if (!created) throw new Error('创建用户失败');
  return created;
}

export async function findByUsername(username: string): Promise<User | null> {
  const [rows] = await pool.query('SELECT * FROM users WHERE username = ? LIMIT 1', [username]);
  const list = rows as User[];
  return list[0] ?? null;
}

export async function findById(id: number): Promise<User | null> {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  const list = rows as User[];
  return list[0] ?? null;
}

export async function listUsers(): Promise<PublicUser[]> {
  const [rows] = await pool.query('SELECT * FROM users ORDER BY id ASC');
  return (rows as User[]).map(toPublicUser);
}

export async function deleteUser(id: number): Promise<void> {
  await pool.query('DELETE FROM users WHERE id = ?', [id]);
}

export async function countAdmins(): Promise<number> {
  const [rows] = await pool.query('SELECT COUNT(*) AS c FROM users WHERE role = ?', ['admin']);
  return (rows as any[])[0].c as number;
}
