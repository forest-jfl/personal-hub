import { logger } from '../../utils/logger';

/**
 * 抓取层：带超时、UA 与有限重试的文本抓取。
 *
 * 依赖 Node 内置全局 fetch（undici），其自动处理 gzip/br/deflate 解压，
 * 无需手工 zlib。节流与重试均为「少而稳」策略，避免给源站压力。
 */

export interface FetchOptions {
  timeoutMs: number;
  retries: number;
  userAgent: string;
  /** 两次重试之间的基础退避（毫秒），实际间隔 = base * attempt */
  backoffMs?: number;
}

export interface FetchResult {
  /** 响应文本 */
  text: string;
  /** 最终 URL（可能因重定向变化） */
  finalUrl: string;
  status: number;
  /** 实际耗时 */
  durationMs: number;
  /** 实际尝试次数（含首次） */
  attempts: number;
}

const DEFAULT_BACKOFF = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 抓取文本资源。失败（网络错误 / 5xx / 429 / 超时）按 retries 重试，
 * 4xx（除 429）视为确定性失败，立即抛出不再重试。
 */
export async function fetchText(url: string, opts: FetchOptions): Promise<FetchResult> {
  const maxAttempts = Math.max(1, opts.retries + 1);
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
  const started = Date.now();
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': opts.userAgent,
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });

      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        const err = new Error(`HTTP ${res.status} ${res.statusText}`);
        if (!retryable) throw Object.assign(err, { fatal: true });
        lastErr = err;
        logger.warn({ url, attempt, status: res.status }, '抓取失败（可重试）');
      } else {
        const text = await res.text();
        return {
          text,
          finalUrl: res.url || url,
          status: res.status,
          durationMs: Date.now() - started,
          attempts: attempt,
        };
      }
    } catch (e) {
      lastErr = e;
      const fatal = (e as { fatal?: boolean })?.fatal === true;
      if (fatal) throw e;
      logger.warn({ url, attempt, err: e }, '抓取异常（可重试）');
    } finally {
      clearTimeout(timer);
    }

    if (attempt < maxAttempts) await sleep(backoff * attempt);
  }

  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`抓取 ${url} 失败（已尝试 ${maxAttempts} 次）：${reason}`);
}
