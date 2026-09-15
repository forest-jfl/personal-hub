/**
 * 浏览器级视觉与脱敏验收（半山日志）。
 *
 * 为什么需要这一档：本次改造是整个重写 style.css（274 → 736 行）+ 换品牌名。
 * 「文件里有暗色令牌」≠「页面真的是暗色」——中间隔着三级层叠：
 *   内联 style > 页面内嵌 <style> > 外部样式表
 * 任何一级写了浅色，外部样式表再正确也没用，而 grep 样式表**看不见**这件事。
 * 同理「HTML 里没有真名」≠「屏幕上没有真名」——运行时文本与 DOM 属性是另外两层。
 *
 * 用本机已有的 Chrome/Edge 走 DevTools 协议，零额外依赖。依赖本机浏览器，
 * 因此**不接入 CI**：进了 CI 只会在没有 Chrome 的机器上静默跳过，等于没有门禁。
 *
 * 用法：
 *   node scripts/preview-mock.mjs          # 另开一个终端（127.0.0.1:3210）
 *   node scripts/verify-ui.mjs
 *   TARGET_URL=https://blog.example.com node scripts/verify-ui.mjs   # 验线上那一份
 *
 * 退出码：0 全部通过 / 1 有断言失败 / 3 环境缺浏览器。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.TARGET_URL || 'http://127.0.0.1:3210/').replace(/\/$/, '');
const PORT = Number(process.env.CDP_PORT || 9337);
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const isLocal = BASE.includes('127.0.0.1') || BASE.includes('localhost');

/* 本地模式**自带**静态服务：mock 服务若作为独立后台进程启动，会随发起它的
   shell 一起被回收，验收就变成「等服务超时」——现象像页面 bug，实则服务早没了。
   自己起、自己关，才是可复现的。给了 TARGET_URL 就只做只读验收，不起本地服务。 */
let localServer = null;
if (!process.env.TARGET_URL) {
  const { createMockServer } = await import('./preview-mock.mjs');
  localServer = createMockServer();
  await new Promise((res, rej) => {
    localServer.once('error', rej);
    localServer.listen(Number(new URL(BASE).port || 3210), '127.0.0.1', res);
  });
  console.log(`mock 服务已就绪：${BASE}`);
}

/* 页面清单：用**真实净路径**（src/app.ts 的 /post /login /console /editor），
   不用 .html 后缀 —— 前者才是用户与前端跳转实际走的那条路。
   ready 选择器优先挑静态标记：脚本注入的节点要等 JS，静态节点只需等 HTML。
   content 是函数而非字符串：线上文章数不可控，阈值要按环境给。 */
