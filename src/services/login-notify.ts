import type { Request } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';
import { pushMessage } from './notify';

/**
 * 登录事件通知（登录成功 / 登录失败 → 推送给管理员）。
 *
 * 设计要点：
 *  - 全部 fire-and-forget：通知只发起、不 await，任何异常不影响登录主流程；
 *  - 失败事件做防刷屏聚合：同一 (IP, 用户名) 10 分钟窗口内，第 1 次失败立即告警，
 *    之后每累计 5 次再发一条升级告警（提示疑似暴力破解），避免爆破时短信轰炸；
 *  - NOTIFY_WATCH_USERS 非空时只推送这些账号的事件（留空 = 推送全部）。
 */

const FAILURE_WINDOW_MS = 10 * 60 * 1000; // 聚合窗口
const FAILURE_ALERT_STEP = 5; // 窗口内每累计 5 次失败再发一条升级告警

interface FailureState {
  count: number; // 窗口内累计失败次数
  notified: number; // 已通知覆盖到的次数
  windowStart: number;
}

const failureMap = new Map<string, FailureState>();

const timeFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function nowStr(): string {
  return timeFmt.format(new Date());
}

function shouldNotifyUser(username: string): boolean {
  const list = config.notify.watchUsers;
  return list.length === 0 || list.includes(username);
}

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || '未知';
}

function clientUa(req: Request): string {
  const ua = req.headers['user-agent'] || '';
  return ua.length > 120 ? ua.slice(0, 120) + '…' : ua || '未知';
}

/** 登录成功通知。 */
export function notifyLoginSuccess(req: Request, user: { username: string; display_name?: string | null }): void {
  if (!config.notify.enabled || !shouldNotifyUser(user.username)) return;
  const name = user.display_name ? `${user.display_name}（${user.username}）` : user.username;
  pushMessage({
    title: '🟢 登录成功提醒',
    text:
      `**账号**：${name}\n` +
      `**来源 IP**：${clientIp(req)}\n` +
      `**设备/浏览器**：${clientUa(req)}\n` +
      `**时间**：${nowStr()}`,
  }).catch(() => {/* pushMessage 内部已记日志，此处兜底防止未处理拒绝 */});
}

/** 登录失败通知（reason：INVALID_CREDENTIALS / USER_DISABLED 等错误码）。 */
export function notifyLoginFailure(req: Request, username: string, reason: string): void {
  if (!config.notify.enabled || !shouldNotifyUser(username)) return;

  const ip = clientIp(req);
  const key = `${ip}|${username}`;
  const now = Date.now();
  const prev = failureMap.get(key);

  let title: string;
  let extra = '';
  if (!prev || now - prev.windowStart > FAILURE_WINDOW_MS) {
    // 新窗口：首次失败立即告警
    failureMap.set(key, { count: 1, notified: 1, windowStart: now });
    title = '🔴 登录失败提醒';
  } else {
    prev.count += 1;
    if (prev.count - prev.notified < FAILURE_ALERT_STEP) {
      // 窗口内聚合，不逐条轰炸
      logger.debug({ key, count: prev.count }, '登录失败已聚合，暂不推送');
      return;
    }
    prev.notified = prev.count;
    title = '🚨 疑似暴力破解告警';
    extra = `**10 分钟内已累计失败**：${prev.count} 次\n`;
  }

  const reasonText = reason === 'INVALID_CREDENTIALS' ? '用户名或密码错误' : reason === 'USER_DISABLED' ? '账号已被停用' : reason;

  pushMessage({
    title,
    text:
      `**账号**：${username}\n` +
      `**原因**：${reasonText}\n` +
      `${extra}` +
      `**来源 IP**：${ip}\n` +
      `**设备/浏览器**：${clientUa(req)}\n` +
      `**时间**：${nowStr()}`,
  }).catch(() => {/* 同上 */});
}

/** 供测试使用的内部重置（生产无副作用）。 */
export function _resetLoginNotifyForTest(): void {
  failureMap.clear();
}
