/**
 * 客户端 IP 取法的常驻门禁。
 *
 * 为什么需要它：`req.ip` 取错了不会报错、不影响任何功能，只会静默地把
 * 「注册 IP」写成 CF 边缘 IP、并让按 IP 的限流把所有经同一 CF 数据中心的
 * 访客算作同一个人（限流形同虚设，还会误伤）。
 * 这类错误本地开发环境**永远复现不了** —— 本地没有 Cloudflare 也没有 Caddy，
 * `req.ip` 就是 127.0.0.1，怎么试都是对的。
 *
 * 所以把「跳数规则 + 完整链路形态」固化成场景表，纯函数即可验证。
 *
 * 用法：npm run check:client-ip（ts-node，零新增依赖）
 * 退出码 0 通过 / 1 断言失败
 */
import fs from 'fs';
import path from 'path';
import {
  CLOUDFLARE_RANGES,
  PRIVATE_RANGES,
  inCidr,
  isCloudflareAddress,
  isPrivateAddress,
  resolveClientIp,
  trustProxyHop,
} from '../src/utils/client-ip';

let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '   ' + detail : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

/* ── ① CIDR 匹配边界 ────────────────────────────────────────────────────── */

const CIDR_CASES: Array<[string, string, boolean, string]> = [
  ['172.18.0.2', '172.16.0.0/12', true, 'Docker 默认网段（Caddy 就在这）'],
  ['172.16.0.0', '172.16.0.0/12', true, '网段首地址'],
  ['172.31.255.255', '172.16.0.0/12', true, '网段末地址'],
  ['172.32.0.0', '172.16.0.0/12', false, '刚出网段 —— 差一位就错放公网地址进来'],
  ['172.15.255.255', '172.16.0.0/12', false, '刚进网段下界之下'],
  ['172.64.1.1', '172.64.0.0/13', true, 'CF 边缘'],
  ['172.71.255.255', '172.64.0.0/13', true, 'CF 段末地址'],
  ['172.72.0.0', '172.64.0.0/13', false, '刚出 CF 段'],
  ['104.16.0.0', '104.16.0.0/13', true, 'CF 段首'],
  ['104.23.255.255', '104.16.0.0/13', true, 'CF 段末'],
  ['104.24.0.0', '104.16.0.0/13', false, '104.24 是另一条 CF 段，不该被本段命中'],
  ['2606:4700::1', '2606:4700::/32', true, 'CF IPv6'],
  ['2001:db8::5', '2606:4700::/32', false, '非 CF IPv6'],
  ['::ffff:172.18.0.2', '172.16.0.0/12', true, 'IPv4-mapped 必须归一成 32 位才对得上'],
  ['::1', '::1/128', true, '/128 全匹配'],
  ['1.2.3.4', '2606:4700::/32', false, '跨族不匹配（不做 IPv4↔IPv6 推断）'],
  ['', '10.0.0.0/8', false, '空串'],
  ['not-an-ip', '10.0.0.0/8', false, '非法输入'],
  ['1.2.3', '10.0.0.0/8', false, '段数不足'],
  ['1.2.3.256', '10.0.0.0/8', false, '越界八位组'],
];

console.log('\n── ① CIDR 匹配边界 ──────────────────────');
for (const [addr, cidr, want, why] of CIDR_CASES) {
  eq(`${addr} ∈ ${cidr}（${why}）`, inCidr(addr, cidr), want);
}

/* ── ② 跳数判定（trustProxyHop）─────────────────────────────────────────── */

console.log('\n── ② 跳数判定 ──────────────────────────');
const HOP_CASES: Array<[string, number, boolean, string]> = [
  ['172.18.0.2', 0, true, '第 0 跳 = Caddy（Docker 内网）'],
  ['127.0.0.1', 0, true, '本地直连'],
  ['::ffff:172.18.0.2', 0, true, 'IPv4-mapped 形态的 Caddy'],
  ['172.64.1.1', 0, false, '第 0 跳若是 CF 边缘，说明中间那跳没人了 —— 不信任'],
  ['203.0.113.9', 0, false, 'app 端口若被暴露到公网，任何人都能自称代理'],
  ['172.64.1.1', 1, true, '第 1 跳 = CF 边缘'],
  ['2606:4700::1', 1, true, '第 1 跳 = CF 边缘（IPv6 回源）'],
  ['203.0.113.7', 1, false, '绕过 CF 直连时的伪造项 —— 必须拒绝'],
  ['172.18.0.3', 1, false, '内网地址不该出现在第 1 跳'],
  ['172.64.1.1', 2, false, '第 2 跳起一律不信任'],
  ['', 0, false, '空地址'],
];

for (const [addr, hop, want, why] of HOP_CASES) {
  eq(`hop${hop} ${addr || '(空)'} → ${want ? '信任' : '拒绝'}（${why}）`, trustProxyHop(addr, hop), want);
}

/* ── ③ 完整链路（resolveClientIp）─────────────────────────────────────────
   场景表就是「谁在最左、谁在最右」的真相记录：
   XFF 由每个代理**追加**它自己看到的对端，于是最右是离源站最近的代理，
   最左才是最初写入者（可能是访客自己伪造的）。 */

console.log('\n── ③ 完整链路 ──────────────────────────');
const CADDY = '172.18.0.2'; // app 看到的 socket 对端
const CF4 = '172.64.1.1'; // CF 边缘（IPv4 回源）
const CF6 = '2606:4700::1'; // CF 边缘（IPv6 回源）
const VISITOR = '1.2.3.4'; // 访客
const ATTACKER = '203.0.113.7'; // 绕过 CF 直连源站的人
const FORGED = '9.9.9.9'; // 任何一方在 XFF 里塞的假地址