const PAGES = [
  {
    url: '/', shot: '10-blog-home.png', name: '首页', ready: '.brand, .post-card, .layout-side',
    content: (online) => `(() => { const n = document.querySelectorAll('.post-card').length;
      const need = ${online ? 1 : 3};
      return { ok: n >= need, detail: n + ' 张文章卡片（阈值 ' + need + '）' }; })()`,
  },
  {
    url: '/post?slug=verify-by-one-command', shot: '11-blog-post.png', name: '文章详情',
    ready: '.post-detail, .post-html, .brand',
    content: () => `(() => {
      const el = document.querySelector('.post-html');
      const box = document.getElementById('postBox');
      const len = el ? (el.innerText || '').length : 0;
      // 失败时把容器文本一起报出来：.post-html 由 JS 生成，它不存在基本等于
      // 渲染走了 catch 分支（接口报了错），而报错文案就在 #postBox 里。
      const diag = len ? '' : ' · .post-html 不存在/为空，容器文本="' +
        ((box && box.innerText) || '').trim().replace(/\\s+/g, ' ').slice(0, 90) + '"';
      return { ok: len >= 150, detail: '正文 ' + len + ' 字符' + diag };
    })()`,
  },
  {
    url: '/login', shot: '12-blog-login.png', name: '登录页', ready: '.login-logo',
    content: () => `(() => { const n = document.querySelectorAll('.form-item input').length;
      return { ok: n >= 2, detail: n + ' 个输入框' }; })()`,
  },
  {
    url: '/console', shot: '13-blog-console.png', name: '控制台', ready: '.console-tabs', auth: true,
    content: () => `(() => {
      const rows = document.querySelectorAll('#postsBody tr').length;
      const stats = document.querySelectorAll('#feedStats .feed-stat').length;
      const tabs = document.querySelectorAll('.console-tab:not(.hidden)').length;
      return { ok: rows >= 3 && stats === 4 && tabs >= 4,
        detail: '文章行 ' + rows + ' · 抓取统计 ' + stats + ' · 可见页签 ' + tabs };
    })()`,
  },
  {
    url: '/editor', shot: '14-blog-editor.png', name: '编辑器', ready: '.editor-grid, .md-toolbar', auth: true,
    content: () => `(() => { const panes = document.querySelectorAll('.editor-pane, .preview-pane').length;
      const tb = document.querySelectorAll('.md-toolbar button, .md-toolbar .link-btn').length;
      const cover = !!document.getElementById('coverThumb');
      return { ok: panes >= 2 && tb >= 3 && cover,
        detail: panes + ' 个面板 · ' + tb + ' 个工具栏按钮 · 封面行 ' + (cover ? '在' : '缺失') }; })()`,
  },
  {
    /* 图片库只有登录后才有内容；线上未登录会被拦到 /login，
       那本身就是该被验证的鉴权行为，由主循环的 ONLINE 分支接手。 */
    url: '/gallery', shot: '15-blog-gallery.png', name: '图片库', ready: '.grid-images, .brand', auth: true,
    content: () => `(() => { const n = document.querySelectorAll('.grid-item').length;
      return { ok: n >= 3, detail: n + ' 张图片卡片' }; })()`,
  },
];

/* 脱敏词表：与主页 verify.mjs 保持同一口径。 */
const IDENTITY_TOKENS = [
  '蒋富林', 'Jiang Fulin', 'jiangfulin', '1419658084', 'workalin', 'forest-jfl',
  '反欺诈', '资金流向', '案件', '进项发票', '调单', '龙虎榜', '持仓',
];

/* 已知且**接受的**残留：站点的自有域名。
   用户已决定「先改内容，域名后续再议」，而博客本身就挂在 blog.jiangfulin.com
   上 —— 地址栏里本来就有，页脚再出现一次不构成新增泄漏。
   把它列成白名单而不是删掉断言：删断言等于这条防线以后不再管 href，
   而白名单是显式的、可审的、将来迁域名时能一眼看到要摘掉哪一条。 */
const ALLOWED_DOMAIN_RESIDUALS = ['jiangfulin.com'];

/** 断言前先抹掉白名单里的域名，免得「域名残留」把真正的身份泄漏淹掉。 */
function scrub(s) {
  let out = String(s);
  for (const dom of ALLOWED_DOMAIN_RESIDUALS) out = out.split(dom).join('«本站域名»');
  return out;
}

/* ── 起浏览器 ───────────────────────────────────────────────────────────── */
const CANDIDATES = [
  process.env.CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const exe = CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) { console.error('ENV: 无可用浏览器（可用 CHROME=<路径> 指定）'); process.exit(3); }
console.log(`浏览器：${exe}`);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-blog-'));
const chrome = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--hide-scrollbars', '--force-device-scale-factor=1',
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let version = null;
for (let i = 0; i < 100 && !version; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) version = await r.json(); } catch {}
  if (!version) await sleep(250);
}
if (!version) { console.error('ENV: 浏览器未就绪'); process.exit(3); }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === 'page');

function makeClient(ws, onEvent) {
  let seq = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (onEvent) onEvent(m);
  };
  return (method, params = {}) => new Promise((resolve) => {
    const id = ++seq; pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const ws = await new Promise((res, rej) => {
  const s = new WebSocket(target.webSocketDebuggerUrl);
  s.onopen = () => res(s); s.onerror = rej;
});

/** 当前页面的 JS 异常（每次导航前清空）。 */
let errors = [];
const send = makeClient(ws, (m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  }
  // 只看 JS 异常：401/404 属正常业务路径，按 source 过滤掉，否则门禁永远红
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error'
      && m.params.entry.source === 'javascript') errors.push(m.params.entry.text);
});
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');

