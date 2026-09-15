/**
 * 客户端真实 IP 的取法 —— 全站唯一实现。
 *
 * 为什么不能直接用 `req.ip`：
 *   链路是「访客 → Cloudflare 边缘 → Caddy → app」，中间两次反代。
 *   而 `req.ip` 依赖 `trust proxy` 的跳数，原值为 1（只信任 Caddy 这一跳），
 *   于是它稳定地返回 **CF 边缘 IP**（172.64.0.0/13 等），而不是访客 IP。
 *   后果是静默的、且不影响功能：注册 IP 落库成边缘 IP、按 IP 限流把所有
 *   经同一 CF 数据中心的访客算作同一个人（限流形同虚设，且会误伤）。
 *
 * 为什么不是简单地把 trust proxy 调成 2：
 *   跳数是个「位置」条件，不含「来源」条件。若请求**绕过 Cloudflare**
 *   直连源站（`http://47.238.246.132` 那个 Caddy 块就是为此存在的），
 *   X-Forwarded-For 的末项就落进攻击者手里 —— 数字跳数会照单全收，
 *   于是「传什么 IP 就被当成什么 IP」，注册 IP 记录与限流一起被绕过。
 *
 * 所以判定要同时约束位置与来源：
 *   第 0 跳（socket 对端）= Caddy，必落私有网段；
 *   第 1 跳（XFF 末项）  = CF 边缘，必落 Cloudflare 网段。
 * 两条都成立时，`req.ip` 才会返回第 2 跳 —— 也就是真实访客。
 *
 * 不依赖「Caddy 是否自行丢弃不可信来源的 XFF」这一行为：
 *   无论 Caddy 保留还是追加，第一个不受信任的地址恰好就是访客 IP，
 *   而 proxy-addr 的截断规则会在那里停下（见 check:client-ip 的场景表）。
 */

/** Cloudflare 边缘网段。**必须与 `deploy/Caddyfile` 的 `trusted_proxies` 逐条一致**：
 *  那份决定 Caddy 认不认来路的 XFF，这份决定应用认不认 XFF 的末项。
 *  两处漂移会让「谁是真访客」得出不同答案，故由 `npm run check:client-ip` 对账。 */
export const CLOUDFLARE_RANGES = [
  // IPv4
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  // IPv6
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/32',
  '2c0f:f248::/32',
];

/** 私有 / 回环 / 链路本地网段：Caddy 与 app 同处一个 Docker 网络，紧邻一跳必落在这里。 */
export const PRIVATE_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

/** 归一化后的 IP：IPv4 记 32 位，IPv6 记 128 位。 */
type ParsedIp = { bits: 32 | 128; value: bigint };

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function ipv6ToBigInt(ip: string): bigint | null {
  let s = ip;
  const zone = s.indexOf('%'); // fe80::1%eth0 这类 zone id
  if (zone >= 0) s = s.slice(0, zone);
  // 末尾的 IPv4 写法（::ffff:1.2.3.4）先折成两组十六进制
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const dbl = s.indexOf('::');
  let groups: string[];
  if (dbl >= 0) {
    const head = s.slice(0, dbl).split(':').filter((x) => x !== '');
    const rest = s.slice(dbl + 2).split(':').filter((x) => x !== '');
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill('0'), ...rest];
  } else {
    groups = s.split(':');
  }
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

function parseIp(raw: string): ParsedIp | null {
  const ip = raw.trim();
  if (ip === '') return null;
  if (ip.includes(':')) {
    const v6 = ipv6ToBigInt(ip);
    if (v6 === null) return null;
    // IPv4-mapped（::ffff:172.18.0.2）：Docker 的 dual-stack 监听会给出这种形态，
    // 归一成 32 位才能与 IPv4 网段比对。
    if (v6 >> 32n === 0xffffn) return { bits: 32, value: v6 & 0xffffffffn };
    return { bits: 128, value: v6 };
  }
  const v4 = ipv4ToInt(ip);
  return v4 === null ? null : { bits: 32, value: BigInt(v4) };
}

/** CIDR 匹配。两侧位数不同一律不匹配（不做 IPv4↔IPv6 的跨族推断）。 */
export function inCidr(addr: string, cidr: string): boolean {
  const p = parseIp(addr);
  const [net, lenStr] = cidr.split('/');
  const n = parseIp(net);
  if (!p || !n || p.bits !== n.bits) return false;
  const len = Number(lenStr);
  if (!Number.isInteger(len) || len < 0 || len > p.bits) return false;
  const shift = BigInt(p.bits - len);
  return p.value >> shift === n.value >> shift;
}

function inAny(addr: string, ranges: string[]): boolean {
  return ranges.some((r) => inCidr(addr, r));
}

export function isPrivateAddress(addr: string): boolean {
  return inAny(addr, PRIVATE_RANGES);
}

export function isCloudflareAddress(addr: string): boolean {
  return inAny(addr, CLOUDFLARE_RANGES);
}

/**
 * 传给 `app.set('trust proxy', ...)` 的谓词（签名即 proxy-addr 的 `(addr, i)`）。
 *
 * 第 0 跳必须是私有网段：**否则 app 端口一旦暴露在公网**（compose 误加 `ports`），
 * 任何人都能自称是代理，把 XFF 里塞什么就被当成什么。
 * 第 1 跳必须是 CF 边缘：挡住「绕过 Cloudflare 直连源站」时的伪造。
 */
export function trustProxyHop(addr: string, hop: number): boolean {
  if (hop === 0) return isPrivateAddress(addr);
  if (hop === 1) return isCloudflareAddress(addr);
  return false;
}

/**
 * 取客户端 IP。取不到时返回空串，由调用方决定「未知」怎么表达
 * （注册表用空串表示「非自助注册」，故不能在这里统一成 'unknown'）。
 */
export function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  return req.ip || req.socket?.remoteAddress || '';
}

/**
 * 从「原始 XFF 头 + socket 对端」复算客户端 IP。
 *
 * HTTP 侧由 proxy-addr 依 `trustProxyHop` 算好放在 `req.ip`；但 WS 握手指的是
 * server 的 `upgrade` 事件（见 ws/remote-ws.ts），运行在 Express 之外，没有 `req.ip`。
 * 若不在这里用同一套规则复算，该通道就会退化成「取 XFF 最左段」——那是客户端
 * 可以随意填的位置，等于把「谁连上来的」交给对方自报。
 *
 * 跳数规则与 proxy-addr 等价：从紧邻对端逐跳检查，返回第一个不受信任的地址；
 * 全部受信任时返回最左端（XFF 的首项）。
 */
export function resolveClientIp(
  forwardedFor: string | undefined,
  remoteAddress: string | undefined
): string {
  const peer = remoteAddress || '';
  if (peer === '') return '';
  // XFF 是「客户端在最左」，倒序后与 proxy-addr 的内部数组同序：[对端, 近端代理, …, 客户端]
  const chain = (forwardedFor || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .reverse();
  const addrs = [peer, ...chain];
  for (let i = 0; i < addrs.length - 1; i++) {
    if (!trustProxyHop(addrs[i], i)) return addrs[i];
  }
  return addrs[addrs.length - 1];
}
