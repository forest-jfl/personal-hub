import { Writable } from 'stream';
import pino, { multistream } from 'pino';
import pretty from 'pino-pretty';
import { config } from '../config';

/** 内存环形日志缓冲：保留最近 N 行原始 JSON 日志行，供远程 logs 命令读取。 */
const RING_CAPACITY = 2000;
const ring: string[] = [];

const ringStream = new Writable({
  write(chunk: unknown, _enc, cb) {
    const text = String(chunk);
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      ring.push(l);
      if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
    }
    cb();
  },
});

/**
 * 双路输出：stdout（开发环境经 pino-pretty 着色）+ 内存环形缓冲。
 * 用 multistream 而非 transport，保证 ring 拿到原始 JSON 行，
 * 同时避免 transport worker 线程输出绕过主进程流。
 */
const streams = config.env === 'production'
  ? [
      { stream: process.stdout, level: 'info' as const },
      { stream: ringStream, level: 'info' as const },
    ]
  : [
      {
        stream: pretty({
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        }),
        level: 'debug' as const,
      },
      { stream: ringStream, level: 'info' as const },
    ];

export const logger = pino({ level: config.env === 'production' ? 'info' : 'debug' }, multistream(streams));

/** 取最近 n 条日志；按需把 JSON 行解析成可读格式。 */
export function recentLogs(n: number): string[] {
  const lines = ring.slice(-Math.max(1, Math.min(n, RING_CAPACITY)));
  return lines.map((line) => {
    try {
      const o = JSON.parse(line);
      const time = new Date(o.time).toLocaleString('zh-CN');
      const level = ({ 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' } as Record<number, string>)[o.level] || String(o.level);
      const extra = Object.keys(o)
        .filter((k) => !['time', 'level', 'msg', 'pid', 'hostname'].includes(k))
        .map((k) => `${k}=${typeof o[k] === 'object' ? JSON.stringify(o[k]) : o[k]}`)
        .join(' ');
      return `[${time}] ${level}: ${o.msg}${extra ? ' {' + extra + '}' : ''}`;
    } catch {
      return line; // 非 JSON 行原样返回
    }
  });
}
