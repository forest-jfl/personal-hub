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
  /**
   * 显式声明「库里的 DATETIME 是什么口径」，不要交给驱动的默认值 `'local'`。
   *
   * 库内时间列全是 DATETIME：写进去的是**业务时区的墙上时间字符串**（由
   * `dbDateTimeInTz` 生成），读出来时驱动必须按同一口径还原成绝对时刻，否则
   * 拿到的 Date 会整体偏 8 小时 —— 而这个偏差不会报错，只会在 API 返回的
   * ISO 时间上悄悄体现。
   *
   * 默认值 `'local'` 意味着「取决于进程 TZ 环境变量」：TZ 一旦丢失，读出的
   * 绝对时刻立刻错 8 小时。固定偏移把这个隐式条件消掉。
   * 中国自 1991 年起无夏令时，故 `+08:00` 与 IANA 名 `Asia/Shanghai` 等价。
   */
  timezone: config.db.timezoneOffset,
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

/** 关闭连接池（CLI 等短生命周期入口用，避免进程挂住不退出）。 */
export async function closePool(): Promise<void> {
  await pool.end();
}
