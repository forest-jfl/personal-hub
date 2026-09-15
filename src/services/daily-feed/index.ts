import crypto from 'crypto';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { dbDateTimeInTz, displayDateTimeInTz } from '../../utils/tz';
import * as feedRepo from '../../repositories/feed.repo';
import { pool } from '../../db/connection';
import { pushMessage } from '../notify';
import { fetchText } from './fetcher';
import { parseFeed } from './rss';
import {
  buildPostContent,
  buildSlug,
  contentHash,
  makeExcerpt,
  normalizeTitleKey,
  toPlainText,
} from './normalize';
import { resolveExcerpt } from './extract';
import { resolveSources, FEED_SOURCES, type FeedSource } from './sources';

/**
 * 每日抓取编排：抓取 → 解析 → 规范化 → 两级去重 upsert → 留痕 → 通知。
 *
 * 设计取舍：
 *  - 单源失败不阻断整体（Promise.allSettled），失败原因写入 feed_fetch_log；
 *  - 入库默认 draft，等管理员在控制台确认后发布；
 *  - 公开主页只展示 published 的抓取条目，草稿不外泄。
 */

export interface FeedSourceResult {
  source: string;
  sourceName: string;
  ok: boolean;
  itemsFound: number;
  itemsNew: number;
  itemsUpdated: number;
  itemsSkipped: number;
  durationMs: number;
  error?: string;
  /** dry-run 时的候选条目预览 */
  preview?: Array<{ title: string; link: string; action: string }>;
}

export interface FeedRunResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  trigger: string;
  sources: FeedSourceResult[];
  totals: { found: number; created: number; updated: number; skipped: number; failedSources: number };
}

export interface FeedRunOptions {
  /** 干跑：只抓取与解析，不写库、不通知 */
  dryRun?: boolean;
  /** 仅跑指定来源 id，留空跑配置的全部来源 */
  sourceIds?: string[];
  /** 触发方式标识：schedule | manual | cli | startup */
  trigger?: string;
}

