import express, { Express } from 'express';
import session from 'express-session';
import MySQLStore from 'express-mysql-session';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { logger } from './utils/logger';
import { computeAssetVersion, injectAssetVersion } from './utils/asset-version';
import healthRouter from './routes/health';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import postsRouter from './routes/posts';
import filesRouter from './routes/files';
import publicRouter from './routes/public';
import wecomCallbackRouter from './routes/wecom-callback';
import remoteRouter from './routes/remote';
import feedRouter from './routes/feed';
import { requireAuth } from './middleware/auth';
import { securityHeaders, csrfOriginCheck } from './middleware/security';
import { errorHandler, notFound } from './middleware/error';
// 显式引入 session 类型扩展（ts-node 按需编译不会自动加载未引用的声明文件）
import './types/session-augment';

/** 由本应用托管的 HTML 页面（直连 `.html` 时也要走版本注入，不能被静态托管抢先）。 */
const PAGE_FILES = ['index.html', 'post.html', 'editor.html', 'login.html', 'console.html', 'gallery.html'];

export function createApp(): Express {
  const app = express();

  // 置于 Nginx 之后，信任第一跳代理以正确获取客户端 IP
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 安全响应头（CSP / nosniff / 禁iframe 等）
  app.use(securityHeaders);
  // CSRF 防护：写操作校验 Origin（同源或 CORS 白名单）
  app.use(csrfOriginCheck);

  // CORS：前端托管在 git 平台时，通过 CORS_ORIGINS 白名单允许跨域调用 API
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // 会话存储：express-mysql-session 自动建 sessions 表
  const MySQLSessionStore = MySQLStore(session);
  const sessionStore = new MySQLSessionStore({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.name,
    createDatabaseTable: true,
  });

  app.use(
    session({
      secret: config.session.secret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: config.session.secure,
        // 跨站托管前端时 Cookie 须 SameSite=None（同时要求 secure=true）
        sameSite: config.session.crossSite ? 'none' : 'lax',
        maxAge: config.session.maxAge,
      },
    })
  );

  // API 路由
  app.use('/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/posts', postsRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/public', publicRouter);
  // 企业微信「接收消息服务器URL」回调验证（设置企业可信IP的前置要求）
  app.use('/api/wecom', wecomCallbackRouter);
  // 远程控制 REST（票据签发 / 命令清单 / 审计查询，均仅管理员）
  app.use('/api/remote', remoteRouter);
  // 每日抓取管理（状态查询 / 手动触发，均仅管理员）
  app.use('/api/feed', feedRouter);

  // ---------- 页面路由 ----------
  const publicDir = path.resolve(__dirname, '..', 'public');
  // 资源版本指纹（见 utils/asset-version.ts）：拼进 URL 后缓存层必然回源，
  // 解决「HTML 已更新、JS 仍在 CF 4 小时缓存里」导致的 is not a function
  const assetVersion = computeAssetVersion(publicDir);

  /** 发 HTML 页面：注入资源版本参数，并让页面本身不缓存。 */
  function sendPage(res: express.Response, file: string): void {
    let html: string;
    try {
      html = fs.readFileSync(path.join(publicDir, file), 'utf8');
    } catch (e) {
      logger.error({ err: e, file }, '页面文件读取失败');
      res.status(500).type('text').send('页面加载失败');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(injectAssetVersion(html, assetVersion));
  }

  // 直连 `.html` 的请求也必须走注入版（否则 express.static 会吐出未注入的原件）
  app.use((req, res, next) => {
    if (req.method !== 'GET' || !req.path.endsWith('.html')) return next();
    const name = path.basename(req.path);
    if (PAGE_FILES.includes(name)) return sendPage(res, name);
    return next();
  });

  // 静态资源（assets/style.css、assets/api.js、config.js 等）
  // 一律 no-cache：可缓存、但每次协商（有 ETag，常态 304，开销极低）。
  // 带版本参数的资源本可长缓存，但 max-age 会被 CF 按扩展名重写成 4 小时，
  // 所以正确性不依赖它 —— 由 URL 上的版本参数保证。
  app.use(express.static(publicDir, {
    index: false,
    setHeaders(res, filePath) {
      if (/\.(?:html|js|css|svg|woff2)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  // 博客主页（应用主入口）
  app.get('/', (_req, res) => sendPage(res, 'index.html'));

  // 文章详情 / 写作编辑
  app.get('/post', (_req, res) => sendPage(res, 'post.html'));
  app.get('/editor', requireAuth, (_req, res) => sendPage(res, 'editor.html'));

  // 登录页
  app.get('/login', (_req, res) => sendPage(res, 'login.html'));

  // 管理控制台（隐藏入口：仅头像下拉菜单可达；未登录跳登录）
  app.get('/console', requireAuth, (_req, res) => sendPage(res, 'console.html'));

  // 图片库（仅登录可见：列出的是本人上传的图片，属私有素材）
  app.get('/gallery', requireAuth, (_req, res) => sendPage(res, 'gallery.html'));

  // 兼容旧链接
  app.get(['/blog', '/app', '/files', '/posts', '/admin'], (_req, res) => {
    res.redirect('/');
  });

  app.use(notFound);
  app.use(errorHandler);

  logger.debug('Express 应用已装配');
  return app;
}
