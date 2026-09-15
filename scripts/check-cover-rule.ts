/**
 * 封面地址规则的常驻门禁。
 *
 * 为什么值得单独一个脚本：这条规则决定 `<img src>` 里能出现什么，
 * 一旦被后续改动放松（多放行一个协议、少一个锚定），
 * 后果是存储型 XSS 或混合内容，而**页面看起来完全正常**——
 * 没有任何构建期信号会提示。
 *
 * 用法：npm run check:cover（ts-node，零新增依赖）
 * 退出码 0 通过 / 1 断言失败
 */
import { isValidCover } from '../src/utils/cover';

const ALLOW: Array<[string, string]> = [
  ['', '空串 = 清空封面'],
  ['/api/public/files/12/0123456789abcdef', '站内图床（编辑器插入的形态）'],
  ['/api/public/files/1/deadbeefdeadbeefdeadbeefdeadbeef', '站内图床（32 位令牌）'],
  ['https://example.com/a.png', '外部 https'],
  ['HTTPS://EXAMPLE.COM/A.PNG', '外部 https（协议大小写不敏感）'],
];

const REJECT: Array<[string, string]> = [
  ['http://example.com/a.png', '明文 http 会触发混合内容'],
  ['javascript:alert(1)', '协议注入'],
  ['data:image/svg+xml;base64,PHN2Zz4=', 'data: 可绕过同源内容策略'],
  ['//evil.example.com/a.png', '协议相对地址'],
  ['/api/public/files/12/NOTHEX!!', '令牌必须是 16-64 位小写十六进制'],
  ['/api/public/files/abc/0123456789abcdef', 'id 必须是数字'],
  ['/api/public/files/12/0123456789abcdef?x=1', '不接受查询串'],
  ['/etc/passwd', '任意站内路径'],
  ['  /api/public/files/12/0123456789abcdef', '首尾空白（应先 trim 再校验）'],
];

let failed = 0;
function check(ok: boolean, label: string, detail: string): void {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    failed += 1;
    console.log(`✗ ${label}  ${detail}`);
  }
}

console.log('── 应当放行 ───────────────────────────────');
for (const [value, why] of ALLOW) {
  check(isValidCover(value), why, `实际拒绝：${JSON.stringify(value)}`);
}

console.log('\n── 应当拒绝 ───────────────────────────────');
for (const [value, why] of REJECT) {
  check(!isValidCover(value), why, `实际放行：${JSON.stringify(value)}`);
}

console.log(`\n${failed === 0 ? `全部通过（${ALLOW.length + REJECT.length} 项）` : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
