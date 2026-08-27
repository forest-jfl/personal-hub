import http from 'http';
import fs from 'fs';
import path from 'path';
import { createApp } from './app';
import { config } from './config';
import { logger } from './utils/logger';
import { testConnection } from './db/connection';
import { runMigrations } from './db/migrate';

async function main() {
  // 1) 校验数据库连通性
  try {
    await testConnection();
  } catch (e) {
    logger.error({ err: e }, '无法连接数据库，请检查 .env 中的 DB_* 配置以及 MySQL/MariaDB 是否运行');
    process.exit(1);
  }

  // 2) 建表 + 播种管理员
  await runMigrations();

  // 3) 确保上传目录存在
  fs.mkdirSync(path.resolve(config.upload.dir), { recursive: true });

  // 4) 启动 HTTP 服务
  const app = createApp();
  const server = http.createServer(app);
  server.listen(config.port, config.host, () => {
    logger.info(`Personal Hub 已启动: http://${config.host}:${config.port} (env=${config.env})`);
  });

  const shutdown = () => {
    logger.info('正在关闭...');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error({ err: e }, '启动失败');
  process.exit(1);
});
