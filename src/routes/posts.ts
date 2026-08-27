import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { HttpError } from '../middleware/error';
import * as posts from '../repositories/post.repo';

const router = Router();
router.use(requireAuth);

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'post';
}

const createSchema = z.object({
  title: z.string().min(1).max(255),
  content: z.string().max(100000).default(''),
  status: z.enum(['draft', 'published']).default('draft'),
  slug: z.string().max(255).optional(),
});

router.get('/', async (req, res, next) => {
  try {
    // 管理员可见全部，普通用户仅见自己的
    const filter = req.session!.role === 'admin' ? {} : { author_id: req.session!.userId };
    res.json({ posts: await posts.listPosts(filter) });
  } catch (e) {
    next(e);
  }
});

router.post('/', validateBody(createSchema), async (req, res, next) => {
  try {
    const { title, content, status, slug } = req.body;
    const base = slug || slugify(title);
    let candidate = base;
    let n = 1;
    while (await posts.getPostBySlug(candidate)) {
      candidate = `${base}-${n++}`;
    }
    const post = await posts.createPost({
      title,
      content,
      status,
      slug: candidate,
      author_id: req.session!.userId!,
    });
    res.status(201).json({ post });
  } catch (e) {
    next(e);
  }
});

router.put('/:id', validateBody(createSchema.partial()), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await posts.getPostById(id);
    if (!existing) throw new HttpError(404, 'POST_NOT_FOUND');
    if (existing.author_id !== req.session!.userId && req.session!.role !== 'admin')
      throw new HttpError(403, 'FORBIDDEN');
    const updated = await posts.updatePost(id, req.body);
    res.json({ post: updated });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await posts.getPostById(id);
    if (!existing) throw new HttpError(404, 'POST_NOT_FOUND');
    if (existing.author_id !== req.session!.userId && req.session!.role !== 'admin')
      throw new HttpError(403, 'FORBIDDEN');
    await posts.deletePost(id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
