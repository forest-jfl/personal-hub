import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate';
import { verifyCredentials } from '../services/auth.service';
import { findById, toPublicUser } from '../repositories/user.repo';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
});

router.post('/login', validateBody(loginSchema), async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const user = await verifyCredentials(username, password);
    if (!user) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    res.json({ user: toPublicUser(user) });
  } catch (e) {
    next(e);
  }
});

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
    if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
    res.json({ user: toPublicUser(user) });
  } catch (e) {
    next(e);
  }
});

export default router;
