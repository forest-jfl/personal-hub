import { pool } from '../db/connection';
import { Post, PostStatus } from '../models/types';
import { normalizeTitleKey } from '../services/daily-feed/normalize';

/**
 * 每日抓取的数据访问层：去重写入（upsert）、运行留痕与查询。
 *
 * 去重分两级：
 *  ① 硬去重 —— 唯一键 uk_source_guid(source, source_guid)，同源同条目永不重复入库；
 *  ② 软去重 —— 跨源同题（标题归一化后相同且在 N 天内）默认跳过，可配置关闭。
 * 「更新判断」由 content_hash 承担：指纹未变则不写库，避免无效刷新 updated_at。
 */

export interface FeedUpsertInput {
  source: string;
  sourceName: string;
  sourceUrl: string;
  sourceGuid: string;
  title: string;
  slug: string;
  content: string;
  contentHash: string;
  category: string;
  /** 入库初始状态（draft 表示待人工审核） */
  status: PostStatus;
  authorId: number;
  /** 目标时区的 DATETIME 字符串（YYYY-MM-DD HH:MM:SS） */
  fetchedAt: string;
}

export type FeedUpsertAction = 'inserted' | 'updated' | 'skipped' | 'duplicate-title';

export interface FeedUpsertResult {
  action: FeedUpsertAction;
  id?: number;
  /** duplicate-title 时命中的已有文章标题 */
  conflictTitle?: string;
}

export interface FeedDedupOptions {
  /** 是否启用跨源同题软去重 */
  dedupTitle: boolean;
  /** 软去重回溯天数 */
  dedupTitleDays: number;
}

/** 单条抓取条目的写入判定与执行。 */
export async function upsertFeedPost(
  input: FeedUpsertInput,
  dedup: FeedDedupOptions
): Promise<FeedUpsertResult> {
  // ---- ① 硬去重：同源同 guid ----
  const [existRows] = await pool.query(
    'SELECT id, content_hash, status FROM posts WHERE source = ? AND source_guid = ? LIMIT 1',
    [input.source, input.sourceGuid]
  );
  const existing = (existRows as Array<{ id: number; content_hash: string; status: PostStatus }>)[0];

  if (existing) {
    // 更新判断：指纹一致 → 原文摘要未变，跳过写库（同时不刷新 updated_at）
    if (existing.content_hash === input.contentHash) {
      return { action: 'skipped', id: existing.id };
    }
    // 只更新内容相关列：status/created_at 保持原样，避免把已审核发布的文章退回草稿
    await pool.query(
      'UPDATE posts SET title = ?, content = ?, category = ?, source_url = ?, fetched_at = ?, content_hash = ? WHERE id = ?',
      [input.title, input.content, input.category, input.sourceUrl, input.fetchedAt, input.contentHash, existing.id]
    );
    return { action: 'updated', id: existing.id };
  }

  // ---- ② 软去重：跨源同题 ----
  if (dedup.dedupTitle && input.title) {
    const probe = input.title.slice(0, 10);
    const [nearRows] = await pool.query(
      'SELECT id, title FROM posts WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND title LIKE ? LIMIT 25',
      [dedup.dedupTitleDays, `%${probe}%`]
    );
    const key = normalizeTitleKey(input.title);
    const hit = (nearRows as Array<{ id: number; title: string }>).find(
      (r) => normalizeTitleKey(r.title) === key
    );
    if (hit) return { action: 'duplicate-title', conflictTitle: hit.title, id: hit.id };
  }

  // ---- ③ 新增 ----
  try {
    const [result] = await pool.query(
      'INSERT INTO posts (title, slug, content, category, status, author_id, source, source_name, source_url, source_guid, fetched_at, content_hash) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        input.title,
        input.slug,
        input.content,
        input.category,
        input.status,
        input.authorId,
        input.source,
        input.sourceName,
        input.sourceUrl,
        input.sourceGuid,
        input.fetchedAt,
        input.contentHash,
      ]
    );
    return { action: 'inserted', id: (result as { insertId: number }).insertId };
  } catch (e) {
    // 并发下可能撞唯一键：视为已存在
    if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
      return { action: 'skipped' };
    }
    throw e;
  }
}

/**
 * 批量写入运行留痕（每源一行）。
 *
 * created_at 由应用显式写入目标时区的墙上时间，而不是交给 DEFAULT CURRENT_TIMESTAMP：
 * 容器内 MariaDB 默认 UTC，若用数据库时钟会比应用侧写入的 posts.fetched_at 差 8 小时，
 * 两张表的「今天」将落在不同日子。
 */
