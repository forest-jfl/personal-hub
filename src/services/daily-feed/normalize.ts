import crypto from 'crypto';
import sanitizeHtml from 'sanitize-html';
import { decodeEntities } from './rss';

/**
 * 规范化层：把源条目的 HTML 摘要转成干净的 Markdown 摘录，并生成入库所需的
 * slug / 指纹 / 去重键。
 *
 * 合规约束（重要）：只摘录原文导语，不全文转载；每条正文强制附来源署名与原文链接。
 * 因此这里对摘录长度做硬截断（默认 420 字），且不保留 img 等富媒体。
 */

export interface NormalizeOptions {
  /** 摘录最大字符数 */
  excerptChars: number;
}

/** Markdown 特殊字符转义（仅处理会破坏结构的字符，保留中文标点）。 */
function escapeMd(s: string): string {
  return s.replace(/([\\*_[\]`])/g, '\\$1');
}

/**
 * HTML → 简化 Markdown。
 * 白名单极为保守：只保留段落/链接/强调，丢弃 script/style/img 等一切富媒体。
 */
export function htmlToMarkdown(html: string, base = ''): string {
  if (!html) return '';
  const hasTag = /<[a-z][\s\S]*>/i.test(html);
  if (!hasTag) return decodeEntities(html).trim();

  const clean = sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'a', 'strong', 'b', 'em', 'i', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'h5', 'h6'],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https'],
    transformTags: { b: 'strong', i: 'em' },
  });

  let md = clean
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<h[2-6][^>]*>/gi, '\n\n#### ')
    .replace(/<\/h[2-6]\s*>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '')
    .replace(/<ul[^>]*>|<\/ul\s*>|<ol[^>]*>|<\/ol\s*>/gi, '\n')
    .replace(/<strong[^>]*>|<\/strong\s*>/gi, '**')
    .replace(/<em[^>]*>|<\/em\s*>/gi, '*')
    .replace(/<code[^>]*>|<\/code\s*>/gi, '`')
    .replace(/<blockquote[^>]*>|<\/blockquote\s*>/gi, '\n')
    .replace(/<pre[^>]*>|<\/pre\s*>/gi, '\n');

  // 链接：保留为绝对地址的 markdown 链接，相对地址用 base 补全
  md = md.replace(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_w, _q, dq, sq, text) => {
    const href = String(dq ?? sq ?? '').trim();
    const label = String(text || '').replace(/<[^>]+>/g, '').trim();
    if (!href || !label) return label;
    let abs = href;
    if (!/^https?:\/\//i.test(abs) && base) {
      try {
        abs = new URL(abs, base).toString();
      } catch {
        /* 保留原值 */
      }
    }
    if (!/^https?:\/\//i.test(abs)) return label;
    return `[${escapeMd(label)}](${abs})`;
  });

  md = md
    .replace(/<[^>]+>/g, '') // 剩余标签
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  return decodeEntities(md).trim();
}

/** 从文本里剔除 markdown 结构符，得到用于摘要/去重的纯文本。 */
export function toPlainText(md: string): string {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 按句子/段落边界截断，避免出现半截词。 */
export function truncateAtBoundary(text: string, maxChars: number): string {
  const t = String(text || '').trim();
  if (t.length <= maxChars) return t;
  const slice = t.slice(0, maxChars);
  const cut = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('；'),
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? ')
  );
  const kept = cut >= Math.floor(maxChars * 0.5) ? slice.slice(0, cut + 1) : slice;
  return kept.replace(/[\s，,、;；:：]+$/, '') + '…';
}

/**
 * 源站样板尾词：RSS description 常以「查看全文」「Read more」等行动号召结尾，
 * 直接摘录会带入噪音，需在截断前后各清一次。
 */
const BOILERPLATE_TAIL = [
  /(?:查看|阅读|点击查看|点击阅读|继续阅读|浏览)?(?:全文|原文|更多)\.?$/,
  /(?:阅读|查看)\s*more\.?$/i,
  /read\s*more\.?$/i,
  /continue\s*reading\.?$/i,
  /the\s+post\s+.*?\s+appeared\s+first\s+on\s+.*?\.?$/i,
  /^\s*原文(?:标题)?[:：]\s*/,
];

/** 反复剥离尾部的样板词，直到不再变化（可能叠加「…阅读全文 查看全文」）。 */
export function stripBoilerplate(text: string): string {
  let out = String(text || '').trim();
  for (let i = 0; i < 4; i++) {
    const before = out;
    for (const re of BOILERPLATE_TAIL) out = out.replace(re, '').trim();
    out = out.replace(/[\s，,、;；:：。.!！?？\-—]+$/, '').trim();
    if (out === before) break;
  }
  return out;
}

/** 生成入库摘要（Markdown 片段）。 */
export function makeExcerpt(html: string, sourceHomepage: string, opts: NormalizeOptions): string {
  const md = htmlToMarkdown(html, sourceHomepage);
  const body = (md.includes('\n') ? md : toPlainText(md)).replace(/\n{3,}/g, '\n\n').trim();
  const cleaned = stripBoilerplate(body);
  // 截断可能正好切在样板词中间（如「查看全」），故截断后再清一次
  return stripBoilerplate(truncateAtBoundary(cleaned, opts.excerptChars));
}

/** 标题 → URL 友好片段：保留中文与字母数字。 */
export function slugifyTitle(title: string, maxLen = 40): string {
  const s = String(title || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return s || 'item';
}

/**
 * 生成稳定且可读的 slug。
 * 稳定来自 guid 的 md5 前缀：同一源条目在任何一天重跑都得到同一 slug，
 * 从而与 uk_slug 唯一键配合，二次运行不会产生新记录。
 */
export function buildSlug(sourceId: string, guid: string, title: string): string {
  const h = crypto.createHash('md5').update(String(guid)).digest('hex').slice(0, 8);
  return `${sourceId}-${h}-${slugifyTitle(title)}`.slice(0, 255);
}

/** 正文指纹（用于「更新判断」：内容变了才写库）。 */
export function contentHash(input: string): string {
  return crypto.createHash('md5').update(String(input)).digest('hex');
}

/** 标题归一化：仅保留中英文与数字，用于跨源软去重比对。 */
export function normalizeTitleKey(title: string): string {
  return String(title || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '');
}

export interface BuildContentInput {
  title: string;
  sourceName: string;
  sourceHomepage: string;
  sourceUrl: string;
  excerpt: string;
  fetchedAtText: string;
}

/** 组装落库正文：署名区 + 摘录 + 声明区。 */
export function buildPostContent(input: BuildContentInput): string {
  const excerpt = input.excerpt || '（源站未提供摘要，请点击原文链接阅读。）';
  return [
    `> **来源**：${input.sourceName}（[${hostOf(input.sourceHomepage)}](${input.sourceHomepage})）  `,
    `> **原文**：[${input.title}](${input.sourceUrl})  `,
    `> **抓取时间**：${input.fetchedAtText}`,
    '',
    excerpt,
    '',
    '---',
    '',
    `*本条由「每日抓取」任务自动整理，仅摘录原文导语，完整内容与版权归原作者所有，请点击上方原文链接阅读全文。*`,
  ].join('\n');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
