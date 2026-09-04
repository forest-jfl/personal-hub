import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';

const STATE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * 安全响应头（轻量版 helmet）。
 * 注意 CSP 允许 'unsafe-inline'（页面为零构建内联脚本）与 jsdelivr（编辑器 marked CDN）。
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https: http:; " +
      'object-src \'none\'; base-uri \'self\'; frame-ancestors \'none\''
  );
  next();
}

/**
 * CSRF 防护：对写操作校验 Origin 头。
 * 浏览器跨站请求必带 Origin；同源或在 CORS 白名单内才放行。
 * 无 Origin（curl/服务间调用）放行，由会话与限速兜底。
 */
export function csrfOriginCheck(req: Request, res: Response, next: NextFunction) {
  if (!STATE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  const host = req.headers.host || '';
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = '';
  }
  if (originHost && originHost === host) return next();
  if (config.corsOrigins.includes(origin)) return next();
  logger.warn({ origin, host, path: req.originalUrl }, '已拦截跨站写请求（CSRF）');
  return res.status(403).json({ error: 'BAD_ORIGIN' });
}

/** 简单内存限速器（单实例部署足够；键：IP + 桶名）。 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(opts: { windowMs: number; max: number; name: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${opts.name}:${ip}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > opts.max) {
      const retrySec = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retrySec));
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS' });
    }
    next();
  };
}

// 定期清理过期桶，防止 Map 无限增长
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}, 10 * 60 * 1000).unref();
