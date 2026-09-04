import express, { Express } from 'express';
import session from 'express-session';
import MySQLStore from 'express-mysql-session';
import path from 'path';
import { config } from './config';
import { logger } from './utils/logger';
import healthRouter from './routes/health';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import postsRouter from './routes/posts';
import filesRouter from './routes/files';
import publicRouter from './routes/public';
import { requireAuth } from './middleware/auth';
import { securityHeaders, csrfOriginCheck } from './middleware/security';
import { errorHandler, notFound } from './middleware/error';
// 显式引入 session 类型扩展（ts-node 按需编译不会自动加载未引用的声明文件）
import './types/session-augment';

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

  // 页面路由
  const publicDir = path.resolve(__dirname, '..', 'public');

  // 静态资源（assets/style.css、assets/api.js、config.js 等）
  app.use(express.static(publicDir, { index: false }));

  // 博客主页（应用主入口）
  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // 文章详情 / 写作编辑
  app.get('/post', (_req, res) => res.sendFile(path.join(publicDir, 'post.html')));
  app.get('/editor', requireAuth, (_req, res) => res.sendFile(path.join(publicDir, 'editor.html')));

  // 登录页
  app.get('/login', (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));

  // 管理控制台（隐藏入口：仅头像下拉菜单可达；未登录跳登录）
  app.get('/console', requireAuth, (_req, res) => {
    res.sendFile(path.join(publicDir, 'console.html'));
  });

  // 兼容旧链接
  app.get(['/blog', '/app', '/files', '/posts', '/admin'], (_req, res) => {
    res.redirect('/');
  });

  app.use(notFound);
  app.use(errorHandler);

  logger.debug('Express 应用已装配');
  return app;
}
