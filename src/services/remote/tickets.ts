import crypto from 'crypto';
import { config } from '../../config';

/**
 * 一次性 WebSocket 连接票据。
 *
 * 设计动机：浏览器发起 WebSocket 握手时会自动携带 Cookie，
 * 仅靠会话 Cookie 鉴权存在 CSWSH（跨站 WebSocket 劫持）风险——
 * 恶意第三方页页可借受害者浏览器发起跨站 WS 连接。
 * 因此采用「REST 签发票据 + WS 握手凭票据」的两步鉴权：
 *  1) 票据只能由已通过 requireAdmin 的 REST 请求签发；
 *  2) 票据一次性使用、短有效期（默认 60 秒）、与签发者绑定；
 *  3) 握手时另行校验 Origin，跨站连接即使拿到票据也无从签名。
 * 票据存内存即可：单实例部署，重启即失效，无持久化需求。
 */

interface TicketEntry {
  userId: number;
  username: string;
  ip: string;
  expiresAt: number;
}

const tickets = new Map<string, TicketEntry>();

/** 签发一张绑定用户的一次性票据。 */
export function issueTicket(userId: number, username: string, ip: string): string {
  // 先清理过期项，避免长期运行下 Map 膨胀
  const now = Date.now();
  for (const [k, v] of tickets) {
    if (v.expiresAt <= now) tickets.delete(k);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  tickets.set(token, {
    userId,
    username,
    ip,
    expiresAt: now + config.remote.ticketTtlSec * 1000,
  });
  return token;
}

/** 消费票据：有效则返回绑定信息并立即作废，否则返回 null。 */
export function consumeTicket(token: string): TicketEntry | null {
  if (!token) return null;
  const entry = tickets.get(token);
  if (!entry) return null;
  tickets.delete(token); // 单次使用：无论是否过期，取出即作废
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}
