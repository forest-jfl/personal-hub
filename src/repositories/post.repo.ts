import { pool } from '../db/connection';
import { Post, PostStatus } from '../models/types';

export async function createPost(input: {
  title: string;
  slug: string;
  content: string;
  category?: string;
  status: PostStatus;
  author_id: number;
}): Promise<Post> {
  const [result] = await pool.query(
    'INSERT INTO posts (title, slug, content, category, status, author_id) VALUES (?, ?, ?, ?, ?, ?)',
    [input.title, input.slug, input.content, input.category || '', input.status, input.author_id]
  );
  const id = (result as any).insertId;
  const post = await getPostById(id);
  if (!post) throw new Error('创建文章失败');
  return post;
}

export async function getPostById(id: number): Promise<Post | null> {
  const [rows] = await pool.query('SELECT * FROM posts WHERE id = ? LIMIT 1', [id]);
  return (rows as Post[])[0] ?? null;
}

export async function getPostBySlug(slug: string): Promise<Post | null> {
  const [rows] = await pool.query('SELECT * FROM posts WHERE slug = ? LIMIT 1', [slug]);
  return (rows as Post[])[0] ?? null;
}

export async function incrementViews(id: number): Promise<void> {
  await pool.query('UPDATE posts SET views = views + 1 WHERE id = ?', [id]);
}

export interface ListFilter {
  status?: PostStatus;
  author_id?: number;
  category?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface PageResult {
  posts: (Post & { author_name: string })[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_DEFAULT = 10;
const PAGE_MAX = 50;

/** 列表查询：支持分类/标题搜索/分页，JOIN users 带出作者显示名。 */
export async function listPosts(filter?: ListFilter): Promise<Post[] | PageResult> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.status) {
    where.push('p.status = ?');
    params.push(filter.status);
  }
  if (filter?.author_id !== undefined) {
    where.push('p.author_id = ?');
    params.push(filter.author_id);
  }
  if (filter?.category) {
    where.push('p.category = ?');
    params.push(filter.category);
  }
  if (filter?.q) {
    where.push('p.title LIKE ?');
    params.push(`%${filter.q}%`);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  // 需要分页时返回 PageResult，否则保持旧行为返回数组
  if (filter?.page !== undefined) {
    const page = Math.max(1, filter.page);
    const pageSize = Math.min(PAGE_MAX, Math.max(1, filter.pageSize || PAGE_DEFAULT));
    const [countRows] = await pool.query(
      'SELECT COUNT(*) AS total FROM posts p' + whereSql,
      params
    );
    const total = (countRows as Array<{ total: number }>)[0]?.total ?? 0;
    const [rows] = await pool.query(
      'SELECT p.*, u.display_name AS author_name FROM posts p LEFT JOIN users u ON u.id = p.author_id' +
        whereSql +
        ' ORDER BY p.updated_at DESC LIMIT ? OFFSET ?',
      [...params, pageSize, (page - 1) * pageSize]
    );
    return { posts: rows as (Post & { author_name: string })[], total, page, pageSize };
  }

  const [rows] = await pool.query(
    'SELECT p.*, u.display_name AS author_name FROM posts p LEFT JOIN users u ON u.id = p.author_id' +
      whereSql +
      ' ORDER BY p.updated_at DESC',
    params
  );
  return rows as (Post & { author_name: string })[];
}

/** 侧边栏元数据：分类统计、按月归档、热门文章。 */
export async function getBlogMeta(): Promise<{
  categories: { name: string; count: number }[];
  archive: { month: string; count: number }[];
  hot: { title: string; slug: string; views: number }[];
}> {
  const [cats] = await pool.query(
    "SELECT category AS name, COUNT(*) AS count FROM posts WHERE status = 'published' AND category <> '' GROUP BY category ORDER BY count DESC, name ASC"
  );
  const [arch] = await pool.query(
    "SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS count FROM posts WHERE status = 'published' GROUP BY month ORDER BY month DESC LIMIT 12"
  );
  const [hot] = await pool.query(
    "SELECT title, slug, views FROM posts WHERE status = 'published' ORDER BY views DESC, created_at DESC LIMIT 5"
  );
  return {
    categories: cats as { name: string; count: number }[],
    archive: arch as { month: string; count: number }[],
    hot: hot as { title: string; slug: string; views: number }[],
  };
}

export async function updatePost(
  id: number,
  input: Partial<{ title: string; slug: string; content: string; category: string; status: PostStatus }>
): Promise<Post | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.title !== undefined) {
    sets.push('title = ?');
    params.push(input.title);
  }
  if (input.slug !== undefined) {
    sets.push('slug = ?');
    params.push(input.slug);
  }
  if (input.content !== undefined) {
    sets.push('content = ?');
    params.push(input.content);
  }
  if (input.category !== undefined) {
    sets.push('category = ?');
    params.push(input.category);
  }
  if (input.status !== undefined) {
    sets.push('status = ?');
    params.push(input.status);
  }
  if (!sets.length) return getPostById(id);
  params.push(id);
  await pool.query('UPDATE posts SET ' + sets.join(', ') + ' WHERE id = ?', params);
  return getPostById(id);
}

export async function deletePost(id: number): Promise<void> {
  await pool.query('DELETE FROM posts WHERE id = ?', [id]);
}