/** 取管理员账号 id 作为抓取条目的作者（避免出现无主文章）。 */
async function resolveAuthorId(): Promise<number> {
  const [rows] = await pool.query("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const id = (rows as Array<{ id: number }>)[0]?.id;
  if (!id) throw new Error('未找到 admin 用户，无法归属抓取条目作者');
  return id;
}

/** 处理单个来源。 */
async function processSource(
  src: FeedSource,
  opts: { dryRun: boolean; authorId: number; runId: string }
): Promise<FeedSourceResult> {
  const started = Date.now();
  const base: FeedSourceResult = {
    source: src.id,
    sourceName: src.name,
    ok: false,
    itemsFound: 0,
    itemsNew: 0,
    itemsUpdated: 0,
    itemsSkipped: 0,
    durationMs: 0,
  };

  try {
    const res = await fetchText(src.url, {
      timeoutMs: config.feed.timeoutMs,
      retries: config.feed.retries,
      userAgent: config.feed.userAgent,
    });
    const parsed = parseFeed(res.text, src.homepage || res.finalUrl);
    const limit = src.maxItems ?? config.feed.maxItems;
    const items = parsed.items.slice(0, Math.max(1, limit));
    base.itemsFound = items.length;

    if (!items.length) {
      base.ok = true;
      base.error = 'feed 解析成功但无有效条目';
      base.durationMs = Date.now() - started;
      return base;
    }

    const fetchedAtDb = dbDateTimeInTz(config.feed.tz);
    const fetchedAtText = displayDateTimeInTz(config.feed.tz);
    const preview: FeedSourceResult['preview'] = [];

    // 新鲜度阈值：pubDate 早于 FEED_MAX_AGE_DAYS 的条目丢弃（防陈旧 feed）
    const maxAgeMs = config.feed.maxAgeDays > 0 ? config.feed.maxAgeDays * 86400_000 : 0;
    const nowMs = Date.now();

    // 同批次内标题去重（源站偶有重复条目）
    const seenInBatch = new Set<string>();
    let staleSkipped = 0;
    let ogFallbacks = 0;
    let noExcerpt = 0;
    let ogAttempts = 0;

    for (const item of items) {
      const title = item.title || toPlainText(item.description).slice(0, 60) || '未命名条目';
      const guid = item.guid || item.link || `${src.id}:${normalizeTitleKey(title)}`;
      if (!item.link && !item.guid) {
        base.itemsSkipped++;
        continue;
      }
      // 时间过滤：pubDate 无法解析时不拦截（宁可多抓也不漏抓）
      if (maxAgeMs > 0 && item.pubDate) {
        const ts = Date.parse(item.pubDate);
        if (Number.isFinite(ts) && nowMs - ts > maxAgeMs) {
          staleSkipped++;
          base.itemsSkipped++;
          continue;
        }
      }
      const titleKey = normalizeTitleKey(title);
      if (titleKey && seenInBatch.has(titleKey)) {
        base.itemsSkipped++;
        continue;
      }
      if (titleKey) seenInBatch.add(titleKey);

      const excerpt = makeExcerpt(item.description, src.homepage, {
        excerptChars: config.feed.excerptChars,
      });
      // RSS 摘要低质（源站只放推广文案）时回退原文页 og:description；
      // 原文页较慢，故对每个来源的回退次数封顶。
      const resolved = await resolveExcerpt(excerpt, item.link, {
        excerptChars: config.feed.excerptChars,
        timeoutMs: config.feed.timeoutMs,
        userAgent: config.feed.userAgent,
        fetchOg: config.feed.fetchOg && ogAttempts < config.feed.maxOgPerSource,
      });
      if (resolved.via === 'og') ogFallbacks++;
      else if (resolved.via === 'none') noExcerpt++;
      if (resolved.attemptedOg) ogAttempts++;

      const content = buildPostContent({
        title,
        sourceName: src.name,
        sourceHomepage: src.homepage,
        sourceUrl: item.link,
        excerpt: resolved.text,
        fetchedAtText,
      });
      const hash = contentHash(content);
      const slug = buildSlug(src.id, guid, title);

      if (opts.dryRun) {
        preview.push({ title, link: item.link, action: 'preview' });
        base.itemsNew++;
        continue;
      }

      const r = await feedRepo.upsertFeedPost(
        {
          source: src.id,
          sourceName: src.name,
          sourceUrl: item.link,
          sourceGuid: guid,
          title: title.slice(0, 255),
          slug,
          content,
          contentHash: hash,
          category: src.category || config.feed.category,
          status: config.feed.publishStatus,
          authorId: opts.authorId,
          fetchedAt: fetchedAtDb,
        },
        { dedupTitle: config.feed.dedupTitle, dedupTitleDays: config.feed.dedupTitleDays }
      );

      if (r.action === 'inserted') base.itemsNew++;
      else if (r.action === 'updated') base.itemsUpdated++;
      else {
        base.itemsSkipped++;
        if (r.action === 'duplicate-title') {
          logger.info(
            { source: src.id, title, conflict: r.conflictTitle },
            '跨源同题，跳过入库（软去重）'
          );
        }
      }
      preview.push({ title, link: item.link, action: r.action });
    }

    base.preview = preview;
    base.ok = true;
    base.durationMs = Date.now() - started;
    if (staleSkipped > 0) {
      logger.warn(
        { source: src.id, staleSkipped, maxAgeDays: config.feed.maxAgeDays },
        '部分条目的 pubDate 超出新鲜度阈值，已丢弃（源站 feed 可能长期未更新）'
      );
    }
    if (!base.itemsNew && !base.itemsUpdated && staleSkipped === base.itemsSkipped && staleSkipped > 0) {
      base.error = `全部 ${staleSkipped} 条均超出 ${config.feed.maxAgeDays} 天新鲜度阈值，可能该源的 RSS 已停更`;
    }
    logger.info(
      {
        source: src.id,
        found: base.itemsFound,
        created: base.itemsNew,
        updated: base.itemsUpdated,
        skipped: base.itemsSkipped,
        staleSkipped,
        ogFallbacks,
        noExcerpt,
        ms: base.durationMs,
      },
      '来源处理完成'
    );
    return base;
  } catch (e) {
    base.ok = false;
    base.error = e instanceof Error ? e.message : String(e);
    base.durationMs = Date.now() - started;
    logger.error({ err: e, source: src.id }, '来源处理失败');
    return base;
  }
}

/** 组装运行结果汇总。 */
function summarize(
  sources: FeedSourceResult[],
  meta: { runId: string; startedAt: string; dryRun: boolean; trigger: string }
): FeedRunResult {
  return {
    ...meta,
    finishedAt: dbDateTimeInTz(config.feed.tz),
    sources,
    totals: {
      found: sources.reduce((n, s) => n + s.itemsFound, 0),
      created: sources.reduce((n, s) => n + s.itemsNew, 0),
      updated: sources.reduce((n, s) => n + s.itemsUpdated, 0),
      skipped: sources.reduce((n, s) => n + s.itemsSkipped, 0),
      failedSources: sources.filter((s) => !s.ok).length,
    },
  };
}

/** 把运行结果推送给管理员（复用 NOTIFY_* 渠道）。 */
async function notifyResult(result: FeedRunResult): Promise<void> {
  if (!config.feed.notify || !config.notify.enabled || result.dryRun) return;
  const t = result.totals;
  const lines = result.sources.map(
    (s) =>
      `- ${s.sourceName}：解析 ${s.itemsFound} 条，新增 ${s.itemsNew}，更新 ${s.itemsUpdated}，跳过 ${s.itemsSkipped}` +
      (s.ok ? '' : ` ⚠️ 失败：${s.error ?? '未知错误'}`)
  );
  const text = [
    `## 每日抓取完成（${result.finishedAt}）`,
    '',
    `合计：新增 ${t.created} 条待审，更新 ${t.updated} 条，跳过 ${t.skipped} 条。`,
    '',
    ...lines,
    '',
    t.created > 0
      ? `待审条目已入库为草稿，请前往控制台确认后发布：${config.publicBaseUrl}/console`
      : '本次无新增待审条目。',
  ].join('\n');
  await pushMessage({ title: `每日抓取：新增 ${t.created} 条待审`, text });
}

/** 执行一次每日抓取（可手动触发；调度器与 CLI 均调用此函数）。 */
export async function runDailyFeed(opts: FeedRunOptions = {}): Promise<FeedRunResult> {
  const dryRun = opts.dryRun === true;
  const runId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const startedAt = dbDateTimeInTz(config.feed.tz);
  const trigger = opts.trigger ?? 'manual';

  const all = resolveSources(config.feed.sources);
  const wanted = (opts.sourceIds || [])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // 显式指定来源时从完整清单里取（否则 --source=ithome 会被默认源白名单挡掉）；
  // 未指定时使用 FEED_SOURCES 配置的启用集合。
  let sources: FeedSource[];
  if (wanted.length) {
    sources = FEED_SOURCES.filter((s) => wanted.includes(s.id));
    const unknown = wanted.filter((id) => !FEED_SOURCES.some((s) => s.id === id));
    if (unknown.length) logger.warn({ unknown }, '指定的来源 id 不存在，已忽略');
  } else {
    sources = all;
  }

  if (!sources.length) {
    logger.warn({ configured: config.feed.sources, wanted }, '没有可运行的抓取来源');
    return summarize([], { runId, startedAt, dryRun, trigger });
  }

  logger.info({ runId, trigger, dryRun, sources: sources.map((s) => s.id) }, '每日抓取开始');

  const authorId = dryRun ? 0 : await resolveAuthorId();

  // 串行执行：源数量少，串行可避免对源站形成并发压力，也让日志顺序可读
  const results: FeedSourceResult[] = [];
  for (const src of sources) {
    results.push(await processSource(src, { dryRun, authorId, runId }));
  }

  const result = summarize(results, { runId, startedAt, dryRun, trigger });

  if (!dryRun) {
    try {
      await feedRepo.insertFeedLogs(
        results.map((r) => ({
          runId,
          source: r.source,
          sourceName: r.sourceName,
          mode: 'live',
          ok: r.ok,
          itemsFound: r.itemsFound,
          itemsNew: r.itemsNew,
          itemsUpd: r.itemsUpdated,
          itemsSkip: r.itemsSkipped,
          durationMs: r.durationMs,
          error: r.error ?? '',
          createdAt: dbDateTimeInTz(config.feed.tz),
        }))
      );
      await recordLastRun(result);    } catch (e) {
      logger.error({ err: e }, '写入抓取留痕失败');
    }
    await notifyResult(result);
  }

  logger.info(
    { runId, ...result.totals, dryRun },
    dryRun ? '每日抓取（干跑）结束' : '每日抓取结束'
  );
  return result;
}

// ---------- 最近一次运行结果（内存 + 数据库留痕双通道，供状态接口展示） ----------
let lastRun: FeedRunResult | null = null;

function recordLastRun(result: FeedRunResult): void {
  lastRun = result;
}

/** 读取最近一次运行结果：优先内存，进程重启后从 feed_fetch_log 还原摘要。 */
export async function getLastRun(): Promise<{
  run: FeedRunResult | null;
  restoredFrom: 'memory' | 'db' | 'none';
}> {
  if (lastRun) return { run: lastRun, restoredFrom: 'memory' };
  try {
    const logs = await feedRepo.listRecentFeedLogs(50);
    if (!logs.length) return { run: null, restoredFrom: 'none' };
    const newestRunId = logs[0].run_id;
    const sameRun = logs.filter((l) => l.run_id === newestRunId);
    const restored: FeedRunResult = {
      runId: newestRunId,
      // 留痕以 dateStrings 读回，已是目标时区的墙上时间字符串，直接用
      startedAt: String(sameRun[sameRun.length - 1]?.created_at ?? ''),
      finishedAt: String(sameRun[0]?.created_at ?? ''),
      dryRun: false,
      trigger: 'restored',
      sources: sameRun.map((l) => ({
        source: l.source,
        sourceName: l.source_name,
        ok: !!l.ok,
        itemsFound: Number(l.items_found),
        itemsNew: Number(l.items_new),
        itemsUpdated: Number(l.items_upd),
        itemsSkipped: Number(l.items_skip),
        durationMs: Number(l.duration_ms),
        error: l.error || undefined,
      })),
      totals: {
        found: sameRun.reduce((n, l) => n + Number(l.items_found), 0),
        created: sameRun.reduce((n, l) => n + Number(l.items_new), 0),
        updated: sameRun.reduce((n, l) => n + Number(l.items_upd), 0),
        skipped: sameRun.reduce((n, l) => n + Number(l.items_skip), 0),
        failedSources: sameRun.filter((l) => !l.ok).length,
      },
    };
    return { run: restored, restoredFrom: 'db' };
  } catch {
    return { run: null, restoredFrom: 'none' };
  }
}
