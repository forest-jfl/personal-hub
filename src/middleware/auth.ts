import { Request, Response, NextFunction } from 'express';

/** 要求已登录：API 返回 401，页面重定向到 /login。 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'UNAUTHENTICATED' });
    }
    return res.redirect('/login');
  }
  next();
}

/** 要求管理员角色。 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'UNAUTHENTICATED' });
  }
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  next();
}