async function evaluate(expr) {
  const r = await send('Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
  return r.result?.result?.value;
}

/** 轮询等待，不要用固定 sleep —— 线上要过 TLS + 反代 + 网络。 */
async function waitFor(expr, label, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate(expr)) return true; } catch {}
    await sleep(120);
  }
  throw new Error(`等待超时：${label}`);
}

/* ── 断言 ───────────────────────────────────────────────────────────────── */
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '   ' + detail : ''}`);
}

/** 在页面里求对比度与暗色判定，返回结构化数据。 */
const PROBE = `(() => {
  const lum = (rgb) => {
    const m = rgb.match(/[\\d.]+/g);
    if (!m) return null;
    const [r, g, b] = m.slice(0, 3).map(Number).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const cs = getComputedStyle(document.body);
  const bg = cs.backgroundColor;
  const fg = cs.color;
  const lb = lum(bg), lf = lum(fg);
  const ratio = (lb === null || lf === null) ? null
    : (Math.max(lb, lf) + 0.05) / (Math.min(lb, lf) + 0.05);
  // 找一张 .card 看玻璃拟态是否真的生效
  const card = document.querySelector('.card');
  const ccs = card ? getComputedStyle(card) : null;
  // 标题字体
  const h1 = document.querySelector('h1, .post-card__title, .side-name, .name');
  const h1cs = h1 ? getComputedStyle(h1) : null;
  // 所有可见元素的颜色中，浅底（亮度 > 0.5 且非透明）的数量
  let lightSurfaces = 0, sampled = 0;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 20) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) continue;
    const bgc = s.backgroundColor;
    const a = bgc.match(/rgba?\\(([^)]*)\\)/);
    if (!a) continue;
    const parts = a[1].split(',').map((x) => Number(x.trim()));
    if (parts.length === 4 && parts[3] < 0.5) continue;   // 半透明面板不算浅底
    const l = lum(bgc);
    if (l === null) continue;
    sampled++;
    if (l > 0.5) lightSurfaces++;
  }

  /* 逐元素文本对比度：抓「暗底暗字 / 亮底亮字」。
     这类问题只在视觉上暴露 —— 构建门禁与 curl 全看不见，
     而整体的 body 对比度断言会被它蒙过去（body 是白字在暗底，很健康）。
     典型来源：表格 th/td、引用块、代码块、内联 <style> 覆盖。
     有效背景要沿祖先链找第一个不透明背景 —— 半透明面板之下其实是 body。 */
  const effBg = (el) => {
    let cur = el;
    while (cur) {
      const bg = getComputedStyle(cur).backgroundColor;
      const m = bg.match(/rgba?\\(([^)]*)\\)/);
      if (m) {
        const p = m[1].split(',').map((x) => Number(x.trim()));
        if (p.length < 4 || p[3] > 0.85) return { rgb: bg, l: lum(bg) };
      }
      cur = cur.parentElement;
    }
    return { rgb: 'rgb(255,255,255)', l: 1 };
  };
  const lowContrast = [];
  for (const el of document.querySelectorAll('body *')) {
    // 只看「自己直接带文字」的元素，避免容器把整棵子树的文字算进来
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.1) continue;
    const lf = lum(s.color);
    const eb = effBg(el);
    if (lf === null || eb.l === null) continue;
    const ratio = (Math.max(lf, eb.l) + 0.05) / (Math.min(lf, eb.l) + 0.05);
    if (ratio < 3) {
      lowContrast.push({
        tag: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
        fg: s.color, bg: eb.rgb, ratio: Number(ratio.toFixed(2)),
        text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24),
      });
    }
  }
  return {
    bodyBg: bg, bodyFg: fg, bodyLum: lb, contrast: ratio,
    rootScheme: getComputedStyle(document.documentElement).colorScheme,
    cardBg: ccs && ccs.backgroundColor,
    cardBackdrop: ccs && (ccs.backdropFilter || ccs.webkitBackdropFilter),
    h1Font: h1cs && h1cs.fontFamily,
    h1Size: h1cs && h1cs.fontSize,
    lightSurfaces, sampled, lowContrast,
    fontsStatus: document.fonts ? document.fonts.status : 'n/a',
    fonts: document.fonts ? [...document.fonts].map((f) => f.family + ' ' + f.weight).slice(0, 10) : [],
    text: (document.body.innerText || '').slice(0, 200000),
    attrs: [...document.querySelectorAll('*')].flatMap((el) =>
      [...el.attributes].map((a) => a.name + '=' + a.value)).join(' | '),
    rawHtml: document.documentElement.outerHTML.slice(0, 400000),
  };
})()`;

fs.mkdirSync(SHOTS, { recursive: true });

/* 需要登录态的页面（/console /editor）靠一个 cookie 切换。
   先跑完公开页，再落 cookie —— 否则首页顶栏会从「登录」按钮变成用户菜单，
   公开路径就少测了一次。线上模式不写任何 cookie（只读验收）。 */
let authCookieSet = false;

/* ── 线上只读模式的适配 ───────────────────────────────────────────────────
   两处 fixture 假设在线上不成立，必须自适应，否则门禁会「因为环境不同」常红：
     ① 文章 slug 来自 mock fixture，线上并不存在 → 先查线上第一篇真实文章
     ② /console /editor 未登录会被拦到 /login —— 这不是缺陷，而是**该被验证的行为**
   把 ② 变成断言（而不是跳过），线上就顺带验了鉴权门槛。 */
const ONLINE = !localServer;

if (ONLINE) {
  try {
    const r = await fetch(`${BASE}/api/public/posts?pageSize=1`);
    const d = await r.json();
    const slug = d && d.posts && d.posts[0] && d.posts[0].slug;
    const pp = PAGES.find((x) => x.name === '文章详情');
    if (slug && pp) {
      pp.url = '/post?slug=' + encodeURIComponent(slug);
      console.log(`线上模式：文章页改用线上真实 slug「${slug}」`);
    } else if (pp) {
      PAGES.splice(PAGES.indexOf(pp), 1);
      console.log('线上模式：线上无已发布文章，跳过文章页');
    }
  } catch (e) {
    console.log(`线上模式：取文章列表失败（${e.message}），跳过文章页`);
    const i = PAGES.findIndex((x) => x.name === '文章详情');
    if (i >= 0) PAGES.splice(i, 1);
  }
}

for (const page of PAGES) {
  console.log(`\n── ${page.name}  ${page.url} ───────────────────────────`);
  errors = [];

  if (page.auth && !authCookieSet && localServer) {
    await send('Page.navigate', { url: BASE + '/' });
    await waitFor(`document.readyState === 'complete'`, '首页（为落 cookie）');
    await evaluate(`document.cookie = 'mock_auth=1; path=/'`);
    authCookieSet = true;
    console.log('  · 已切换 mock 登录态');
  }

  await send('Page.navigate', { url: BASE + page.url });
  await waitFor(`document.readyState === 'complete'`, '页面加载');

  if (page.auth && ONLINE) {
    // 线上未登录：等它跳到登录页（或被拦下），把「被拦住」本身当作断言
    await waitFor(`!!document.querySelector('.login-logo') || location.pathname.startsWith('/login')`,
      '受保护页的拦截结果');
    const p = await evaluate('location.pathname');
    check(`${page.name}：未登录被拦到登录页`, p.startsWith('/login'), `location=${p}`);
    // 页面已被换成登录页，后续视觉项在 /login 那一轮已经查过，这里不再重复计分
    continue;
  }

  await waitFor(`!!document.querySelector(${JSON.stringify(page.ready)})`, `就绪标记 ${page.ready}`);

  /* 等内容真的渲染出来再断言，不要「就绪标记 + 固定 sleep」。
     坑：很多页面的就绪选择器是**静态标记**（.post-detail / .layout-side / .console-tabs
     都是写在 HTML 里的），接口还没回来它就已经存在了；这时固定等 400ms
     会稳定地抢在渲染之前 —— 一个好页面被判成「空页」，而且只在网络慢的线上复现
     （本地 mock 毫秒返回，永远看不出来）。
     所以这里轮询内容表达式，直到它自己说 ok，超时再如实报失败。 */
  let content = null;
  if (page.content) {
    const expr = page.content(ONLINE);
    for (let i = 0; i < 60; i++) {                 // 最多约 12 秒
      content = await evaluate(expr);
      if (content && content.ok) break;
      await sleep(200);
    }
  }
  await sleep(200);                                  // 让过渡落定

  /* 等字体加载完再取数。document.fonts.status 在仍有 font-face 在传时是
     'loading'，此时断言「字体已加载」会随网络快慢随机红 —— 必须等 fonts.ready。
     这一步用 catch 兜住：字体加载失败也要继续，由断言如实报错，而不是抛异常中断整轮。 */
  await evaluate('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true')
    .catch(() => {});

  let probe;
  try { probe = await evaluate(PROBE); }
  catch (e) { check(`${page.name}：探针执行`, false, String(e.message)); continue; }

  // 1) 暗色主题真的生效
  check(`${page.name}：body 为暗色底`,
    probe.bodyLum !== null && probe.bodyLum < 0.15,
    `bg=${probe.bodyBg} lum=${probe.bodyLum?.toFixed(4)}`);
  check(`${page.name}：正文对比度 ≥ 4.5`,
    probe.contrast !== null && probe.contrast >= 4.5,
    `contrast=${probe.contrast?.toFixed(2)} fg=${probe.bodyFg}`);
  check(`${page.name}：color-scheme 为 dark`,
    String(probe.rootScheme).includes('dark'), `color-scheme=${probe.rootScheme}`);

  // 2) 无浅色块（浅底元素占比；登录/控制台的输入框允许是浅底，故用比例判定）
  const lightRatio = probe.sampled ? probe.lightSurfaces / probe.sampled : 0;
  check(`${page.name}：无明显浅色块`,
    lightRatio <= 0.25, `${probe.lightSurfaces}/${probe.sampled} = ${(lightRatio * 100).toFixed(0)}%`);

  // 2b) 逐元素文本对比度 —— 整体 body 对比度再健康，也盖不住局部的浅底暗字。
  //     视角外（折叠以下）的元素一样会被扫到，表格/代码块因此不会漏检。
  check(`${page.name}：无低对比度文本`,
    probe.lowContrast.length === 0,
    probe.lowContrast.length
      ? probe.lowContrast.slice(0, 4)
          .map((x) => `${x.tag}[${x.ratio}] fg=${x.fg} bg=${x.bg} "${x.text}"`).join('  |  ')
      : '0 处');

  // 3) 玻璃拟态（首页/控制台等有 .card 的页面）
  if (page.url === '/' || page.url === '/console') {
    check(`${page.name}：.card 玻璃拟态生效`,
      !!probe.cardBackdrop && probe.cardBackdrop !== 'none' && /rgba/.test(probe.cardBg || ''),
      `backdrop=${probe.cardBackdrop} bg=${probe.cardBg}`);
  }

  // 4) 字体真的加载（不只是声明）
  check(`${page.name}：自托管字体已加载`,
    probe.fontsStatus === 'loaded' && probe.fonts.some((f) => f.includes('Public Sans')),
    `${probe.fontsStatus} · ${probe.fonts.length} faces`);

  // 5) 品牌名：屏幕上有「半山」，且没有旧品牌残留
  check(`${page.name}：渲染文本含「半山」`,
    probe.text.includes('半山'), '');
  {
    // 失败时把命中位置前后的原文带出来。只说「有残留」而不说「在哪」，
    // 排查就变成猜谜 —— 本次即靠它区分了「服务端没更新」与「边缘缓存旧 JS」。
    const inRaw = probe.rawHtml.includes('Personal Hub');
    let ctx = '';
    if (inRaw) {
      const i = probe.rawHtml.indexOf('Personal Hub');
      ctx = '上下文：…' + probe.rawHtml.slice(Math.max(0, i - 90), i + 40).replace(/\s+/g, ' ') + '…';
    } else if (probe.text.includes('Personal Hub')) {
      ctx = '仅出现在运行时可见文本（不在响应 DOM 里 → 来自脚本注入或缓存资源）';
    }
    check(`${page.name}：无旧品牌 "Personal Hub"`, !inRaw && !probe.text.includes('Personal Hub'), ctx);
  }

  // 6) 三层脱敏：运行时文本 / DOM 属性 / 响应 HTML
  const leakText = IDENTITY_TOKENS.filter((t) => scrub(probe.text).includes(t));
  const leakAttr = IDENTITY_TOKENS.filter((t) => scrub(probe.attrs).includes(t));
  check(`${page.name}：运行时文本无身份标识`, leakText.length === 0, leakText.join(','));
  check(`${page.name}：DOM 属性无身份标识`, leakAttr.length === 0, leakAttr.join(','));

  // 7) 内容真的渲染出来了 —— 「没报错」不等于「有内容」。
  //    空列表 / 接口 404 / 模板没跑，都会让页面看起来一切正常却是空的。
  //    content 已在上面轮询得到，这里只负责计分。
  if (page.content) {
    check(`${page.name}：内容已渲染`, !!(content && content.ok),
      content ? content.detail : '探针无返回');
  }

  // 8) 无 JS 异常
  const hard = errors.filter((e) => e && !/favicon|net::ERR_/.test(e));
  check(`${page.name}：无 JS 异常`, hard.length === 0, hard[0]?.slice(0, 120) || '');

  // 8) 截图留档（辅助产物，失败不中断主流程）
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(SHOTS, page.shot), Buffer.from(shot.result.data, 'base64'));
    console.log(`  · 截图 ${path.relative(ROOT, path.join(SHOTS, page.shot)).replace(/\\/g, '/')}`);
  } catch (e) {
    console.log(`  ! 截图失败（不影响断言）：${e.message}`);
  }
}

/* ── 控制台页的 .hidden 专项：面板必须真的收起 ────────────────────────────
   这是本项目已知的失效类型（作者样式盖住 UA 的 [hidden]）。
   这里用的是类名 .hidden，所以断言口径是「未激活的面板 computed display 为 none」。
   线上模式跳过：未登录访问 /console 会被拦到登录页，面板节点根本不存在。 */
if (!ONLINE) {
  console.log('\n── 控制台 .hidden 专项 ────────────────────────────');
  await send('Page.navigate', { url: BASE + '/console' });
  await waitFor(`document.readyState === 'complete'`, '控制台加载');
  await sleep(600);
  const hiddenState = await evaluate(`(() => {
    const ids = ['panel-posts', 'panel-files', 'panel-feed', 'panel-users', 'panel-remote', 'panel-account'];
    return ids.map((id) => {
      const el = document.getElementById(id);
      if (!el) return { id, exists: false };
      return { id, exists: true, cls: el.className, display: getComputedStyle(el).display };
    });
  })()`);
  const missing = hiddenState.filter((s) => !s.exists);
  const visible = hiddenState.filter((s) => s.exists && s.display !== 'none');
  check('控制台：六个面板节点都在', missing.length === 0, missing.map((m) => m.id).join(','));
  // 注意要把默认可见的 panel-posts 一起算进来 —— 只查那几个带 .hidden 的，
  // 「恰好一个可见」会退化成「零个可见也通过」的空断言。
  check('控制台：恰好显示一个面板，且默认为文章管理',
    visible.length === 1 && visible[0].id === 'panel-posts',
    `可见=[${visible.map((v) => v.id).join(',')}] / 共 ${hiddenState.length}`);
}

/* ── 图片专项（本地）：首屏 / 封面 / 正文灯箱 / 图片库 ─────────────────────
   这一组验的是「点击之后到底发生了什么」，而构建门禁与 curl 一律看不见：
   封面没渲染出来只是少一个 img；灯箱关不掉会把读者困在弹层里；
   复制按钮点了没反应则表现为「我明明复制了」而链接没进剪贴板。
   线上模式跳过 —— 图片库需要登录态，且验收脚本不该在线上做交互。 */
if (!ONLINE) {
  console.log('\n── 图片专项：首屏 / 封面 / 灯箱 / 图片库 ──────────');
  await evaluate(`document.cookie = 'mock_auth=1; path=/'`);

  /* 用真实鼠标点元素中心。不用 el.click()：合成事件绕过命中测试，
     元素被别的层盖住时它照样「成功」，那种通过是假的 ——
     而「弹层关不掉」正是这一类问题。 */
  async function realClick(sel) {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      // behavior 必须是 instant：页面若开了 scroll-behavior:smooth，
      // 平滑滚动是异步的，紧接着取的 rect 还是滚动前的位置，点会落在空处
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error('找不到元素：' + sel);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  }
  async function pressEsc() {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent',
        { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    }
  }
  /** 元素真的可见：display 不是 none，且占位高度大于 0（.hidden 是 display:none!important）。 */
  const shown = (sel) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
  })()`);

  /* ① 首页首屏与导航 */
  await send('Page.navigate', { url: BASE + '/' });
  await waitFor(`!!document.querySelector('.hero .hero-title-cn')`, '首屏就绪');
  check('首页：首屏渲染出中文站名',
    await evaluate(`document.querySelector('.hero .hero-title-cn').textContent.trim().length > 0`), '');
  // 静态 HTML 里时钟是占位符 --:--:--，只有脚本真的跑起来才会变成时间
  const clock = await evaluate(`document.getElementById('clockTime').textContent.trim()`);
  check('首页：北京时间时钟已在走动', /^\d{2}:\d{2}:\d{2}$/.test(clock), `clock=${clock}`);
  check('首页：导航链接带编号',
    await evaluate(`(() => { const a = document.querySelector('.nav-links a');
      return !!a && /^0\\d/.test(a.textContent.trim()); })()`), '');
  check('首页：站名标记为「半」字块',
    await evaluate(`(() => { const m = document.querySelector('.brand-mark');
      return !!m && m.textContent.includes('半'); })()`), '');

  /* ② 列表卡片封面：有封面的走「缩略图 + 文字」，且图真的能取到 */
  // 卡片是 JS 拉完 /api/public/posts 才渲染的，静态 HTML 里一个都没有。
  // 不等它就会出现这种假失败：同一份代码，一次测到 3 张、一次测到 0 张。
  await waitFor(`document.querySelectorAll('.post-card').length > 0`, '首页文章卡片就绪');
  const thumbs = await evaluate(`(() => {
    const boxes = document.querySelectorAll('.post-card.has-cover').length;
    const imgs = [...document.querySelectorAll('.post-thumb img')];
    return { boxes, imgs: imgs.length,
      // 破图和「还没轮到它加载」必须分开算：缩略图带 loading=lazy，
      // 首屏之外的图 complete 会一直是 false —— 那是懒加载在生效，不是坏图。
      broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length }; })()`);
  check('首页：有封面的卡片渲染出缩略图', thumbs.boxes >= 1 && thumbs.imgs >= 1,
    `${thumbs.boxes} 张带封面卡片 · ${thumbs.imgs} 个缩略图`);
  check('首页：封面图无破图', thumbs.imgs > 0 && thumbs.broken === 0,
    `${thumbs.broken} 张破图 / 共 ${thumbs.imgs}`);
  // 光「没破图」还不够：懒加载的图在取到之前也是这个状态。
  // 滚进视口再轮询到 naturalWidth > 0，才真正证明封面地址是可解析的。
  await evaluate(`document.querySelector('.post-thumb img')
    .scrollIntoView({ block: 'center', behavior: 'instant' })`);
  let thumbLoaded = false;
  for (let i = 0; i < 30 && !thumbLoaded; i++) {
    thumbLoaded = await evaluate(`(() => { const i = document.querySelector('.post-thumb img');
      return !!i && i.complete && i.naturalWidth > 0; })()`);
    if (!thumbLoaded) await sleep(150);
  }
  check('首页：封面图滚入视口后确实加载出来', thumbLoaded, '');

  /* ③ 文章详情：头图 + 插图增强 + 灯箱开关 */
  await send('Page.navigate', { url: BASE + '/post?slug=verify-by-one-command' });
  await waitFor(`!!document.querySelector('.post-html figure')`, '正文插图就绪');
  check('文章页：封面头图已渲染',
    await evaluate(`(() => { const i = document.querySelector('.post-cover');
      return !!i && i.complete && i.naturalWidth > 0; })()`), '');
  check('文章页：插图被包进 figure 且生成了图注',
    await evaluate(`(() => { const f = document.querySelector('.post-html figure');
      const cap = f && f.querySelector('figcaption');
      return !!cap && cap.textContent.trim().length > 0; })()`), '');
  check('文章页：插图补了懒加载',
    await evaluate(`document.querySelector('.post-html figure img').getAttribute('loading') === 'lazy'`), '');

  check('文章页：点图之前灯箱是关着的', !(await shown('#lightbox')), '');
  await realClick('.post-html figure img');
  await sleep(250);
  check('文章页：点图后灯箱打开且带图',
    (await shown('#lightbox')) &&
    (await evaluate(`!!document.getElementById('lightboxImg').getAttribute('src')`)), '');
  await pressEsc();
  await sleep(250);
  check('文章页：Esc 能关掉灯箱', !(await shown('#lightbox')), '');

  /* ④ 图片库：网格 / 灯箱 / 复制反馈 */
  await send('Page.navigate', { url: BASE + '/gallery' });
  await waitFor(`document.querySelectorAll('.grid-item').length > 0`, '图片库就绪');
  const gal = await evaluate(`(() => {
    const imgs = [...document.querySelectorAll('.grid-item img')];
    return { items: imgs.length,
      loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      actions: document.querySelectorAll('.grid-item .grid-actions button').length }; })()`);
  check('图片库：网格渲染出图片', gal.items >= 3, gal.items + ' 张');
  check('图片库：图片全部加载成功', gal.items > 0 && gal.loaded === gal.items,
    `${gal.loaded}/${gal.items}`);
  check('图片库：每张图都带操作按钮', gal.actions >= gal.items * 2, gal.actions + ' 个按钮');

  await realClick('.grid-item img');
  await sleep(250);
  check('图片库：点图打开灯箱', await shown('#lightbox'), '');
  await pressEsc();
  await sleep(250);
  check('图片库：Esc 能关掉灯箱', !(await shown('#lightbox')), '');

  /* 复制链接只断言「点了有反馈」：headless 下剪贴板可能被权限拦掉，
     那时文案会明确说失败 —— 真正要抓的是「按钮点了什么都不发生」。 */
  await realClick('.grid-item .grid-actions button[data-act="copy"]');
  await sleep(300);
  const copyMsg = await evaluate(`document.getElementById('msg').textContent.trim()`);
  check('图片库：复制链接按钮有反馈', /复制/.test(copyMsg), `msg="${copyMsg}"`);
}

ws.close(); chrome.kill();
if (localServer) await new Promise((r) => localServer.close(r));

/* ── 汇总 ───────────────────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(60)}`);
console.log(`通过 ${results.length - failed.length}/${results.length}`);
console.log(`截图目录：${SHOTS}`);
if (failed.length) {
  console.error('\n失败项：');
  for (const f of failed) console.error(`  ✗ ${f.name}  ${f.detail}`);
  process.exit(1);
}
if (!isLocal) console.log('（线上模式：以上为生产环境的真实渲染结果）');
console.log('全部通过。');
process.exit(0);
