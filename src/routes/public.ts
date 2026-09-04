import { Router, Request, Response, NextFunction } from 'express';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import path from 'path';
import fs from 'fs';
import { HttpError } from '../middleware/error';
import * as posts from '../repositories/post.repo';
import * as filesRepo from '../repositories/file.repo';
import { config } from '../config';

const router = Router();

/**
 * 将 markdown 渲染为 HTML 并做白名单净化。
 * 内容来自任意注册用户，必须防存储型 XSS。
 */
function render(post: { content: string }) {
  const raw = String(marked.parse(post.content || ''));
  const html = sanitizeHtml(raw, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'del', 'ins', 'sub', 'sup']),
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      th: ['align'],
      td: ['align'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }),
    },
  });
  return { ...post, html };
}

/**
 * 已发布文章列表（公开）。
 * 查询参数：page / pageSize / category / month（YYYY-MM 归档月）/ q（标题搜索）
 */
router.get('/posts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(String(req.query.page || '1'), 10) || 1;
    const pageSize = parseInt(String(req.query.pageSize || '10'), 10) || 10;
    const category = String(req.query.category || '').trim();
    const month = String(req.query.month || '').trim();
    const q = String(req.query.q || '').trim();
    const result = (await posts.listPosts({
      status: 'published',
      page,
      pageSize,
      category: category || undefined,
      month: /^\d{4}-\d{2}$/.test(month) ? month : undefined,
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

/**
 * 文件免登录访问（供文章内图片等公开引用）。
 * URL 含不可枚举的公开令牌：/api/public/files/:id/:token
 * HTML/SVG 一律强制下载，杜绝同源内联执行。
 */
router.get('/files/:id/:token', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{16,64}$/.test(token)) throw new HttpError(404, 'FILE_NOT_FOUND');
    const meta = await filesRepo.getFileByToken(id, token);
    if (!meta) throw new HttpError(404, 'FILE_NOT_FOUND');
    const filePath = path.resolve(config.upload.dir, meta.stored_name);
    if (!fs.existsSync(filePath)) throw new HttpError(404, 'FILE_MISSING');
    const inlineOk = /^(image\/(png|jpe?g|gif|webp|bmp|avif)|video\/|audio\/|application\/pdf)/.test(meta.mime);
    if (inlineOk) {
      res.setHeader('Content-Type', meta.mime);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.original_name)}`);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.download(filePath, meta.original_name);
    }
  } catch (e) {
    next(e);
  }
});

export default router;
