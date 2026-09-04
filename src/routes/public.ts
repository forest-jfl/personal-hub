import { Router } from 'express';
import { marked } from 'marked';
import { HttpError } from '../middleware/error';
import * as posts from '../repositories/post.repo';

const router = Router();

/** 将 markdown 内容渲染为 HTML 一并返回（个人博客内容由可信用户撰写）。 */
function render(post: { content: string }) {
  return { ...post, html: String(marked.parse(post.content || '')) };
}

/**
 * 已发布文章列表（公开）。
 * 查询参数：page / pageSize / category / q（标题搜索）
 */
router.get('/posts', async (req, res, next) => {
  try {
    const page = parseInt(String(req.query.page || '1'), 10) || 1;
    const pageSize = parseInt(String(req.query.pageSize || '10'), 10) || 10;
    const category = String(req.query.category || '').trim();
    const q = String(req.query.q || '').trim();
    const result = (await posts.listPosts({
      status: 'published',
      page,
      pageSize,
      category: category || undefined,
      q: q || undefined,
    })) as posts.PageResult;
    res.json({
      posts: result.posts.map((p) => ({
        id: p.id,
        title: p.title,
        slug: p.slug,
        category: p.category,
        views: p.views,
        author_name: p.author_name,
        created_at: p.created_at,
        updated_at: p.updated_at,
        summary: String(p.content || '')
          .replace(/[#>*`\-\[\]!]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120),
      })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  } catch (e) {
    next(e);
  }
});

/** 侧边栏元数据：分类统计 / 归档 / 热门文章。 */
router.get('/meta', async (_req, res, next) => {
  try {
    res.json(await posts.getBlogMeta());
  } catch (e) {
    next(e);
  }
});

router.get('/posts/:slug', async (req, res, next) => {
  try {
    const post = await posts.getPostBySlug(req.params.slug);
    if (!post || post.status !== 'published') throw new HttpError(404, 'POST_NOT_FOUND');
    await posts.incrementViews(post.id);
    res.json({ post: render(post) });
  } catch (e) {
    next(e);
  }
});

export default router;
