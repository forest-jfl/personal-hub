/**
 * 本地预览服务 —— 静态页 + 与真实接口**同形**的 mock API。
 *
 * 用途：改样式时不必起数据库与整套后端，就能在真浏览器里看六个页面的实际渲染。
 * 它只服务 `public/` 与四个只读接口，不发任何写请求、不连数据库。
 *
 * 为什么是 mock 而不是直接连本地库：
 *   样式改动的风险面是「选择器没覆盖到 / 内联样式盖住了暗色主题」，
 *   与后端行为无关。用固定 fixture 反而更确定 —— 每次都渲染同一份内容，
 *   改样式前后的截图可以直接对比。真实链路由部署后的线上验收覆盖。
 *
 * 接口返回结构照抄 `src/routes/public.ts` 与 `post.repo.ts::getBlogMeta`，
 * 改动后端时若这里对不上，页面会立刻露馅（这是一种刻意的耦合）。
 *
 * 用法：
 *   node scripts/preview-mock.mjs          # http://127.0.0.1:3210
 *   MOCK_PORT=4000 node scripts/preview-mock.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.MOCK_PORT || 3210);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/* ── fixture ───────────────────────────────────────────────────────────────
   内容刻意写成这个站该有的样子（数据与工具笔记），且**不含任何身份标识与
   领域词** —— 它同样会进公开仓库，没理由在这里留痕迹。 */

const POSTS = [
  {
    id: 1,
    title: '把「能被一条命令验证」当成设计约束',
    slug: 'verify-by-one-command',
    category: '工程习惯',
    views: 412,
    author_name: '半山',
    created_at: '2026-09-12T09:20:00.000Z',
    updated_at: '2026-09-13T02:10:00.000Z',
    source: null,
    source_name: null,
    source_url: null,
    fetched_at: null,
    content:
      '配置漂移这种事，靠人记住检查周期是注定要失败的。\n\n' +
      '我把「源清单 → 生成产物 → 校验是否漂移」做成一条命令，问题就从「记得检查」变成「跑不过就发不出去」。',
  },
  {
    id: 2,
    title: '容器时区差 8 小时，而且不报错',
    slug: 'container-timezone-silent-bug',
    category: '踩坑记录',
    views: 356,
    author_name: '半山',
    created_at: '2026-09-10T01:05:00.000Z',
    updated_at: '2026-09-10T01:05:00.000Z',
    source: null,
    source_name: null,
    source_url: null,
    fetched_at: null,
    content:
      '应用容器与数据库容器的时区不一致时，`NOW()` 会给出相差 8 小时的结果 —— 而且不抛任何错误。\n\n' +
      '在北京时间 00:00 到 08:00 之间，日期会整整差一天。这类 bug 只在特定时段复现，最难查。',
  },
  {
    id: 3,
    title: '单文件 bind mount 的 reload 会静默失效',
    slug: 'bind-mount-inode-trap',
    category: '踩坑记录',
    views: 289,
    author_name: '半山',
    created_at: '2026-09-08T11:30:00.000Z',
    updated_at: '2026-09-08T11:30:00.000Z',
    source: null,
    source_name: null,
    source_url: null,
    fetched_at: null,
    content:
      '用 `mv` 或重定向替换一个被 bind mount 的单文件，宿主机上内容确实变了，但容器里读到的还是旧 inode。\n\n' +
      '`reload` 会报告成功，接口却毫无变化。只能原地 `cp` 覆盖，保住 inode。',
  },
  {
    id: 4,
    title: '零构建前端不是怀旧，是止损',
    slug: 'zero-build-is-not-nostalgia',
    category: '工程习惯',
    views: 233,
    author_name: '半山',
    created_at: '2026-09-04T06:40:00.000Z',
    updated_at: '2026-09-04T06:40:00.000Z',
    source: null,
    source_name: null,
    source_url: null,
    fetched_at: null,
    content:
      '工具链会腐化：依赖升级、插件废弃、构建配置需要迁移。一个三年没人动的静态站，最怕的就是「想改一个字，得先把构建跑起来」。',
  },
  {
    id: 5,
    title: '为什么我给抓取任务留了待审态',
    slug: 'why-drafts-before-publish',
    category: '产品取舍',
    views: 178,
    author_name: '半山',
    created_at: '2026-09-01T03:15:00.000Z',
    updated_at: '2026-09-01T03:15:00.000Z',
    source: null,
    source_name: null,
    source_url: null,
    fetched_at: null,
    content:
      '自动抓回来的内容质量参差，直接发布等于把站点变成一个转发号。\n\n' +
      '留一道人工确认，成本很低，但它决定了这个站还是不是「我写的」。',
  },
  {
    id: 6,
    title: '增量同步里最难的不是增量',
    slug: 'incremental-sync-hard-part',
    category: '数据工程',
    views: 154,
    author_name: '半山',
    created_at: '2026-08-28T08:00:00.000Z',
    updated_at: '2026-08-28T08:00:00.000Z',
    source: null,
    source_name: null,
    source_url: null,
    fetched_at: null,
    content: '增量本身很简单，难的是历史补齐与去重口径 —— 补历史时如果按增量口径走，会漏掉已被修订的记录。',
  },
];

