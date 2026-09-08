import { execFile } from 'child_process';
import os from 'os';
import { promisify } from 'util';
import { pool } from '../../db/connection';
import { logger } from '../../utils/logger';

const execFileAsync = promisify(execFile);

export interface CommandContext {
  userId: number;
  username: string;
  ip: string;
}

export interface CommandDef {
  name: string;
  desc: string;
  usage?: string;
  handler(args: string[], ctx: CommandContext): Promise<string>;
}

/**
 * 远程控制命令注册表（白名单机制的核心）。
 *
 * 安全约束：
 *  - 只允许在此登记的命令被执行，客户端无法调用未登记能力；
 *  - 系统类命令一律 execFile + 固定参数模板，客户端传入的 args
 *    仅允许落入受控位置（如日志行数），绝不拼接进 shell 字符串；
 *  - 新增运维命令（重启服务、清理缓存等）只需在此追加 handler，
 *    鉴权 / 审计 / 限速 / 截断由上层统一处理。
 */
const registry = new Map<string, CommandDef>();

function register(def: CommandDef): void {
  registry.set(def.name, def);
}

/** 只执行一次的最小化 shell 命令封装：固定二进制 + 固定参数模板。 */
async function runFixed(bin: string, argv: string[]): Promise<string> {
  const { stdout } = await execFileAsync(bin, argv, { timeout: 10_000, maxBuffer: 1024 * 1024 });
  return stdout.toString().trim() || '(无输出)';
}

// ---- 帮助 ----
register({
  name: 'help',
  desc: '列出全部可用命令',
  async handler() {
    const lines = [...registry.values()].map((c) => `  ${c.usage || c.name.padEnd(12)} ${c.desc}`);
    return ['可用命令：', ...lines].join('\n');
  },
});

// ---- 连通性 ----
register({
  name: 'ping',
  desc: '连通性测试',
  async handler() {
    return `pong (server time ${new Date().toISOString()})`;
  },
});

// ---- 系统状态 ----
register({
  name: 'status',
  desc: '主机与进程状态（负载 / 内存 / 运行时长）',
  async handler() {
    const totalMB = Math.round(os.totalmem() / 1048576);
    const freeMB = Math.round(os.freemem() / 1048576);
    const load = os.loadavg().map((n) => n.toFixed(2)).join(' / ');
    const fmtUptime = (s: number) => {
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      return `${d}天${h}时${m}分`;
    };
    return [
      `主机名    : ${os.hostname()}`,
      `平台      : ${os.platform()} ${os.arch()} (${os.type()} ${os.release()})`,
      `系统负载  : ${load}`,
      `内存      : 已用 ${(totalMB - freeMB)} MB / 共 ${totalMB} MB`,
      `系统运行  : ${fmtUptime(os.uptime())}`,
      `本进程运行: ${fmtUptime(process.uptime())} (Node ${process.version}, pid ${process.pid})`,
    ].join('\n');
  },
});

// ---- 磁盘 ----
register({
  name: 'disk',
  desc: '磁盘使用情况 (df -h)',
  async handler() {
    try {
      return await runFixed('df', ['-h']);
    } catch {
      return 'df 命令不可用（当前环境可能非 Linux 或缺少该工具）';
    }
  },
});

// ---- 容器 ----
register({
  name: 'docker',
  desc: 'Docker 容器列表 (docker ps)',
  async handler() {
    try {
      return await runFixed('docker', [
        'ps',
        '--format',
        'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}',
      ]);
    } catch {
      return 'docker 不可用（容器内通常无 docker CLI，可在宿主机执行）';
    }
  },
});

// ---- 应用统计 ----
register({
  name: 'stats',
  desc: '应用数据统计（用户 / 文章 / 文件）',
  async handler() {
    const [rows] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM posts) AS posts,
         (SELECT COUNT(*) FROM files) AS files,
         (SELECT COALESCE(SUM(size), 0) FROM files) AS file_bytes`
    );
    const r = (rows as Array<Record<string, unknown>>)[0] || {};
    return [
      `用户: ${r.users}`,
      `文章: ${r.posts}`,
      `文件: ${r.files} 个，共 ${Number(r.file_bytes || 0) / 1048576 >= 1
        ? (Number(r.file_bytes) / 1048576).toFixed(1) + ' MB'
        : (Number(r.file_bytes) / 1024).toFixed(1) + ' KB'}`,
    ].join('\n');
  },
});

// ---- 活跃会话 ----
register({
  name: 'sessions',
  desc: '当前活跃会话数',
  async handler() {
    try {
      // express-mysql-session 默认把 expires 存为 Unix 秒级时间戳（整数），
      // 须用 UNIX_TIMESTAMP() 比较，不能用 NOW()（datetime 比较恒为 0）
      const [rows] = await pool.query(
        'SELECT COUNT(*) AS n FROM sessions WHERE expires > UNIX_TIMESTAMP()'
      );
      const n = (rows as Array<{ n: number }>)[0]?.n ?? 0;
      return `当前活跃会话：${n} 个`;
    } catch (e) {
      logger.debug({ err: e }, 'sessions 命令查询失败');
      return '会话表不可查询（sessions 表由 express-mysql-session 维护）';
    }
  },
});

// ---- 命令审计 ----
register({
  name: 'audit',
  desc: '查看最近 N 条远程命令审计记录',
  usage: 'audit [n]',
  async handler(args) {
    let n = parseInt(args[0] || '10', 10);
    if (!Number.isFinite(n) || n <= 0) n = 10;
    if (n > 100) n = 100;
    const [rows] = await pool.query(
      'SELECT username, command, args, ok, ip, created_at FROM remote_cmd_log ORDER BY id DESC LIMIT ?',
      [n]
    );
    const list = rows as Array<{
      username: string;
      command: string;
      args: string;
      ok: number;
      ip: string;
      created_at: Date | string;
    }>;
    if (list.length === 0) return '暂无审计记录';
    return list
      .map(
        (r) =>
          `[${new Date(r.created_at).toLocaleString('zh-CN')}] ${r.username}@${r.ip} ` +
          `${r.command}${r.args ? ' ' + r.args : ''} → ${r.ok ? 'OK' : 'FAIL'}`
      )
      .join('\n');
  },
});

/** 取全部命令定义（供 help / REST 列表使用）。 */
export function listCommands(): Array<{ name: string; desc: string; usage?: string }> {
  return [...registry.values()].map(({ name, desc, usage }) => ({ name, desc, usage }));
}

/** 取单个命令定义；未登记返回 null。 */
export function getCommand(name: string): CommandDef | null {
  return registry.get(name) || null;
}
