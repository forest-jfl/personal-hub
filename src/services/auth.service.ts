import bcrypt from 'bcryptjs';
import { findByUsername } from '../repositories/user.repo';
import { User } from '../models/types';

/** 校验用户名/密码，成功返回用户，失败返回 null。 */
export async function verifyCredentials(username: string, password: string): Promise<User | null> {
  const user = await findByUsername(username);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  return ok ? user : null;
}

/** 生成 bcrypt 密码哈希（cost=12）。 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}
