export type Role = 'admin' | 'user';
export type PostStatus = 'draft' | 'published';
export type UserStatus = 'active' | 'disabled';

export interface User {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  status: UserStatus;
  created_at: Date;
}

/** 对外暴露的用户信息（不含密码哈希）。 */
export type PublicUser = Omit<User, 'password_hash'>;

export interface Post {
  id: number;
  title: string;
  slug: string;
  content: string;
  category: string;
  views: number;
  /**
   * 封面图地址。两种合法形态：
   *  · 站内图床 `/api/public/files/:id/:token`
   *  · 外部 `https://…`
   * 空串表示无封面（列表与详情退回纯文字版式）。
   */
  cover: string;
  status: PostStatus;
  author_id: number;
  /** 抓取来源标识；手工文章为 null */
  source: string | null;
  /** 来源展示名，如「少数派」 */
  source_name: string;
  /** 原文链接 */
  source_url: string;
  /** 源条目唯一 ID，与 source 组成硬去重键 */
  source_guid: string | null;
  /** 抓取入库时间；手工文章为 null */
  fetched_at: Date | null;
  /** 正文摘要指纹 */
  content_hash: string;
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
  public_token: string;
  created_at: Date;
}
