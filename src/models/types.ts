export type Role = 'admin' | 'user';
export type PostStatus = 'draft' | 'published';

export interface User {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  created_at: Date;
}

/** 对外暴露的用户信息（不含密码哈希）。 */
export type PublicUser = Omit<User, 'password_hash'>;

export interface Post {
  id: number;
  title: string;
  slug: string;
  content: string;
  status: PostStatus;
  author_id: number;
  created_at: Date;
  updated_at: Date;
}

export interface FileMeta {
  id: number;
  original_name: string;
  stored_name: string;
  mime: string;
  size: number;
  owner_id: number;
  created_at: Date;
}
