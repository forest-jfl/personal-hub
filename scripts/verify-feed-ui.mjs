// 每日抓取功能的浏览器级实测（CDP，零依赖）
// 用法：node scripts/verify-feed-ui.mjs            # 目标 http://127.0.0.1:3000
//      TARGET_URL=http://47.238.246.132 node scripts/verify-feed-ui.mjs   # 只读模式验证线上
// 退出码：0 通过 / 1 断言失败 / 2 执行中断 / 3 环境缺失
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.TARGET_URL || 'http://127.0.0.1:3000';
const READ_ONLY = !!process.env.TARGET_URL; // 指向外部地址时只读，不点写接口
const PORT = Number(process.env.CDP_PORT || 9333);
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';
const SHOT_DIR = process.env.SHOT_DIR || '.';

const CANDIDATES = [
  process.env.CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
].filter(Boolean);
const exe = CANDIDATES.find((p) => p && fs.existsSync(p));
if (!exe) { console.error('无可用浏览器，用 CHROME=<路径> 指定'); process.exit(3); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-feed-'));
const chrome = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

let ws, send, errors = [];
function makeClient(sock, onEvent) {
  let seq = 0; const pending = new Map();
  sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (onEvent) onEvent(m);
  };
  sock.onclose = () => {};
  return (method, params = {}) => new Promise((resolve) => {
    const id = ++seq; pending.set(id, resolve);
    sock.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
  return r.result?.result?.value;
}

/** 轮询等待条件成立，避免用固定 sleep 等页面就绪 */
async function waitFor(expr, { timeout = 15000, label = expr } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate(expr)) return true; } catch { /* 页面切换期间可能抛错 */ }
    await sleep(200);
  }
  throw new Error(`等待超时：${label}`);
}

async function goto(url) {
  await send('Page.navigate', { url });
  await waitFor("document.readyState === 'complete'", { label: 'readyState complete: ' + url });
}

async function click(selector) {
  const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null; el.scrollIntoView({block:'center'});
    const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!box) throw new Error(`元素不存在：${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await sleep(150);
}

async function typeInto(selector, text) {
  await click(selector);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ''`);
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch });
  }
}

async function shot(name) {
  try {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(SHOT_DIR, name);
    fs.writeFileSync(p, Buffer.from(s.result.data, 'base64'));
    console.log('      截图：' + p);
  } catch (e) { console.warn('      截图失败（不影响断言）：' + e.message); }
}

