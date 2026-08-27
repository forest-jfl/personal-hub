import mysql from 'mysql2/promise';
import { config } from '../config';
import { logger } from '../utils/logger';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.name,
  connectionLimit: config.db.connectionLimit,
  charset: 'utf8mb4',
  waitForConnections: true,
  enableKeepAlive: true,
});

/** 启动时校验数据库连通性，连不上直接失败退出。 */
export async function testConnection(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
    logger.info('MySQL 连接成功');
  } finally {
    conn.release();
  }
}
