import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { HttpError } from '../middleware/error';
import {
  createUser,
  listUsers,
  deleteUser,
  countAdmins,
  findById,
  findByUsername,
} from '../repositories/user.repo';
import { hashPassword } from '../services/auth.service';

const router = Router();
router.use(requireAdmin);

const createSchema = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(6).max(200),
  display_name: z.string().max(128).optional().default(''),
  role: z.enum(['admin', 'user']).default('user'),
});

router.get('/', async (_req, res, next) => {
  try {
    res.json({ users: await listUsers() });
  } catch (e) {
    next(e);
  }
});

router.post('/', validateBody(createSchema), async (req, res, next) => {
  try {
    const { username, password, display_name, role } = req.body;
    if (await findByUsername(username)) throw new HttpError(409, 'USERNAME_EXISTS');
    const hash = await hashPassword(password);
    const user = await createUser({
      username,
      display_name: display_name || username,
      password_hash: hash,
      role,
    });
    res.status(201).json({ user });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (req.session!.userId === id) throw new HttpError(400, 'CANNOT_DELETE_SELF');
    const target = await findById(id);
    if (target?.role === 'admin') {
      const admins = await countAdmins();
      if (admins <= 1) throw new HttpError(400, 'CANNOT_DELETE_LAST_ADMIN');
    }
    await deleteUser(id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
