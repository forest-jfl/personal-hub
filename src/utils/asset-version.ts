import fs from 'fs';
import path from 'path';

/**
 * 静态资源版本指纹 —— 把「文件已更新、客户端还在用旧副本」这类故障从根上掐掉。
 *
 * 为什么需要（2026-09-15 实测）：
 *   源站给 `.js` / `.css` / `.woff2` 发的是 `Cache-Control: public, max-age=0`，
 *   但经 Cloudflare 后客户端实际收到 `public, max-age=14400` ——
 *   CF 的 Browser Cache TTL（默认 4 小时）会按静态扩展名**重写** max-age。
 *   于是新版本上线后出现组合故障：HTML 不被 CF 缓存（`cf-cache-status: DYNAMIC`）所以已是新版，
 *   而 JS 仍卡在 4 小时缓存里 → 新 HTML 调用新 API，页面直接报
 *   `HUB.safeCover is not a function`。
 *
 * 为什么用 URL 指纹而不是继续调 max-age：
 *   max-age 会被 CF 重写，源站说了不算。而 URL 一变，**所有**缓存层
 *   （浏览器、CF、任何中间层）都必然视其为新资源并回源 ——
 *   这是唯一不依赖对方配置的确定性做法。
 *
 * 指纹自动从文件推导（mtime + size），容器重建即变化，
 * 不需要任何人记得手工 bump 版本号 —— 手工版本号一定会被忘掉。
 */

/** 参与指纹计算的根文件（相对 public/）。 */
const ROOT_FILES = ['config.js', 'favicon.svg'];

/**
 * 需要拼版本参数的引用形态：紧跟在引号之后的 `/assets/**` js|css，或两个根文件。
 *
 * 两端收紧的原因：
 *  - 前缀 `(?<=["'])`：只认「属性值开头」的站内路径。否则
 *    `https://cdn.jsdelivr.net/assets/x.css` 这类外部地址也会被拼上参数（外部 CDN 会 404）。
 *  - 后缀 `(?=["'])`：路径后必须紧跟引号，于是**已带 query 的引用不会被二次拼接**（天然幂等）。
 *
 * 该正则在服务端（Node）执行，不依赖浏览器对 lookbehind 的支持。
 */
const ASSET_REF = /(?<=["'])(\/(?:assets\/[\w./-]+\.(?:js|css)|config\.js|favicon\.svg))(?=["'])/g;

function collect(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else out.push(full);
  }
}

/** 由 public 目录内容推导版本串；同一份产物必得同一值。 */
export function computeAssetVersion(publicDir: string): string {
  const files: string[] = [];
  for (const name of ROOT_FILES) {
    const full = path.join(publicDir, name);
    if (fs.existsSync(full)) files.push(full);
  }
  const assetsDir = path.join(publicDir, 'assets');
  if (fs.existsSync(assetsDir)) collect(assetsDir, files);

  let hash = 0;
  for (const file of files.sort()) {
    const stat = fs.statSync(file);
    hash = (hash * 31 + Math.round(stat.mtimeMs) + stat.size) % 2147483647;
  }
  return hash.toString(36);
}

/** 给 HTML 里的静态资源引用拼上版本参数（幂等：已带 query 的不再拼）。 */
export function injectAssetVersion(html: string, version: string): string {
  return html.replace(ASSET_REF, `$1?v=${version}`);
}