const CHAIN_CASES: Array<[string | undefined, string | undefined, string, string]> = [
  [`${VISITOR}, ${CF4}`, CADDY, VISITOR, '经 CF：XFF 末项是 CF 边缘 → 取到真访客'],
  [`${VISITOR}, ${CF6}`, CADDY, VISITOR, '经 CF（IPv6 回源）'],
  [`${FORGED}, ${VISITOR}, ${CF4}`, CADDY, VISITOR, '访客自带伪造项（CF 追加而非剥离）→ 仍取真访客'],
  [`${FORGED}, ${ATTACKER}`, CADDY, ATTACKER, '绕过 CF 直连 + 伪造（Caddy 追加真实对端）→ 只拿到攻击者真实 IP，伪造被挡'],
  [ATTACKER, CADDY, ATTACKER, '绕过 CF 直连（Caddy 已剥离伪造项）'],
  [`${VISITOR}, ${CF4}`, '::ffff:172.18.0.2', VISITOR, 'socket 对端是 IPv4-mapped 形态'],
  ['', '127.0.0.1', '127.0.0.1', '同机直连、无 XFF'],
  [`${VISITOR},  , ${CF4}`, CADDY, VISITOR, 'XFF 里有空项（真实代理常这么发）'],
  [CF4, CADDY, CF4, '只有 CF 一跳时退回边缘 IP —— 无访客信息，这是唯一合理选择'],
  ['', undefined, '', '拿不到对端'],
];

for (const [xff, peer, want, why] of CHAIN_CASES) {
  eq(`xff="${xff}" peer=${peer ?? '(无)'}（${why}）`, resolveClientIp(xff, peer), want);
}

/* ── ④ 与 Caddyfile 的 CF 段列表对账 ──────────────────────────────────────
   Caddyfile 的 trusted_proxies 决定「Caddy 认不认来路」，本模块的
   CLOUDFLARE_RANGES 决定「应用认不认 XFF 末项」。两处漂移不会报错，
   只会让本模块保守地退回 CF 边缘 IP —— 即修复悄悄失效。 */

console.log('\n── ④ 与 deploy/Caddyfile 对账 ──────────');
const caddyPath = path.resolve(__dirname, '..', 'deploy', 'Caddyfile');
if (!fs.existsSync(caddyPath)) {
  check('deploy/Caddyfile 存在', false, `未找到 ${caddyPath}`);
} else {
  const text = fs.readFileSync(caddyPath, 'utf8');
  const m = text.match(/trusted_proxies\s+static\s+([^\n}]+)/);
  if (!m) {
    // 仓库里的 Caddyfile 早于 CF 网段配置；服务器真身带这一段但不在版本库里
    // （它与 iptv/tools 站点块混在一个文件中，不属于本仓库职责）。
    console.log('· deploy/Caddyfile 无 trusted_proxies 段（仓库版本早于该配置）—— 跳过对账');
    console.log('  服务器真身由运维维护；上线后用「直连源站」探针验证伪造被拒（见 README §6.10）');
  } else {
    const fromCaddy = m[1]
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    const mine = [...CLOUDFLARE_RANGES].sort();
    const onlyCaddy = fromCaddy.filter((r) => !mine.includes(r));
    const onlyMine = mine.filter((r) => !fromCaddy.includes(r));
    check(
      'Caddyfile 与 CLOUDFLARE_RANGES 逐条一致',
      onlyCaddy.length === 0 && onlyMine.length === 0,
      onlyCaddy.length || onlyMine.length
        ? `仅 Caddyfile 有：${onlyCaddy.join(' ') || '无'}；仅代码有：${onlyMine.join(' ') || '无'}`
        : `${mine.length} 条`
    );
  }
}

/* ── ⑤ 网段表自身的卫生 ────────────────────────────────────────────────── */

console.log('\n── ⑤ 网段表卫生 ────────────────────────');
for (const [name, ranges] of [
  ['CLOUDFLARE_RANGES', CLOUDFLARE_RANGES],
  ['PRIVATE_RANGES', PRIVATE_RANGES],
] as Array<[string, string[]]>) {
  const dup = ranges.filter((r, i) => ranges.indexOf(r) !== i);
  check(`${name} 无重复项`, dup.length === 0, dup.length ? dup.join(' ') : `${ranges.length} 条`);
  const bad = ranges.filter((r) => !/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(r));
  check(`${name} 全为合法 CIDR 字面量`, bad.length === 0, bad.join(' '));
}
// 私有段与 CF 段不该重叠：重叠意味着「同一条链路可能两处都判真」
const overlap = PRIVATE_RANGES.filter((p) => CLOUDFLARE_RANGES.some((c) => c === p));
check('私有段与 CF 段不重叠', overlap.length === 0, overlap.join(' '));
check('CF 边缘地址不被判为私有', !isPrivateAddress(CF4) && !isPrivateAddress(CF6), CF4);
check('Caddy 内网地址不被判为 CF', !isCloudflareAddress(CADDY), CADDY);

/* ── 汇总 ───────────────────────────────────────────────────────────────── */

console.log(`\n${'='.repeat(60)}`);
if (failed > 0) {
  console.error(`失败 ${failed} 项。`);
  process.exit(1);
}
console.log('全部通过。');
process.exit(0);
