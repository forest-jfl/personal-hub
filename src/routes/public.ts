import { Router } from 'express';
import { marked } from 'marked';
import { HttpError } from '../middleware/error';
import * as posts from '../repositories/post.repo';
import { Post } from '../models/types';

const router = Router();

/** 将 markdown 内容渲染为 HTML 一并返回（个人博客内容由可信用户撰写）。 */
function render(post: Post) {
  return { ...post, html: String(marked.parse(post.content || '')) };
}

router.get('/posts', async (_req, res, next) => {
  try {
    const list = await posts.listPosts({ status: 'published' });
    res.json({ posts: list.map(render) });
  } catch (e) {
    next(e);
  }
});

router.get('/posts/:slug', async (req, res, next) => {
  try {
    const post = await posts.getPostBySlug(req.params.slug);
    if (!post || post.status !== 'published') throw new HttpError(404, 'POST_NOT_FOUND');
    res.json({ post: render(post) });
  } catch (e) {
    next(e);
  }
});

export default router;
