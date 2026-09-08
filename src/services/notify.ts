import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * 通用消息推送模块（登录通知等事件告警的底层通道）。
 *
 * 支持渠道：
 *  - wecom     企业微信自建应用（免费、稳定，微信内经「微工作台」可收）
 *  - serverchan Server酱（一个 SendKey 即发微信，免费版每日条数有限）
 *  - pushplus  PushPlus（关注公众号即收，免费版有限额）
 *  - webhook   通用 JSON Webhook（钉钉/飞书自定义机器人按其报文格式自动适配）
 *
 * 所有发送均为尽力而为（fire-and-forget）：失败只记日志，绝不影响主业务。
 */

export interface PushMessage {
  title: string;
  /** 支持 markdown 的正文 */
  text: string;
}

// ---------- 企业微信 access_token 缓存（内存级，7200s 有效期，提前 200s 刷新） ----------
let wecomToken: { value: string; expiresAt: number } | null = null;

async function getWecomToken(): Promise<string> {
  const { corpid, secret } = config.notify.wecom;
  if (wecomToken && wecomToken.expiresAt > Date.now()) return wecomToken.value;

  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(secret)}`;
  const res = await fetch(url, { method: 'GET' });
  const data = (await res.json()) as { errcode: number; access_token?: string; expires_in?: number; errmsg?: string };
  if (data.errcode !== 0 || !data.access_token) {
    // token 失效时清缓存，下次强制重新获取
    wecomToken = null;
    throw new Error(`企业微信获取 access_token 失败: errcode=${data.errcode} errmsg=${data.errmsg ?? ''}`);
  }
  wecomToken = {
    value: data.access_token,
    expiresAt: Date.now() + ((data.expires_in ?? 7200) - 200) * 1000,
  };
  return wecomToken.value;
}

/** 将 markdown 正文转为纯文本（微信端「微工作台」不支持 markdown 消息类型，只支持 text）。 */
function markdownToPlain(md: string): string {
  return md
    .replace(/^#{1,6}\s*/gm, '') // 标题井号
    .replace(/\*\*/g, '') // 粗体
    .replace(/`([^`]*)`/g, '$1') // 行内代码
    .replace(/^\s*[-*]\s+/gm, '· '); // 列表符
}

async function sendWecom(msg: PushMessage): Promise<void> {
  const token = await getWecomToken();
  const { agentid, touser } = config.notify.wecom;
  // 用 text 而非 markdown：markdown 在微信「微工作台」中显示“暂不支持此消息类型”
  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser,
      msgtype: 'text',
      agentid,
      text: { content: `${msg.title}\n${markdownToPlain(msg.text)}` },
    }),
  });
  const data = (await res.json()) as { errcode: number; errmsg?: string };
  if (data.errcode !== 0) {
    // 40014/42001 = access_token 失效，清缓存以便下次重取
    if (data.errcode === 40014 || data.errcode === 42001) wecomToken = null;
    throw new Error(`企业微信推送失败: errcode=${data.errcode} errmsg=${data.errmsg ?? ''}`);
  }
}

async function sendServerChan(msg: PushMessage): Promise<void> {
  const key = config.notify.serverchan.sendkey;
  const body = new URLSearchParams({ title: msg.title, desp: msg.text });
  const res = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = (await res.json()) as { code: number; message?: string };
  if (data.code !== 0) throw new Error(`Server酱推送失败: code=${data.code} message=${data.message ?? ''}`);
}

async function sendPushPlus(msg: PushMessage): Promise<void> {
  const res = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: config.notify.pushplus.token,
      title: msg.title,
      content: msg.text,
      template: 'markdown',
    }),
  });
  const data = (await res.json()) as { code: number; msg?: string };
  if (data.code !== 200) throw new Error(`PushPlus 推送失败: code=${data.code} msg=${data.msg ?? ''}`);
}

/** 通用 Webhook：按 URL 特征适配钉钉/飞书自定义机器人，其余按 {title, text} JSON 投递。 */
async function sendWebhook(msg: PushMessage): Promise<void> {
  const url = config.notify.webhook.url;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  let body: string;
  if (url.includes('dingtalk')) {
    // 钉钉自定义机器人（markdown 消息）
    body = JSON.stringify({ msgtype: 'markdown', markdown: { title: msg.title, text: `## ${msg.title}\n${msg.text}` } });
  } else if (url.includes('feishu') || url.includes('larksuite')) {
    // 飞书自定义机器人（post 富文本）
    body = JSON.stringify({ msg_type: 'text', content: { text: `${msg.title}\n${msg.text}` } });
  } else {
    // 通用格式
    body = JSON.stringify({ title: msg.title, text: msg.text });
  }

  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`Webhook 推送失败: HTTP ${res.status}`);
}

/** 对外入口：按 NOTIFY_CHANNEL 配置投递消息，返回是否成功（由调用方决定是否关心）。 */
export async function pushMessage(msg: PushMessage): Promise<boolean> {
  if (!config.notify.enabled) return false;
  try {
    switch (config.notify.channel) {
      case 'wecom':
        await sendWecom(msg);
        break;
      case 'serverchan':
        await sendServerChan(msg);
        break;
      case 'pushplus':
        await sendPushPlus(msg);
        break;
      case 'webhook':
        await sendWebhook(msg);
        break;
      default:
        logger.warn({ channel: config.notify.channel }, '未知的推送渠道，消息未发送');
        return false;
    }
    logger.info({ channel: config.notify.channel, title: msg.title }, '推送成功');
    return true;
  } catch (e) {
    logger.error({ err: e, channel: config.notify.channel, title: msg.title }, '推送失败');
    return false;
  }
}
