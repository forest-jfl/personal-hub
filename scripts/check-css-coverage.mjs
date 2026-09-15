/**
 * 类名覆盖率对账 —— 全量重写样式表之后必须跑的一道。
 *
 * 背景：这次改造把 `public/assets/style.css` 整个重写了（736 行，暗色玻璃拟态）。
 * 重写单文件样式的风险不在语法，而在**静默漏项**：
 *   · 某个还在用的类名忘了写规则 → 元素退化成无样式（不报错、构建全绿、curl 看不出）
 *   · 某个类名只在 JS 里被 classList.add 出现 → grep HTML 扫不到，最容易漏
 *   · 内联 style 里写死了浅色（#fff / #333 之类）→ 暗色主题下变成白底黑字
 *
 * 所以这个脚本做三件事：
 *   1) 收集「在用类名」：HTML 的 class 属性 + JS 里 classList/className/字符串模板中的 class
 *   2) 收集「已定义类名」：style.css 里的 .foo 选择器
 *   3) 报出 used-but-undefined（必须为 0）与 defined-but-unused（仅提示），
 *      并单独扫 HTML 内联 style 里的浅色硬编码
 *
 * 只读、零依赖，可常驻。用法： node scripts/check-css-coverage.mjs
 * 退出码：0 通过 / 1 有漏项
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CSS = path.join(PUBLIC, 'assets', 'style.css');

/** 这些类名由第三方或运行时产生，不在样式表里也不该报错。 */
const IGNORE_UNUSED = new Set(['hidden']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const cssText = fs.readFileSync(CSS, 'utf8');

/* ── 1) 已定义类名 ────────────────────────────────────────────────────────
   只取选择器里出现的 .foo，不区分它在哪个选择器组合中。
   注意排除属性选择器与值中的点（如 url(a.b.png)、0.5rem）。 */
const defined = new Set();
{
  // 先剥掉注释与字符串，避免把 background-image:url(x.png) 当成类名
  const scrubbed = cssText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/url\([^)]*\)/g, ' ');
  // 选择器区（{ 之前的部分）
  for (const block of scrubbed.split('{').slice(0, -1)) {
    const sel = block.slice(block.lastIndexOf('}') + 1);
    for (const m of sel.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) defined.add(m[1]);
  }
  // @media / @supports 等规则头会被当成选择器，其内的点已由上面覆盖，无副作用
}

/* ── 2) 在用类名 ──────────────────────────────────────────────────────────
   HTML：class="a b c"
   JS：  classList.add/remove/toggle/contains('a')、className = 'a b'、
         字符串模板里 class="a b"、classList 批量数组 */
const used = new Map(); // name -> Set(来源文件)
function mark(name, file) {
  if (!name || /[^A-Za-z0-9_-]/.test(name)) return;
  if (!used.has(name)) used.set(name, new Set());
  used.get(name).add(path.relative(ROOT, file).replace(/\\/g, '/'));
}

