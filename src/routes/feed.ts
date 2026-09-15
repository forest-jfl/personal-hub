import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { config } from '../config';
import { logger } from '../utils/logger';
import { FEED_SOURCES, resolveSources } from '../services/daily-feed/sources';
import { getLastRun, runDailyFeed } from '../services/daily-feed';
import { schedulerStatus } from '../services/daily-feed/scheduler';
import * as feedRepo from '../repositories/feed.repo';

/**
 * 每日抓取的管理接口（仅管理员）。
 *  - GET  /api/feed/status   调度状态 + 可用来源 + 最近运行与留痕
 *  - GET  /api/feed/pending  待审抓取条目
 *  - POST /api/feed/run      手动触发一次（支持 dryRun，便于上线前验证）
 */
const router = Router();
router.use(requireAdmin);

router.get('/status', async (_req, res, next) => {
  try {
    const { run, restoredFrom } = await getLastRun();
    const [logs, counts] = await Promise.all([
      feedRepo.listRecentFeedLogs(20),
      feedRepo.feedCounts(),
    ]);
    res.json({
      scheduler: schedulerStatus(),
      config: {
        enabled: config.feed.enabled,
        time: config.feed.time,
        tz: config.feed.tz,
        publishStatus: config.feed.publishStatus,
        excerptChars: config.feed.excerptChars,
        dedupTitle: config.feed.dedupTitle,
        dedupTitleDays: config.feed.dedupTitleDays,
        maxItems: config.feed.maxItems,
        notify: config.feed.notify,
      },
      activeSources: resolveSources(config.feed.sources).map(sourceBrief),
      allSources: FEED_SOURCES.map(sourceBrief),
      counts,
      lastRun: run,
      lastRunRestoredFrom: restoredFrom,
      recentLogs: logs,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/pending', async (_req, res, next) => {
  try {
    const posts = await feedRepo.listPendingFeedPosts(50);
    res.json({
      posts: posts.map((p) => ({
        id: p.id,
        title: p.title,
        slug: p.slug,
        category: p.category,
        source: p.source,
        source_name: p.source_name,
        source_url: p.source_url,
        fetched_at: p.fetched_at,
        created_at: p.created_at,
      })),
    });
  } catch (e) {
    next(e);
  }
});

const runSchema = z.object({
  dryRun: z.boolean().optional(),
  sources: z.array(z.string().max(32)).max(20).optional(),
});

router.post('/run', validateBody(runSchema), async (req, res, next) => {
  try {
    const { dryRun, sources } = req.body as { dryRun?: boolean; sources?: string[] };
    logger.info({ by: req.session!.username, dryRun: !!dryRun, sources }, '管理员手动触发每日抓取');
    const result = await runDailyFeed({
      dryRun: !!dryRun,
      sourceIds: sources,
      trigger: 'manual',
    });
    res.json({ ok: true, result });
  } catch (e) {
    next(e);
  }
});

function sourceBrief(s: (typeof FEED_SOURCES)[number]) {
  return { id: s.id, name: s.name, url: s.url, category: s.category, maxItems: s.maxItems ?? null };
}

export default router;
