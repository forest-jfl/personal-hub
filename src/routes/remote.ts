import { Router, Request, Response, NextFunction } from 'express';
import { requireAdmin } from '../middleware/auth';
import { rateLimit } from '../middleware/security';
import { issueTicket } from '../services/remote/tickets';
import { listCommands } from '../services/remote/registry';
import { config } from '../config';
import { pool } from '../db/connection';
import { findById } from '../repositories/user.repo';

const router = Router();

/**
 * 签发一次性 WebSocket 连接票据（仅管理员）。
 * 鉴权在此完成：能拿到票据 = 已通过会话 + admin 校验；
 * WS 握手阶段只验票据与 Origin，不再重复查库。
 */
router.post(
  '/token',
  requireAdmin,
  rateLimit({ windowMs: 60 * 1000, max: 10, name: 'remote-token' }),
  async (req: Request, res: Response, next: NextFunction) => {
    if (!config.remote.enabled) {
      return res.status(403).json({ error: 'REMOTE_CONTROL_DISABLED' });
    }
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ error: 'UNAUTHENTICATED' });
      const user = await findById(userId);
      if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const ticket = issueTicket(user.id, user.username, ip);
      res.json({ ticket, ttl: config.remote.ticketTtlSec, ws_path: '/ws/remote' });
    } catch (e) {
      next(e);
    }
  }
);

/** 可用命令清单（仅管理员）。 */
router.get('/commands', requireAdmin, (_req: Request, res: Response) => {
  res.json({ commands: listCommands() });
});

/** 最近审计记录（仅管理员）。 */
router.get('/history', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, username, command, args, ok, ip, created_at FROM remote_cmd_log ORDER BY id DESC LIMIT 50'
    );
    res.json({ history: rows });
  } catch (e) {
    next(e);
  }
});

export default router;
