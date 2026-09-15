import { config } from '../../config';
import { logger } from '../../utils/logger';
import { partsInTz } from '../../utils/tz';
import { hasRunOnDate } from '../../repositories/feed.repo';
import { runDailyFeed } from './index';

/**
 * 每日抓取调度器。
 *
 * 不依赖 node-cron：只需「每天某一时刻执行一次」，用分针轮询足够且零依赖。
 * 轮询周期 20s，配合 lastRunDate 守卫保证当日至多执行一次；
 * FEED_CATCH_UP=true 时，进程在触发时刻之后启动会补跑当日任务（重启不丢当天更新）。
 */

const TICK_MS = 20_000;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

let timer: NodeJS.Timeout | null = null;
let lastRunDate = '';
let running = false;
let parsed: { hhmm: string } | null = null;

/** 解析 FEED_TIME，非法值直接抛错（宁可启动失败也不要静默不执行）。 */
function parseTarget(): string {
  const m = TIME_RE.exec(String(config.feed.time).trim());
  if (!m) throw new Error(`FEED_TIME 格式非法：${config.feed.time}（应为 HH:MM，如 08:30）`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

async function execute(trigger: string): Promise<void> {
  if (running) {
    logger.warn('上一次抓取任务仍在执行，本次触发已跳过');
    return;
  }
  running = true;
  try {
    await runDailyFeed({ trigger });
  } catch (e) {
    logger.error({ err: e, trigger }, '每日抓取任务执行失败');
  } finally {
    running = false;
  }
}

function tick(): void {
  if (!parsed) return;
  const now = partsInTz(new Date(), config.feed.tz);
  if (lastRunDate === now.date) return;

  const due = config.feed.catchUp ? now.time >= parsed.hhmm : now.time === parsed.hhmm;
  if (!due) return;

  // 先落守卫：即便本次执行抛错，也不在同一天反复重试（等待次日）
  lastRunDate = now.date;
  void execute(config.feed.catchUp && now.time !== parsed.hhmm ? 'catch-up' : 'schedule');
}

export function startFeedScheduler(): void {
  if (!config.feed.enabled) {
    logger.info('每日抓取未启用（FEED_ENABLED=false），调度器不启动');
    return;
  }
  try {
    const hhmm = parseTarget();
    parsed = { hhmm };
    logger.info(
      { triggerAt: hhmm, tz: config.feed.tz, catchUp: config.feed.catchUp, pollMs: TICK_MS },
      '每日抓取调度器已启动'
    );
  } catch (e) {
    logger.error({ err: e }, '每日抓取调度器启动失败');
    return;
  }

  timer = setInterval(tick, TICK_MS);
  // 调度器不应阻止进程退出
  if (typeof timer.unref === 'function') timer.unref();
  void initDailyGuard();
}

/**
 * 启动时的当日状态初始化。
 *
 * 守卫不能只存在内存里：进程重启（部署、崩溃恢复）会清空它，配合 catchUp
 * 就会在同一台机器上一天抓多次。这里先从留痕恢复，再决定是否需要补跑。
 */
async function initDailyGuard(): Promise<void> {
  const today = partsInTz(new Date(), config.feed.tz).date;
  try {
    if (await hasRunOnDate(today)) {
      lastRunDate = today;
      logger.info({ date: today }, '检测到当日已有抓取留痕，本进程不再重复执行');
      return;
    }
  } catch (e) {
    logger.warn({ err: e }, '读取当日抓取留痕失败，按未执行处理');
  }

  if (config.feed.runOnStart) {
    logger.info('FEED_RUN_ON_START=true，启动后立即执行一次');
    await execute('startup');
    lastRunDate = today;
    return;
  }
  tick();
}

export function stopFeedScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 调度状态（控制台展示用）。 */
export function schedulerStatus(): {
  enabled: boolean;
  time: string;
  tz: string;
  catchUp: boolean;
  lastRunDate: string;
  running: boolean;
} {
  return {
    enabled: config.feed.enabled,
    time: parsed?.hhmm ?? String(config.feed.time),
    tz: config.feed.tz,
    catchUp: config.feed.catchUp,
    lastRunDate,
    running,
  };
}

/** 仅供测试/管理端强制重置当日守卫（如手动跑完后希望调度再跑一次）。 */
export function resetDailyGuard(): void {
  lastRunDate = '';
}
