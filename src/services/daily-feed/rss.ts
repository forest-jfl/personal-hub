/**
 * 轻量 RSS 2.0 / Atom 解析器（零第三方依赖）。
 *
 * 为什么不引 xml2js / fast-xml-parser：博客源结构高度固定（channel > item，
 * 或 feed > entry），只需按块提取少数字段，正则可控且便于失败时降级；
 * 引入 XML 库反而增加供应链面与体积。
 *
 * 解析失败一律抛错，由上层记为「该源失败」，不影响其他源。
 */

export interface RawFeedItem {
  title: string;
  /** 原文链接（绝对地址） */
  link: string;
  /** 源条目唯一 ID（RSS guid / Atom id），缺失时由上层用 link 兜底 */
  guid: string;
  /** 原始 HTML 摘要（RSS description / Atom summary|content） */
  description: string;
  /** 发布时间原样字符串 */
  pubDate: string;
}

export interface ParsedFeed {
  /** 频道标题（仅用于日志与兜底展示） */
  channelTitle: string;
  /** 解析到的条目数 */
  itemCount: number;
  items: RawFeedItem[];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', copy: '©',
  reg: '®', trade: '™', deg: '°', bull: '•', euro: '€', pound: '£', yen: '¥',
};

/** 解码 XML/HTML 实体：命名实体 + 十进制 + 十六进制。 */
export function decodeEntities(input: string): string {
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

function safeFromCodePoint(code: number): string {
  if (code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** 去掉 CDATA 包裹。 */
function unwrapCdata(s: string): string {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? m[1] : s;
}

/** 取第一个匹配标签的文本内容（兼容 CDATA，属性无关）。 */
function tagText(block: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return '';
  return decodeEntities(unwrapCdata(m[1])).trim();
}

/** 取自闭合/带属性标签的某个属性值，如 Atom 的 <link href="..."/>。 */
function tagAttr(block: string, tag: string, attr: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b([^>]*)\\/?>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const a = new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(m[1]);
    if (a) out.push(decodeEntities(a[2] ?? a[3] ?? '').trim());
  }
  return out;
}

/** 相对链接补全为绝对地址。 */
export function absolutize(href: string, base: string): string {
  const h = String(href || '').trim();
  if (!h) return '';
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('//')) return 'https:' + h;
  if (h.startsWith('/')) {
    try {
      return new URL(h, base).toString();
    } catch {
      return h;
    }
  }
  try {
    return new URL(h, base).toString();
  } catch {
    return h;
  }
}

/**
 * 解析 feed 文本。
 * @param xml  原始 XML
 * @param base 站点首页，用于补全相对链接
 */
export function parseFeed(xml: string, base = ''): ParsedFeed {
  const text = String(xml || '');
  if (!/<(rss|feed|rdf:RDF)\b/i.test(text)) {
    throw new Error('内容不是合法的 RSS/Atom 文档（未找到 rss/feed 根节点）');
  }

  const channelTitle = tagText(text, 'title');

  // RSS 2.0 / RDF 用 <item>，Atom 用 <entry>
  const isAtom = /<feed\b/i.test(text) && !/<rss\b/i.test(text);
  const blockTag = isAtom ? 'entry' : 'item';
  const blocks: string[] = [];
  const blockRe = new RegExp(`<${blockTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${blockTag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) blocks.push(m[1]);

  const items: RawFeedItem[] = blocks.map((block) => {
    const title = tagText(block, 'title');

    // 链接：Atom 优先 rel="alternate"，RSS 取 <link> 文本
    let link = '';
    if (isAtom) {
      const hrefs = tagAttr(block, 'link', 'href');
      const rels = tagAttr(block, 'link', 'rel');
      const altIdx = rels.findIndex((r) => !r || r === 'alternate');
      link = hrefs[altIdx >= 0 ? altIdx : 0] || hrefs[0] || '';
      if (!link) link = tagText(block, 'link');
    } else {
      link = tagText(block, 'link');
      if (!link) link = tagAttr(block, 'link', 'href')[0] || '';
      // RSS 偶见 <link/> 空值，退回 guid 中的 URL
      if (!link) {
        const g = tagText(block, 'guid');
        if (/^https?:\/\//i.test(g)) link = g;
      }
    }

    const guid = tagText(block, 'guid') || tagText(block, 'id') || link;

    // 摘要：优先 content:encoded / content，其次 description / summary
    const description =
      tagText(block, 'content:encoded') ||
      tagText(block, 'content') ||
      tagText(block, 'description') ||
      tagText(block, 'summary') ||
      '';

    const pubDate =
      tagText(block, 'pubDate') ||
      tagText(block, 'published') ||
      tagText(block, 'updated') ||
      tagText(block, 'dc:date') ||
      '';

    return {
      title: title.replace(/\s+/g, ' ').trim(),
      link: absolutize(link, base),
      guid: guid.trim(),
      description,
      pubDate: pubDate.trim(),
    };
  });

  const usable = items.filter((it) => it.title || it.link);
  return { channelTitle, itemCount: items.length, items: usable };
}
