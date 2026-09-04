import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate';
import { rateLimit } from '../middleware/security';
import { verifyCredentials, hashPassword } from '../services/auth.service';
import {
  findById,
  findByUsername,
  createUser,
  updateUserPassword,
  toPublicUser,
} from '../repositories/user.repo';
import { requireAuth } from '../middleware/auth';
import { HttpError } from '../middleware/error';
import { config } from '../config';
import { logger } from '../utils/logger';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
});

// 自主注册：用户名仅限字母/数字/下划线/连字符，密码至少 8 位
const registerSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_-]{2,32}$/, '用户名须为 2-32 位字母、数字、下划线或连字符'),
  password: z.string().min(8, '密码至少 8 位').max(200),
  display_name: z.string().max(32).optional().default(''),
});

const changePasswordSchema = z.object({
  old_password: z.string().min(1).max(200),
  new_password: z.string().min(8, '新密码至少 8 位').max(200),
});

/** 登录（带限速：每 IP 每分钟最多 10 次，防暴力破解）。 */
router.post(
  '/login',
  rateLimit({ windowMs: 60 * 1000, max: 10, name: 'login' }),
  validateBody(loginSchema),
  async (req, res, next) => {
    try {
      const { username, password } = req.body;
      const user = await verifyCredentials(username, password);
      if (!user) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
      if (user.status === 'disabled') {
        return res.status(403).json({ error: 'USER_DISABLED', message: '账号已被停用，请联系管理员' });
      }
      // 会话固定防护：登录成功后更换会话 ID
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        res.json({ user: toPublicUser(user) });
      });
    } catch (e) {
      next(e);
    }
  }
);

/** 自主注册（可用 REGISTER_ENABLED=false 关闭）。注册即登录。 */
router.post(
  '/register',
  rateLimit({ windowMs: 60 * 60 * 1000, max: 20, name: 'register' }),
  validateBody(registerSchema),
  async (req, res, next) => {
    try {
      if (!config.auth.allowRegister) {
        throw new HttpError(403, 'REGISTER_DISABLED');
      }
      const { username, password, display_name } = req.body;
      if (await findByUsername(username)) throw new HttpError(409, 'USERNAME_EXISTS');
      const hash = await hashPassword(password);
      const user = await createUser({
        username,
        display_name: display_name || username,
        password_hash: hash,
        role: 'user',
      });
      logger.info({ username }, '新用户注册');
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        res.status(201).json({ user: toPublicUser(user) });
      });
    } catch (e) {
      next(e);
    }
  }
);

/** 自主修改密码：验证旧密码后更新，成功后销毁会话要求重新登录。 */
router.post(
  '/change-password',
  rateLimit({ windowMs: 60 * 1000, max: 5, name: 'change-password' }),
  requireAuth,
  validateBody(changePasswordSchema),
  async (req, res, next) => {
    try {
      const user = await findById(req.session.userId!);
      if (!user) throw new HttpError(401, 'UNAUTHENTICATED');
      const ok = await verifyCredentials(user.username, req.body.old_password);
      if (!ok) throw new HttpError(400, 'WRONG_OLD_PASSWORD');
      const hash = await hashPassword(req.body.new_password);
      await updateUserPassword(user.id, hash);
      req.session.destroy(() => {
        res.json({ ok: true, message: '密码已修改，请重新登录' });
      });
    } catch (e) {
      next(e);
    }
  }
);

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/me', async (req, res, next) => {
  try {
    if (!req.session?.userId) return res.status(401).json({ error: 'UNAUTHENTICATED' });
    const user = await findById(req.session.userId);
    if (!user || user.status === 'disabled') return res.status(401).json({ error: 'UNAUTHENTICATED' });
    res.json({ user: toPublicUser(user) });
  } catch (e) {
    next(e);
  }
});

export default router;
