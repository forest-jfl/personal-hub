import { Router } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * 企业微信「接收消息服务器 URL」回调验证接口。
 *
 * 用途：企业微信后台要求先配置接收消息 URL（或可信域名）后才能设置企业可信 IP。
 * 个人博客域名通常无 ICP 备案，可信域名路线走不通，故实现本回调接口：
 *  - GET  /api/wecom/callback：URL 有效性验证（验签 + 解密 echostr 原样返回）
 *  - POST /api/wecom/callback：后续消息推送的应答（验签后返回 success）
 *
 * 配置项（.env）：
 *  - NOTIFY_WECOM_TOKEN  后台「接收消息」页填写的 Token
 *  - NOTIFY_WECOM_AESKEY 后台生成的 EncodingAESKey（43 位）
 */

const router = Router();

function callbackConf() {
  const { corpid } = config.notify.wecom;
  const token = config.notify.wecom.callbackToken;
  const aeskey = config.notify.wecom.callbackAeskey;
  return { corpid, token, aeskey };
}

/** 企业微信签名：sha1(字典序拼接(token, timestamp, nonce, encrypt))。 */
function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return crypto.createHash('sha1').update([token, timestamp, nonce, encrypt].sort().join('')).digest('hex');
}

/**
 * 解密企业微信报文：AES-256-CBC，key=Base64Decode(AESKey+'=")，iv=key 前 16 字节。
 * 明文结构：random(16B) + msg_len(4B 大端) + msg + corpid。
 */
function wecomDecrypt(encryptBase64: string, aeskey: string, corpid: string): string {
  const key = Buffer.from(aeskey + '=', 'base64');
  if (key.length !== 32) throw new Error('EncodingAESKey 非法（Base64 解码后须为 32 字节）');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const dec = Buffer.concat([decipher.update(Buffer.from(encryptBase64, 'base64')), decipher.final()]);
  const msgLen = dec.readUInt32BE(16);
  const msg = dec.subarray(20, 20 + msgLen).toString('utf8');
  const fromCorp = dec.subarray(20 + msgLen).toString('utf8');
  if (corpid && fromCorp !== corpid) throw new Error('corpid 校验失败');
  return msg;
}

/** 从企业微信 XML 报文中提取 <Encrypt> 字段（仅解析单层CDATA，不做完整 XML 处理）。 */
function extractEncrypt(xml: string): string {
  const m = /<Encrypt>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/Encrypt>/.exec(xml);
  if (!m) throw new Error('报文中未找到 Encrypt 字段');
  return m[1];
}

// GET：后台保存「接收消息服务器URL」时的验证请求
router.get('/callback', (req, res) => {
  const { msg_signature, timestamp, nonce, echostr } = req.query as Record<string, string>;
  const { token, aeskey, corpid } = callbackConf();
  if (!token || !aeskey) {
    logger.warn('企业微信回调验证被拒绝：NOTIFY_WECOM_TOKEN / NOTIFY_WECOM_AESKEY 未配置');
    return res.status(503).send('callback not configured');
  }
  try {
    if (wecomSignature(token, timestamp, nonce, echostr) !== msg_signature) {
      return res.status(403).send('signature mismatch');
    }
    // 验签通过后解密 echostr 并原样返回明文
    res.send(wecomDecrypt(echostr, aeskey, corpid));
  } catch (e) {
    logger.error({ err: e }, '企业微信回调验证失败');
    res.status(500).send('verify failed');
  }
});

// POST：后续消息/事件推送（当前仅需应答 success 以保持配置有效）
router.post('/callback', (req, res) => {
  const { msg_signature, timestamp, nonce } = req.query as Record<string, string>;
  const { token, aeskey, corpid } = callbackConf();
  try {
    const encrypt = extractEncrypt(typeof req.body === 'string' ? req.body : '');
    if (wecomSignature(token, timestamp, nonce, encrypt) !== msg_signature) {
      return res.status(403).send('signature mismatch');
    }
    wecomDecrypt(encrypt, aeskey, corpid); // 校验报文完整性
    res.send('success');
  } catch (e) {
    logger.error({ err: e }, '企业微信消息推送处理失败');
    res.status(500).send('error');
  }
});

export default router;
