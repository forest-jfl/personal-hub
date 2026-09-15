/**
 * 封面地址的**唯一**校验口径。
 *
 * 抽成独立模块而不是写死在路由里，理由与 api-service 的 netutil/timeutil 相同：
 * 这种「规则本身」的东西一旦出现第二份，两份迟早会不一致，
 * 而不一致的那一份通常就是绕过点。
 *
 * 放行两种形态：
 *  · 站内图床 `/api/public/files/:id/:token` —— 编辑器上传后插入的就是这个形态，
 *    已带不可枚举令牌，可对外引用。
 *  · 外部 `https://…` 外链。**不接受 http**（会触发混合内容），
 *    也不接受 `data:`、`javascript:`、协议相对地址 `//host/x.png`。
 *
 * 为什么用正则而不是 `new URL()`：站内图床是相对路径，不是合法绝对 URL，
 * 走 URL 解析会把它判成非法；而这里真正要拦的是「协议」，正则更准。
 */
const SITE_BED = /^\/api\/public\/files\/\d+\/[a-f0-9]{16,64}$/;
const EXTERNAL_HTTPS = /^https:\/\/[^\s]+$/i;

/** 空串合法，表示「清空封面」。 */
export function isValidCover(value: string): boolean {
  return value === '' || SITE_BED.test(value) || EXTERNAL_HTTPS.test(value);
}

/**
 * 把封面地址规范成可直接用于 `<img src>` 的形态。
 * 目前只做「空串归零」，保留此函数是为了让前端拿到的永远是干净值，
 * 不必各自判断 undefined / null / 空白。
 */
export function normalizeCover(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
