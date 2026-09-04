import { Request, Response, NextFunction } from 'express';
import { findById } from '../repositories/user.repo';

/** 未登录时的统一响应：API 返回 401，页面重定向到 /login。 */
function unauthorized(req: Request, res: Response) {
  // 挂载在 /api 下的路由 req.path 是相对路径，须用 originalUrl 判断
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'UNAUTHENTICATED' });
  }
  return res.redirect('/login');
}

/** 要求已登录；同时校验用户当前状态，账号被停用立即踢出会话。 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return unauthorized(req, res);
  }
  try {
    const user = await findById(req.session.userId);
    if (!user || user.status === 'disabled') {
      return req.session.destroy(() => unauthorized(req, res));
    }
    next();
  } catch (e) {
    next(e);
  }
}

/** 要求管理员角色；同样校验停用状态。 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'UNAUTHENTICATED' });
  }
  try {
    const user = await findById(req.session.userId);
    if (!user || user.status === 'disabled') {
      return req.session.destroy(() => res.status(401).json({ error: 'UNAUTHENTICATED' }));
    }
    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }
    next();
  } catch (e) {
    next(e);
  }
}
