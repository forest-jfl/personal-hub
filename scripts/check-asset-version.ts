/**
 * 静态资源版本注入的常驻门禁。
 *
 * 为什么值得单独一个脚本：这条逻辑决定 HTML 里资源引用长什么样。
 * 一旦失效（正则漏掉某种引号形态、或被改回「已带 query 仍二次拼接」），
 * 后果是**页面在缓存层拿到旧 JS** 而报 `xxx is not a function` ——
 * 构建全绿、`curl /` 也是 200，只有在「缓存命中窗口内」用真浏览器访问才看得见。
 *
 * 用法：npm run check:assets（ts-node，零新增依赖）
 * 退出码 0 通过 / 1 断言失败
 */
import path from 'path';
import { computeAssetVersion, injectAssetVersion } from '../src/utils/asset-version';

const V = 't3st';

/** [输入, 期望输出, 说明] —— 要么该被注入，要么必须原样不动。 */
const CASES: Array<[string, string, string]> = [
  // ---- 应当注入 ----
  [
    '<script src="/assets/api.js"></script>',
    '<script src="/assets/api.js?v=t3st"></script>',
    'api.js（最常见形态，漏了它整站 JS 都会错配）',
  ],
  [
    '<link rel="stylesheet" href="/assets/style.css" />',
    '<link rel="stylesheet" href="/assets/style.css?v=t3st" />',
    'style.css',
  ],
  [
    '<script src="/assets/hero.js"></script>',
    '<script src="/assets/hero.js?v=t3st"></script>',
    'hero.js（首页首屏时钟）',
  ],
  [
    '<script src="/config.js"></script>',
    '<script src="/config.js?v=t3st"></script>',
    'config.js（承载 API_BASE，改了更要立刻生效）',
  ],
  [
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
    '<link rel="icon" href="/favicon.svg?v=t3st" type="image/svg+xml" />',
    'favicon.svg',
  ],
  [
    "<script src='/assets/api.js'></script>",
    "<script src='/assets/api.js?v=t3st'></script>",
    '单引号属性值同样要注入',
  ],

  // ---- 必须原样不动 ----
  [
    '<script src="/assets/api.js?v=old"></script>',
    '<script src="/assets/api.js?v=old"></script>',
    '幂等：已带 query 的引用不得二次拼接（否则 ?v=a?v=b）',
  ],
  [
    'url("/assets/fonts/public-sans-latin-400-normal.woff2")',
    'url("/assets/fonts/public-sans-latin-400-normal.woff2")',
    '字体不在注入范围（CSS 内部引用，且字体不变）',
  ],
  [
    '<img src="/api/public/files/12/0123456789abcdef" />',
    '<img src="/api/public/files/12/0123456789abcdef" />',
    '站内图床地址不动（带 query 会被封面规则判为非法）',
  ],
  [
    '<script src="https://cdn.jsdelivr.net/assets/x.css"></script>',
    '<script src="https://cdn.jsdelivr.net/assets/x.css"></script>',
    '外部 CDN 中的 /assets/ 路径不得被误伤（拼了参数会 404）',
  ],
  [
    '<!-- 维护提示：/assets/api.js -->',
    '<!-- 维护提示：/assets/api.js -->',
    '非属性值（不在引号内）的提及不动',
  ],
];

let failed = 0;
function check(ok: boolean, label: string, detail: string): void {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    failed += 1;
    console.log(`✗ ${label}\n      ${detail}`);
  }
}

console.log('── 版本注入 ───────────────────────────────');
for (const [input, expected, why] of CASES) {
  const got = injectAssetVersion(input, V);
  check(got === expected, why, `期望：${expected}\n      实际：${got}`);
}

console.log('\n── 指纹本身 ───────────────────────────────');
const publicDir = path.resolve(__dirname, '..', 'public');
const v1 = computeAssetVersion(publicDir);
const v2 = computeAssetVersion(publicDir);
check(v1.length > 0, '指纹非空', `实际：${JSON.stringify(v1)}`);
check(v1 === v2, '同一份产物两次计算一致（可复现）', `${v1} vs ${v2}`);
check(/^[0-9a-z]+$/.test(v1), '指纹为 36 进制短串（可直接放进 URL）', v1);

const total = CASES.length + 3;
console.log(`\n${failed === 0 ? `全部通过（${total} 项）` : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