/* 封面 fixture：故意一半有一半没有 —— 列表卡片「有封面 / 无封面」两种版式
   都要被渲染到，只测一种等于另一种没有门禁。
   做成映射而不是逐条写进 POSTS：新增封面只改这里，不用去动上面六个对象。
   地址必须用本站图床形态（/api/public/files/<id>/<16~64 位十六进制>），
   前端 safeCover 会照这个形状校验，随手写 'cover1.png' 会被静默判为「无封面」。 */
const COVERS = {
  'verify-by-one-command': '/api/public/files/11/1a2b3c4d5e6f7a8b1a2b3c4d5e6f7a8b',
  'container-timezone-silent-bug': '/api/public/files/12/2a3b4c5d6e7f8a9b2a3b4c5d6e7f8a9b',
  'why-drafts-before-publish': '/api/public/files/13/3a4b5c6d7e8f9a0b3a4b5c6d7e8f9a0b',
};
for (const p of POSTS) p.cover = COVERS[p.slug] || '';

const DAILY = [
  {
    id: 101,
    title: '一篇值得一读的离线优先架构实践',
    slug: 'daily-offline-first-architecture',
    source: 'daily',
    source_name: '示例来源 A',
    source_url: 'https://example.com/a',
    created_at: '2026-09-15T00:35:00.000Z',
  },
  {
    id: 102,
    title: 'SQLite 在高并发读场景下的表现实测',
    slug: 'daily-sqlite-concurrent-read',
    source: 'daily',
    source_name: '示例来源 B',
    source_url: 'https://example.com/b',
    created_at: '2026-09-15T00:32:00.000Z',
  },
  {
    id: 103,
    title: '关于「不要过早抽象」的一段反方意见',
    slug: 'daily-against-early-abstraction',
    source: 'daily',
    source_name: '示例来源 C',
    source_url: 'https://example.com/c',
    created_at: '2026-09-15T00:30:00.000Z',
  },
];

/* 已登录态用的固定身份。同样不含任何真实身份信息 —— 它就是「半山」。 */
const ME = {
  id: 1,
  username: 'banshan',
  display_name: '半山',
  role: 'admin',
  status: 'active',
  created_at: '2026-08-01T00:00:00.000Z',
};

