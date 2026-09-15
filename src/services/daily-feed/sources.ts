/**
 * 每日抓取的来源清单（RSS 2.0 / Atom）。
 *
 * 选源原则：
 *  1. 服务器位于国内（阿里云），优先国内直连稳定的源，避免抓取超时；
 *  2. 内容类型需能映射到博客既有分类（资讯 / 技术 / 生活）；
 *  3. 只摘录导语 + 原文链接，不全文转载（见 normalize.ts 的免责声明）。
 *
 * 实测记录（2026-09-15，本机直连验证）：
 *  - sspai  少数派      https://sspai.com/feed           RSS 2.0，正常 ✓
 *  - ithome IT之家      https://www.ithome.com/rss/      RSS 2.0，正常 ✓
 *  - oschina 开源中国   https://www.oschina.net/news/rss RSS 2.0，正常 ✓
 *  - infoq  InfoQ 中文  https://www.infoq.cn/feed        可访问但内容停留在 2019 年，已停更 ✗
 *  - 36kr   36氪        https://36kr.com/feed            返回 HTML 而非 RSS ✗
 * 说明：失效源保留在清单中（defaultEnabled=false）便于日后复查，不会参与默认调度。
 * 新增源只需在此追加一项，并在 .env 用 FEED_SOURCES 控制启用集合。
 */
export interface FeedSource {
  /** 来源标识：落库到 posts.source，同时作为唯一键前缀 */
  id: string;
  /** 展示名：落库到 posts.source_name，主页徽标上显示 */
  name: string;
  /** RSS/Atom 地址 */
  url: string;
  /** 站点首页（用于正文署名区展示） */
  homepage: string;
  /** 入库分类（对应 posts.category） */
  category: string;
  /** 单次最多入库条数（防止一次性灌入过多待审条目） */
  maxItems?: number;
  /** 是否纳入默认启用集合（FEED_SOURCES 留空时生效） */
  defaultEnabled?: boolean;
  /** 备注：实测状态等，供运维排查时参考 */
  note?: string;
}

export const FEED_SOURCES: FeedSource[] = [
  {
    id: 'sspai',
    name: '少数派',
    url: 'https://sspai.com/feed',
    homepage: 'https://sspai.com',
    category: '资讯',
    maxItems: 6,
    defaultEnabled: true,
  },
  {
    id: 'ithome',
    name: 'IT之家',
    url: 'https://www.ithome.com/rss/',
    homepage: 'https://www.ithome.com',
    category: '资讯',
    maxItems: 6,
    defaultEnabled: true,
  },
  {
    id: 'oschina',
    name: '开源中国',
    url: 'https://www.oschina.net/news/rss',
    homepage: 'https://www.oschina.net',
    category: '技术',
    maxItems: 6,
    defaultEnabled: true,
  },
  {
    id: 'infoq',
    name: 'InfoQ 中文',
    url: 'https://www.infoq.cn/feed',
    homepage: 'https://www.infoq.cn',
    category: '技术',
    maxItems: 6,
    defaultEnabled: false,
    note: 'RSS 长期未更新（实测最新条目为 2019 年），默认不启用',
  },
  {
    id: '36kr',
    name: '36氪',
    url: 'https://36kr.com/feed',
    homepage: 'https://36kr.com',
    category: '资讯',
    maxItems: 4,
    defaultEnabled: false,
    note: '返回 HTML 而非 RSS/Atom，默认不启用',
  },
];

/** 按 FEED_SOURCES 配置筛选来源；配置为空时使用内置默认启用集合。 */
export function resolveSources(idsCsv: string): FeedSource[] {
  const ids = idsCsv
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!ids.length) return FEED_SOURCES.filter((s) => s.defaultEnabled === true);
  return FEED_SOURCES.filter((s) => ids.includes(s.id));
}

export function findSource(id: string): FeedSource | undefined {
  return FEED_SOURCES.find((s) => s.id === id.toLowerCase());
}
