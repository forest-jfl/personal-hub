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
import { errorHandler, notFound } from './middleware/error';

export function createApp(): Express {
  const app = express();

  // 置于 Nginx 之后，信任第一跳代理以正确获取客户端 IP
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

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
        sameSite: 'lax',
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

  app.get('/login', (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));

  // 公开博客阅读页
  app.get('/blog', (_req, res) => res.sendFile(path.join(publicDir, 'blog.html')));
  app.get('/blog/post', (_req, res) => res.sendFile(path.join(publicDir, 'post.html')));

  // 受保护的管理页（未登录跳登录）
  app.get(['/', '/app', '/files', '/posts', '/admin'], requireAuth, (_req, res) => {
    res.sendFile(path.join(publicDir, 'app.html'));
  });

  app.use(notFound);
  app.use(errorHandler);

  logger.debug('Express 应用已装配');
  return app;
}