const FILES = {
  used: 3 * 1048576 + 512 * 1024,
  quota: 512 * 1048576,
  maxFileSize: 20 * 1048576,
  files: [
    { id: 1, original_name: 'architecture-notes.pdf', mime: 'application/pdf', size: 812345, owner_id: 1, owner_name: '半山', created_at: '2026-09-12T02:00:00.000Z', public_token: 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8' },
    { id: 2, original_name: 'screenshot-desktop.png', mime: 'image/png', size: 421000, owner_id: 1, owner_name: '半山', created_at: '2026-09-10T06:30:00.000Z', public_token: 'b2c3d4e5f6a7b8c9b2c3d4e5f6a7b8c9' },
    { id: 3, original_name: 'schema-dump.sql', mime: 'text/plain', size: 15400, owner_id: 1, owner_name: '半山', created_at: '2026-09-04T09:15:00.000Z', public_token: 'c3d4e5f6a7b8c9d0c3d4e5f6a7b8c9d0' },
  ],
};

/* 图片库 fixture：真实接口按 mime LIKE 'image/%' 过滤，这里照同一口径给三条。
   id 与 COVERS 里的 id 保持一致，于是「文章封面」在图片库里能找到同一张图，
   图片库的「该图正被 N 篇文章用作封面」提示也就有了可测的数据。 */
const IMAGES = [
  { id: 11, original_name: 'gradient-dawn.png', mime: 'image/png', size: 384210, owner_id: 1, owner_name: '半山', created_at: '2026-09-13T02:20:00.000Z', public_token: '1a2b3c4d5e6f7a8b1a2b3c4d5e6f7a8b' },
  { id: 12, original_name: 'dashboard-dark.png', mime: 'image/png', size: 262144, owner_id: 1, owner_name: '半山', created_at: '2026-09-11T07:45:00.000Z', public_token: '2a3b4c5d6e7f8a9b2a3b4c5d6e7f8a9b' },
  { id: 13, original_name: 'pipeline-sketch.webp', mime: 'image/webp', size: 133700, owner_id: 1, owner_name: '半山', created_at: '2026-09-06T03:10:00.000Z', public_token: '3a4b5c6d7e8f9a0b3a4b5c6d7e8f9a0b' },
];

/* 占位图：真实服务会把上传的原图原样吐回来，mock 手上没有图片文件。
   与其让每张图都 404（页面上是一排破图，看不出「有封面时版式对不对」），
   不如按 id 现生成一张 SVG —— 卡片缩略图、文章头图、图片库网格三处
   就都能看到真实的版式效果。 */
const IMAGE_LABELS = {};
for (const f of IMAGES) IMAGE_LABELS[f.id] = f.original_name;

function xmlEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

function placeholderSvg(id) {
  const label = xmlEsc(IMAGE_LABELS[Number(id)] || 'file #' + id);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#241b38"/><stop offset="1" stop-color="#4a3b6b"/>
  </linearGradient></defs>
  <rect width="640" height="400" fill="url(#g)"/>
  <text x="40" y="196" fill="#d8cff0" font-family="monospace" font-size="28">${label}</text>
  <text x="40" y="236" fill="#9c8fc4" font-family="monospace" font-size="20">mock placeholder</text>
</svg>`;
}

const USERS = [
  ME,
  { id: 2, username: 'reader', display_name: '读者', role: 'user', status: 'active', created_at: '2026-08-20T00:00:00.000Z' },
  { id: 3, username: 'guest', display_name: '访客', role: 'user', status: 'disabled', created_at: '2026-08-25T00:00:00.000Z' },
];

const FEED_STATUS = {
  scheduler: { enabled: true, time: '08:30', tz: 'Asia/Shanghai', lastRunDate: '2026-09-15' },
  counts: { pending: 4, published: 11 },
  activeSources: [
    { name: '示例来源 A', url: 'https://example.com/a', category: '工程' },
    { name: '示例来源 B', url: 'https://example.com/b', category: '数据' },
  ],
  lastRun: {
    runId: '20260915-0830', finishedAt: '2026-09-15 08:31:07', trigger: 'schedule',
    totals: { created: 3, updated: 1, skipped: 6, failedSources: 0 },
  },
  lastRunRestoredFrom: 'db',
  recentLogs: [
    { created_at: '2026-09-15T00:31:07.000Z', source: 'a', source_name: '示例来源 A', ok: true, items_found: 8, items_new: 3, items_upd: 1, items_skip: 4, duration_ms: 812, error: '' },
    { created_at: '2026-09-15T00:31:05.000Z', source: 'b', source_name: '示例来源 B', ok: false, items_found: 0, items_new: 0, items_upd: 0, items_skip: 0, duration_ms: 1900, error: 'ETIMEDOUT: 上游响应超时' },
  ],
};

/** 文章详情页用的正文：刻意把该有的元素都放进去，好一次验完暗色下的排版。 */
const POST_HTML = `
<p>这篇把上一篇的做法补完。先说结论：<strong>能被一条命令验证的东西，就不要靠人去记</strong>。</p>
<p><img src="/api/public/files/11/1a2b3c4d5e6f7a8b1a2b3c4d5e6f7a8b" alt="整条链路的示意草图"></p>
<h2>为什么是命令，而不是检查清单</h2>
<p>清单的问题在于它没有执行者。写下来之后，它只会安静地过期。</p>
<blockquote>一条会失败的检查，胜过十条从不执行的规范。</blockquote>
<h2>三个具体的做法</h2>
<ol>
  <li>源清单只保留一份，其余产物由它生成</li>
  <li>生成之后立刻反向校验，报告漂移</li>
  <li>把校验挂进发布流程，跑不过就不许发</li>
</ol>
<h3>代码示例</h3>
<pre><code>python gen-configs.py --check
# 期望：四份产物与源清单完全一致</code></pre>
<p>行内代码长这样：<code>docker compose up -d</code>，注意它在暗色下的底色。</p>
<h3>对照表</h3>
<table>
  <thead><tr><th>做法</th><th>成本</th><th>失效方式</th></tr></thead>
  <tbody>
    <tr><td>人工检查</td><td>低</td><td>忘记执行</td></tr>
    <tr><td>脚本校验</td><td>中</td><td>无人运行</td></tr>
    <tr><td>挂进发布流程</td><td>中</td><td>几乎不失效</td></tr>
  </tbody>
</table>
<p>参考链接：<a href="https://example.com/ref" target="_blank" rel="noopener">一份同主题的讨论</a>。</p>
`;

/* ── 路由 ─────────────────────────────────────────────────────────────────── */

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function listPosts(url) {
  const q = url.searchParams;
  const page = Number(q.get('page') || 1);
  const pageSize = Number(q.get('pageSize') || 10);
  const category = (q.get('category') || '').trim();
  const kw = (q.get('q') || '').trim();
  let rows = POSTS;
  if (category) rows = rows.filter((p) => p.category === category);
  if (kw) rows = rows.filter((p) => p.title.includes(kw));
  const start = (page - 1) * pageSize;
  return {
    posts: rows.slice(start, start + pageSize).map((p) => ({
      ...p,
      summary: p.content.replace(/\s+/g, ' ').trim().slice(0, 120),
    })),
    total: rows.length,
    page,
    pageSize,
  };
}

/**
 * 建一个 mock 服务实例（不监听）。
 *
 * 导出成工厂是给 `verify-ui.mjs` 用的：验收脚本**自带静态服务**，
 * 不依赖外部先起一个进程 —— 后台进程会随发起它的 shell 一起退出，
 * 结果是「服务早就没了，验收自然超时」，而看起来像页面 bug。
 */
export function createMockServer() {
  return http.createServer(handle);
}

function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname;

  if (p === '/api/public/posts') return json(res, 200, listPosts(url));
  if (p === '/api/public/daily') {
    return json(res, 200, { date: '2026-09-15', tz: 'Asia/Shanghai', count: DAILY.length, posts: DAILY });
  }
  if (p === '/api/public/meta') {
    const cats = {};
    const arch = {};
    for (const post of POSTS) {
      cats[post.category] = (cats[post.category] || 0) + 1;
      const m = post.created_at.slice(0, 7);
      arch[m] = (arch[m] || 0) + 1;
    }
    return json(res, 200, {
      categories: Object.entries(cats).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      archive: Object.keys(arch).sort().reverse().map((month) => ({ month, count: arch[month] })),
      hot: [...POSTS].sort((a, b) => b.views - a.views).slice(0, 5)
        .map((x) => ({ title: x.title, slug: x.slug, views: x.views })),
    });
  }
  /* 图床地址：真实路由是 GET /api/public/files/:id/:token（无需登录）。
     mock 不校验 token —— 它只负责让页面上的图有东西可显示。 */
  if (p.startsWith('/api/public/files/')) {
    const id = p.split('/')[4] || '0';
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(placeholderSvg(id));
  }
  if (p.startsWith('/api/public/posts/')) {
    const slug = decodeURIComponent(p.slice('/api/public/posts/'.length));
    const post = POSTS.find((x) => x.slug === slug) || POSTS.find((x) => x.slug === DAILY[0].slug);
    if (!post) return json(res, 404, { error: 'POST_NOT_FOUND' });
    return json(res, 200, { post: { ...post, html: POST_HTML } });
  }
  /* ── 登录态 ───────────────────────────────────────────────────────────────
     /console 与 /editor 的真实行为是「未登录即跳 /login」（api.js::requireMe）。
     要检查这两页的**视觉**，mock 就得认得出「已登录」。
     用 cookie 而不是给接口加开关：cookie 本来就是真实的会话载体，
     验收脚本在页面里写一次 document.cookie 就能切态，不用改导航参数。

     刻意偏差：mock 不校验任何凭据。它只服务视觉检查；
     鉴权与越权由 scripts/test_console.py 与线上验收覆盖，不在这里测。 */
  const authed = /(?:^|;\s*)mock_auth=1(?:;|$)/.test(req.headers.cookie || '');

  // 未登录：让首页顶栏渲染「登录」按钮而不是用户菜单
  if (p === '/api/auth/me') {
    return authed ? json(res, 200, { user: ME }) : json(res, 401, { error: 'UNAUTHORIZED' });
  }
  if (authed) {
    if (p === '/api/posts') {
      return json(res, 200, {
        posts: POSTS.map((x, i) => ({
          id: x.id, title: x.title, slug: x.slug, category: x.category,
          status: i === 2 ? 'draft' : 'published', views: x.views,
          cover: x.cover || '',
          source: x.source, source_name: x.source_name, source_url: x.source_url,
          created_at: x.created_at, updated_at: x.updated_at,
        })),
        total: POSTS.length, page: 1, pageSize: 10,
      });
    }
    if (p === '/api/files/images') {
      const limit = Math.min(200, Number(url.searchParams.get('limit') || 60));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      return json(res, 200, {
        images: IMAGES.slice(offset, offset + limit),
        total: IMAGES.length, limit, offset,
      });
    }
    if (p === '/api/files') return json(res, 200, FILES);
    if (p === '/api/users') return json(res, 200, { users: USERS });
    if (p === '/api/feed/status') return json(res, 200, FEED_STATUS);
  }

  /* ── 页面路由：必须与真实服务一致（src/app.ts 用的是无扩展名的净路径）──
     真实服务里 /login /post /console /editor 各自 sendFile 对应的 .html。
     若这里只按「文件路径」服务，前端的 `location.href = '/login'` 会撞上 404
     ——页面变成一行 404 文本，验收脚本就在等服务超时，看着像页面 bug。

     刻意偏差：真实服务的 /console 与 /editor 需要登录，未登录会跳 /login。
     mock 里直接放行，因为这两个页面的**视觉**正是要检查的对象；
     鉴权链路由 scripts/test_console.py 与线上验收覆盖，不在这里测。 */
  const PAGE_ROUTES = {
    '/': '/index.html',
    '/post': '/post.html',
    '/login': '/login.html',
    '/console': '/console.html',
    '/editor': '/editor.html',
    '/gallery': '/gallery.html',
  };
  if (PAGE_ROUTES[p]) return serveFile(res, PAGE_ROUTES[p]);

  // 静态资源
  return serveFile(res, p);
}

function serveFile(res, file) {
  const abs = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* 直接运行时才监听；被 import 时只暴露工厂。 */
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  createMockServer().listen(PORT, '127.0.0.1', () => {
    console.log(`预览服务已启动（mock API）：http://127.0.0.1:${PORT}/`);
    console.log('页面：/  ·  /post.html?slug=verify-by-one-command  ·  /login.html  ·  /console.html  ·  /editor.html  ·  /gallery.html');
  });
}