export async function insertFeedLogs(
  rows: Array<{
    runId: string;
    source: string;
    sourceName: string;
    mode: string;
    ok: boolean;
    itemsFound: number;
    itemsNew: number;
    itemsUpd: number;
    itemsSkip: number;
    durationMs: number;
    error: string;
    createdAt: string;
  }>
): Promise<void> {
  if (!rows.length) return;
  const values = rows.map((r) => [
    r.runId,
    r.source,
    r.sourceName,
    r.mode,
    r.ok ? 1 : 0,
    r.itemsFound,
    r.itemsNew,
    r.itemsUpd,
    r.itemsSkip,
    r.durationMs,
    r.error.slice(0, 500),
    r.createdAt,
  ]);
  await pool.query(
    'INSERT INTO feed_fetch_log (run_id, source, source_name, mode, ok, items_found, items_new, items_upd, items_skip, duration_ms, error, created_at) VALUES ?',
    [values]
  );
}

/**
 * 最近的抓取运行记录（控制台状态面板用）。
 * dateStrings: true → 直接返回 DATETIME 原始字符串，不做任何时区换算，
 * 避免「存的是北京时间 11:47、显示成 03:47」这类前端截断 UTC 串的问题。
 */
export async function listRecentFeedLogs(limit = 20): Promise<
  Array<{
    id: number;
    run_id: string;
    source: string;
    source_name: string;
    mode: string;
    ok: number;
    items_found: number;
    items_new: number;
    items_upd: number;
    items_skip: number;
    duration_ms: number;
    error: string;
    created_at: string;
  }>
> {
  const [rows] = await pool.query({
    sql:
      'SELECT id, run_id, source, source_name, mode, ok, items_found, items_new, items_upd, items_skip, duration_ms, error, created_at ' +
      'FROM feed_fetch_log ORDER BY id DESC LIMIT ?',
    values: [Math.min(200, Math.max(1, limit))],
    dateStrings: true,
  });
  return rows as never;
}

/**
 * 当日新增的抓取条目（公开主页「今日更新」区块用）。
 * 只返回 published：草稿待审，不得出现在公开页面。
 */
export async function listDailyUpdates(
  dateInTz: string,
  limit = 12
): Promise<
  Array<
    Pick<
      Post,
      'id' | 'title' | 'slug' | 'category' | 'views' | 'source' | 'source_name' | 'source_url' | 'fetched_at' | 'created_at'
    > & { summary: string }
  >
> {
  const [rows] = await pool.query(
    'SELECT id, title, slug, category, views, source, source_name, source_url, fetched_at, created_at, content ' +
      "FROM posts WHERE status = 'published' AND source IS NOT NULL AND DATE(fetched_at) = ? " +
      'ORDER BY fetched_at DESC, id DESC LIMIT ?',
    [dateInTz, Math.min(50, Math.max(1, limit))]
  );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as number,
    title: r.title as string,
    slug: r.slug as string,
    category: r.category as string,
    views: r.views as number,
    source: r.source as string,
    source_name: r.source_name as string,
    source_url: r.source_url as string,
    fetched_at: r.fetched_at as Date,
    created_at: r.created_at as Date,
    summary: String(r.content || '')
      .replace(/^>.*$/gm, '')
      .replace(/[#>*`\-\[\]!]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120),
  }));
}

/** 待审核的抓取条目（控制台用）。 */
export async function listPendingFeedPosts(limit = 50): Promise<Post[]> {
  const [rows] = await pool.query(
    "SELECT * FROM posts WHERE source IS NOT NULL AND status = 'draft' ORDER BY fetched_at DESC, id DESC LIMIT ?",
    [Math.min(200, Math.max(1, limit))]
  );
  return rows as Post[];
}

/** 抓取条目总览计数（控制台用）。 */
export async function feedCounts(): Promise<{ pending: number; published: number; total: number }> {
  const [rows] = await pool.query(
    "SELECT status, COUNT(*) AS n FROM posts WHERE source IS NOT NULL GROUP BY status"
  );
  let pending = 0;
  let published = 0;
  for (const r of rows as Array<{ status: string; n: number }>) {
    if (r.status === 'draft') pending += Number(r.n);
    if (r.status === 'published') published += Number(r.n);
  }
  return { pending, published, total: pending + published };
}

/**
 * 指定日期（目标时区的 YYYY-MM-DD）是否已有成功留痕。
 * 调度器启动时用它恢复「当日是否已执行」，避免进程重启（如部署）后重复抓取一整天。
 */
export async function hasRunOnDate(dateInTz: string): Promise<boolean> {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS n FROM feed_fetch_log WHERE DATE(created_at) = ? AND mode = ?',
    [dateInTz, 'live']
  );
  return ((rows as Array<{ n: number }>)[0]?.n ?? 0) > 0;
}