const htmlFiles = walk(PUBLIC).filter((f) => /\.(html|js)$/.test(f));
for (const file of htmlFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');

  // class="..." 与 class='...'（含 JS 模板字符串里的）
  for (const m of text.matchAll(/class\s*=\s*(["'`])([^"'`]*)\1/g)) {
    for (const n of m[2].split(/\s+/)) mark(n, file);
  }
  // classList.add/remove/toggle/contains('x', 'y')
  for (const m of text.matchAll(/classList\.(?:add|remove|toggle|contains)\(([^)]*)\)/g)) {
    for (const q of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) {
      for (const n of q[1].split(/\s+/)) mark(n, file);
    }
  }
  // className = 'a b'
  for (const m of text.matchAll(/className\s*=\s*['"`]([^'"`]*)['"`]/g)) {
    for (const n of m[1].split(/\s+/)) mark(n, file);
  }
  /* JS 拼接出来的 class 属性：'<div class="card post-card' + (cover ? ' has-cover' : '') + '">'
     上面那条 class="..." 要求引号配平，拼接形态因此匹配不到 ——
     后果不只是「多两条噪音提示」：类名在样式表里改名后，拼接处仍写着旧名时
     两条通道都扫不到，元素静默退化成无样式，而构建照样全绿。
     只认这个具体形状（class= 起始的那段字面量，加上紧跟其后 ? : 分支里的字面量），
     不能把「class= 到本行结束」整段拿来抽引号 —— 那样 id="coverThumb" 会被当成类名。 */
  for (const m of text.matchAll(
    /class\s*=\s*["'`]([A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*)*)["'`]?\s*\+([^\n]{0,160}?)["'`]\s*(?:\+|>)/g
  )) {
    for (const n of m[1].split(/\s+/)) mark(n, file);
    for (const q of m[2].matchAll(/["'`]([^"'`]*)["'`]/g)) {
      // 片段常带前导空格（' has-cover'）；只认「整段就是类名」的，
      // 顺带挡掉三元里的表达式与空串
      const frag = q[1].trim();
      if (!/^[A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*)*$/.test(frag)) continue;
      for (const n of frag.split(/\s+/)) mark(n, file);
    }
  }
  // classList 批量：querySelectorAll('.a') 里的点选选择器不算「在用」，跳过
  void rel;
}

/* ── 3) 比对 ───────────────────────────────────────────────────────────── */
const missing = [...used.keys()].filter((n) => !defined.has(n)).sort();
const unused = [...defined].filter((n) => !used.has(n) && !IGNORE_UNUSED.has(n)).sort();

/* ── 4) 内联浅色硬编码 ───────────────────────────────────────────────────
   只查 HTML 内联 style 与 <style> 块：写死白/浅灰会在暗色主题下形成白块。 */
/* 注意 `white` 后面必须是边界：`white-space:pre-wrap` 不是颜色。
   同理 `#fff` 这类要排除十六进制色值之外的场合（本表只在样式里扫，够用）。 */
const LIGHT_COLOR =
  /(?:^|[;:\s(])(?:#(?:fff(?:fff)?|f[0-9a-f]{2}|e[0-9a-f]{2}|ddd(?:ddd)?|ccc(?:ccc)?|eee(?:eee)?)|white(?![-\w])|rgb\(\s*2[0-9]{2}\s*,)/i;
const lightHits = [];
for (const file of walk(PUBLIC).filter((f) => /\.html$/.test(f))) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  // 内联 style="..."
  for (const m of text.matchAll(/style\s*=\s*"([^"]*)"/g)) {
    if (LIGHT_COLOR.test(m[1])) lightHits.push(`${rel}: style="${m[1].slice(0, 90)}"`);
  }
  // <style> 块逐行
  for (const block of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    for (const line of block[1].split('\n')) {
      if (/^\s*(\/\*|\*)/.test(line)) continue;
      if (LIGHT_COLOR.test(line)) lightHits.push(`${rel}: ${line.trim().slice(0, 90)}`);
    }
  }
}

/* ── 输出 ───────────────────────────────────────────────────────────────── */
let fail = false;
console.log(`样式表定义类名：${defined.size} 个`);
console.log(`页面/脚本在用类名：${used.size} 个\n`);

if (missing.length) {
  fail = true;
  console.error(`✗ 在用但样式表未定义（${missing.length} 个）——元素会退化成无样式：`);
  for (const n of missing) console.error(`    .${n}   ← ${[...used.get(n)].join(', ')}`);
} else {
  console.log('✓ 在用类名全部有样式定义');
}

if (unused.length) {
  console.log(`\n· 样式表定义但未被引用（${unused.length} 个，仅提示）：`);
  console.log('    ' + unused.map((n) => `.${n}`).join(' '));
}

if (lightHits.length) {
  fail = true;
  console.error(`\n✗ 内联/内嵌样式里的浅色硬编码（${lightHits.length} 处）——暗色主题下会形成白块：`);
  for (const h of lightHits) console.error('    ' + h);
} else {
  console.log('\n✓ 未发现内联浅色硬编码');
}

process.exit(fail ? 1 : 0);
