import { logger } from '../../utils/logger';
import { fetchText } from './fetcher';
import { decodeEntities } from './rss';
import { htmlToMarkdown, stripBoilerplate, toPlainText, truncateAtBoundary } from './normalize';

/**
 * 原文页导语回退提取。
 *
 * 存在的理由：部分源站的 RSS description 只放推广文案（如「下载客户端、关注公众号」），
 * 直接摘录会产出无意义的正文。此时改为请求原文页，取 og:description / meta description
 * 作为导语——这是绝大多数站点存放真实摘要的地方。
 *
 * 成本控制：仅在 RSS 摘要被判定为低质时才触发，每源每日最多 maxItems 次额外请求。
 */

/** 低质摘要特征：推广文案、过短、无实际信息。 */
const PROMO_PATTERNS: RegExp[] = [
  /(下载|安装).{0,10}(客户端|app|应用)/i,
  /关注.{0,10}(公众号|微博|微信|我们)/,
  /(解锁|体验).{0,12}(阅读|全新)/,
  /(扫码|长按|识别).{0,8}(二维码|图片)/,
  /^>\s*(实用|好用)/,
  /订阅我们|加入我们|点击关注/,
];

/** 判定 RSS 摘要是否为低质内容（推广 / 过短 / 纯符号）。 */
export function isLowQualityExcerpt(text: string): boolean {
  const t = String(text || '').trim();
  if (t.length < 24) return true;
  // 去掉标点与表情后几乎没内容（如仅剩「📰>实用」）
  const meaningful = t.replace(/[\s\p{P}\p{S}]/gu, '');
  if (meaningful.length < 18) return true;
  return PROMO_PATTERNS.some((re) => re.test(t));
}

function metaContent(html: string, patterns: RegExp[]): string {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1]) {
      const v = decodeEntities(m[1]).trim();
      if (v) return v;
    }
  }
  return '';
}

/**
 * 抓取原文页并提取描述。
 * @returns 清洗后的纯文本导语；提取失败返回空串（调用方需自行兜底）
 */
export async function fetchOgDescription(
  url: string,
  opts: { timeoutMs: number; userAgent: string }
): Promise<string> {
  try {
    const res = await fetchText(url, {
      // 回退路径不应拖慢整体：超时取配置值的一半，且不重试
      timeoutMs: Math.max(4000, Math.round(opts.timeoutMs * 0.6)),
      retries: 0,
      userAgent: opts.userAgent,
    });
    const html = res.text.slice(0, 400_000); // 只解析头部，避免大页面拖慢

    const desc =
      metaContent(html, [
        /<meta[^>]+property\s*=\s*["']og:description["'][^>]+content\s*=\s*["']([^"']*)["']/i,
        /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]+property\s*=\s*["']og:description["']/i,
        /<meta[^>]+name\s*=\s*["']twitter:description["'][^>]+content\s*=\s*["']([^"']*)["']/i,
        /<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']*)["']/i,
        /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]+name\s*=\s*["']description["']/i,
      ]) || metaContent(html, [/<meta[^>]+property\s*=\s*["']og:description["'][^>]+content\s*=\s*([^\s>]+)/i]);

    if (!desc) return '';
    const plain = toPlainText(htmlToMarkdown(desc)).trim() || stripBoilerplate(desc);
    return stripBoilerplate(plain);
  } catch (e) {
    logger.debug({ url, err: (e as Error).message }, '原文页导语提取失败，回退占位文本');
    return '';
  }
}

/** 组装最终摘要：优先 RSS 摘要，低质时回退原文 og:description，仍无则给明确占位。 */
export async function resolveExcerpt(
  rssExcerpt: string,
  sourceUrl: string,
  opts: { excerptChars: number; timeoutMs: number; userAgent: string; fetchOg: boolean }
): Promise<{ text: string; via: 'rss' | 'og' | 'none'; attemptedOg: boolean }> {
  const cleaned = stripBoilerplate(rssExcerpt);
  if (cleaned && !isLowQualityExcerpt(cleaned)) {
    return { text: truncateAtBoundary(cleaned, opts.excerptChars), via: 'rss', attemptedOg: false };
  }
  if (opts.fetchOg && sourceUrl) {
    const og = await fetchOgDescription(sourceUrl, opts);
    if (og && !isLowQualityExcerpt(og)) {
      return { text: truncateAtBoundary(og, opts.excerptChars), via: 'og', attemptedOg: true };
    }
    return { text: '', via: 'none', attemptedOg: true };
  }
  return { text: '', via: 'none', attemptedOg: false };
}
