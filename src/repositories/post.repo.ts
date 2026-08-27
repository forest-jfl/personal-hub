import { pool } from '../db/connection';
import { Post, PostStatus } from '../models/types';

export async function createPost(input: {
  title: string;
  slug: string;
  content: string;
  status: PostStatus;
  author_id: number;
}): Promise<Post> {
  const [result] = await pool.query(
    'INSERT INTO posts (title, slug, content, status, author_id) VALUES (?, ?, ?, ?, ?)',
    [input.title, input.slug, input.content, input.status, input.author_id]
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

export async function listPosts(filter?: {
  status?: PostStatus;
  author_id?: number;
}): Promise<Post[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter?.author_id !== undefined) {
    where.push('author_id = ?');
    params.push(filter.author_id);
  }
  const sql =
    'SELECT * FROM posts' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY updated_at DESC';
  const [rows] = await pool.query(sql, params);
  return rows as Post[];
}

export async function updatePost(
  id: number,
  input: Partial<{ title: string; slug: string; content: string; status: PostStatus }>
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