async function main() {
  // 等 DevTools 端口就绪
  let version = null;
  for (let i = 0; i < 80 && !version; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) version = await r.json(); } catch {}
    if (!version) await sleep(250);
  }
  if (!version) throw new Error('浏览器未就绪');

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  ws = await new Promise((res, rej) => {
    const s = new WebSocket(target.webSocketDebuggerUrl);
    s.onopen = () => res(s); s.onerror = rej;
  });
  send = makeClient(ws, (m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error'
      && m.params.entry.source === 'javascript') errors.push(m.params.entry.text);
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');

  // ============ T1 主页「今日更新」区块 ============
  // 先在 Node 侧取接口真值，再断言 DOM 与之相符 —— 既避免竞态，也交叉核对两端
  const dailyApi = await (await fetch(BASE + '/api/public/daily')).json();

  await goto(BASE + '/');
  await waitFor("!!document.getElementById('dailyArea')", { label: '#dailyArea 存在' });
  // 主页两个接口并发，必须等渲染真正完成再读 DOM：
  // 1) 主列表出现卡片或空态；2) 抓取区块按接口真值定型
  await waitFor(
    "(() => { const b = document.getElementById('postList'); return !!b && !!b.querySelector('.post-card, .card'); })()",
    { label: '主列表渲染完成' }
  );
  if (dailyApi.count > 0) {
    await waitFor("!document.getElementById('dailyArea').classList.contains('hidden')", { label: '今日更新区块显示' });
  } else {
    await waitFor("document.getElementById('dailyArea').innerHTML === ''", { label: '今日更新区块为空态' });
  }

  const daily = await evaluate(`(() => {
    const a = document.getElementById('dailyArea');
    const items = a.querySelectorAll('.daily-list li');
    return { cls: a.className, hidden: a.classList.contains('hidden'),
             computed: getComputedStyle(a).display, items: items.length,
             firstTitle: items[0] ? items[0].querySelector('a.title').textContent.trim() : '',
             firstHref: items[0] ? items[0].querySelector('a.title').getAttribute('href') : '',
             date: a.querySelector('.daily-date') ? a.querySelector('.daily-date').textContent.trim() : '' };
  })()`);
  check('T1 今日更新区块可见性与接口一致（count=' + dailyApi.count + '）',
    dailyApi.count > 0 ? daily.hidden === false : daily.hidden === true,
    `class="${daily.cls}" display=${daily.computed}`);
  check('T1 今日更新条目数与接口一致', daily.items === dailyApi.count, `DOM=${daily.items} API=${dailyApi.count} date=${daily.date}`);
  if (dailyApi.count > 0) {
    check('T1 条目链接指向 post.html?slug=', /post\.html\?slug=/.test(daily.firstHref), daily.firstHref);
    console.log('      首条：' + daily.firstTitle);
  }

  // ============ T2 卡片来源徽标 ============
  // 来源徽标数量应与接口里 source 非空的已发布文章数一致
  const listApi = await (await fetch(BASE + '/api/public/posts?page=1&pageSize=10')).json();
  const expectBadges = listApi.posts.filter((p) => p.source && p.source_name).length;
  await waitFor("!!document.querySelector('#postList .post-card')", { label: '主列表卡片渲染' });
  const badge = await evaluate(`(() => {
    const bs = document.querySelectorAll('#postList .src-badge');
    const manual = [...document.querySelectorAll('#postList .post-card')].filter(c => !c.querySelector('.src-badge')).length;
    const first = bs[0];
    return { n: bs.length, manualCards: manual,
             text: first ? first.textContent.trim() : '',
             href: first ? first.getAttribute('href') : '',
             target: first ? first.getAttribute('target') : '' };
  })()`);
  check('T2 来源徽标数量与接口一致', badge.n === expectBadges,
    `DOM=${badge.n} API=${expectBadges} 手工文章卡片=${badge.manualCards}`);
  if (expectBadges > 0) {
    check('T2 徽标外链指向原文且新窗口打开', /^https?:/.test(badge.href) && badge.target === '_blank', `${badge.text} ${badge.href}`);
  }

  // ============ T3 全局样式兜底：.hidden 必须真的不显示 ============
  const hiddenOk = await evaluate(`(() => {
    const d = document.createElement('div'); d.className = 'hidden'; d.textContent = 'x';
    document.body.appendChild(d);
    const disp = getComputedStyle(d).display;
    d.remove(); return disp;
  })()`);
  check('T3 .hidden 计算样式为 none（层叠兜底有效）', hiddenOk === 'none', `display=${hiddenOk}`);

  if (READ_ONLY) {
    console.log('\n[只读模式] 跳过控制台交互');
  } else {
    // ============ T4 登录 ============
    await goto(BASE + '/login');
    await waitFor("!!document.getElementById('username')", { label: '登录表单' });
    await typeInto('#username', ADMIN_USER);
    await typeInto('#password', ADMIN_PASS);
    await click('#loginBtn');
    await waitFor("!!document.getElementById('avatarBtn')", { timeout: 12000, label: '登录成功（头像出现）' })
      .catch(() => {});
    const loggedIn = await evaluate("!!document.getElementById('avatarBtn')");
    check('T4 登录成功', loggedIn === true, loggedIn ? '' : '未见头像按钮');
    if (!loggedIn) throw new Error('登录失败，后续控制台断言无法进行');

    // ============ T5 控制台抓取任务面板 ============
    await goto(BASE + '/console?tab=feed');
    await waitFor("document.querySelectorAll('#feedStats .feed-stat').length > 0", { label: '抓取状态渲染' });
    const feed = await evaluate(`(() => ({
      stats: document.querySelectorAll('#feedStats .feed-stat').length,
      statsText: document.getElementById('feedStats').textContent.replace(/\\s+/g, ' ').trim().slice(0, 120),
      sources: document.querySelectorAll('#feedSources li').length,
      sourcesText: document.getElementById('feedSources').textContent.replace(/\\s+/g,' ').trim().slice(0, 80),
      logs: document.querySelectorAll('#feedLogBody tr').length,
      logsText: document.getElementById('feedLogBody').textContent.replace(/\\s+/g,' ').trim().slice(0, 100),
      lastRun: document.getElementById('feedLastRun').textContent.replace(/\\s+/g,' ').trim().slice(0, 120),
    }))()`);
    check('T5 抓取面板渲染 4 个统计块', feed.stats === 4, feed.statsText);
    check('T5 可用来源列表已渲染', feed.sources >= 3, feed.sourcesText);
    check('T5 执行留痕有记录（非"暂无留痕"）', feed.logs >= 1 && !/暂无留痕/.test(feed.logsText), `${feed.logs} 行`);
    console.log('      最近运行：' + feed.lastRun);
    await shot('shot-console-feed.png');

    // ============ T5b 留痕时间不得差 8 小时（防止按 UTC 截断 DATETIME） ============
    const tz = await evaluate(`(() => {
      const td = document.querySelector('#feedLogBody tr td');
      if (!td) return null;
      const text = td.textContent.trim();
      const m = /(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2})/.exec(text);
      if (!m) return { text, textHour: null, nowHour: new Date().getHours() };
      // 页面运行在 Asia/Shanghai 时区，直接用本地小时对比
      return { text, textHour: Number(m[4]), nowDate: m[1]+'-'+m[2]+'-'+m[3],
               nowHour: new Date().getHours(), nowDate2: new Date().toISOString().slice(0,10) };
    })()`);
    const hourDiff = tz && tz.textHour !== null ? Math.abs(tz.textHour - tz.nowHour) % 24 : 99;
    check('T5b 留痕时间与本地时区一致（未按 UTC 截断）', !!tz && hourDiff <= 2,
      tz ? `${tz.text} vs 当前 ${tz.nowHour} 时（差 ${hourDiff}h）` : '未取到留痕行');

    // ============ T6 干跑按钮（真点击，验证手动触发链路） ============
    await click('#feedRunDry');
    let dryMsg = '';
    for (let i = 0; i < 90; i++) {
      dryMsg = await evaluate("document.getElementById('feedMsg').textContent");
      if (/干跑完成|执行失败/.test(dryMsg)) break;
      await sleep(500);
    }
    check('T6 干跑按钮触发成功并回报结果', /干跑完成/.test(dryMsg), dryMsg || '(无消息)');

    // ============ T7 发布 / 撤回（写路径，通过真实点击） ============
    await goto(BASE + '/console?tab=posts');
    await waitFor("!!document.querySelector('#postsBody [data-pub]')", { label: '存在待发布条目' });
    const before = await evaluate("document.querySelectorAll('#postsBody [data-pub]').length");
    await click('#postsBody [data-pub]');
    await waitFor("/已发布/.test(document.getElementById('msg').textContent)", { timeout: 10000, label: '发布成功提示' }).catch(() => {});
    const afterMsg = await evaluate("document.getElementById('msg').textContent");
    const after = await evaluate("document.querySelectorAll('#postsBody [data-pub]').length");
    check('T7 点击发布后提示"已发布"', /已发布/.test(afterMsg), afterMsg);
    check('T7 发布后待发布条目减少 1', after === before - 1, `${before} → ${after}`);
    await shot('shot-console-posts.png');

    // 撤回，恢复现场
    await click('#postsBody [data-unpub]');
    await waitFor("/已撤回/.test(document.getElementById('msg').textContent)", { timeout: 10000, label: '撤回成功提示' }).catch(() => {});
    const back = await evaluate("document.querySelectorAll('#postsBody [data-pub]').length");
    check('T7 点击撤回后回到草稿状态', back === before, `${after} → ${back}（原始 ${before}）`);

    // ============ T8 只显示草稿筛选 ============
    await click('#onlyDraft');
    await sleep(600);
    const draftCount = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#postsBody tr')];
      const hasPub = /已发布/.test(document.getElementById('postsBody').textContent);
      return { rows: rows.length, hasPub };
    })()`);
    check('T8 只看草稿筛选生效（列表无"已发布"）', draftCount.hasPub === false, `rows=${draftCount.rows}`);
    await click('#onlyDraft');

    // ============ T9 主页复检：DOM 必须与后端发布状态严格一致 ============
    await goto(BASE + '/');
    const dailyApi2 = await (await fetch(BASE + '/api/public/daily')).json();
    await waitFor(
      "(() => { const b = document.getElementById('postList'); return !!b && !!b.querySelector('.post-card, .card'); })()",
      { label: '主页复检渲染完成' }
    );
    await evaluate(`(async () => {
      for (let i = 0; i < 40; i++) {
        const a = document.getElementById('dailyArea');
        if (${dailyApi2.count} > 0 ? !a.classList.contains('hidden') : a.innerHTML === '') return true;
        await new Promise(r => setTimeout(r, 150));
      }
      return false;
    })()`);
    const daily2 = await evaluate(`(() => { const a = document.getElementById('dailyArea');
      return { hidden: a.classList.contains('hidden'), items: a.querySelectorAll('.daily-list li').length }; })()`);
    check('T9 主页今日更新与后端发布状态一致（撤回条目未出现）',
      (dailyApi2.count > 0 ? daily2.hidden === false && daily2.items === dailyApi2.count : daily2.items === 0),
      `hidden=${daily2.hidden} DOM=${daily2.items} API=${dailyApi2.count}`);
  }

  await shot('shot-home-daily.png');
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  console.error('执行中断：' + e.message);
  exitCode = 2;
}

if (errors.length) {
  console.error('\n页面 JS 异常：\n' + errors.join('\n'));
  if (!exitCode) exitCode = 1;
}
if (failed > 0 && !exitCode) exitCode = 1;

console.log(`\n共 ${results.length} 项断言，失败 ${failed} 项。退出码=${exitCode}`);
try { ws?.close(); } catch {}
try { chrome.kill(); } catch {}
process.exit(exitCode);
