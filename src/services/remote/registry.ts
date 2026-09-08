import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { pool } from '../../db/connection';
import { logger, recentLogs } from '../../utils/logger';
import { config } from '../../config';

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

// ---- 应用日志 ----
register({
  name: 'logs',
  desc: '查看应用最近日志（内存环形缓冲，最多 2000 行）',
  usage: 'logs [n]',
  async handler(args) {
    let n = parseInt(args[0] || '30', 10);
    if (!Number.isFinite(n) || n <= 0) n = 30;
    if (n > 200) n = 200;
    const lines = recentLogs(n);
    if (lines.length === 0) return '暂无日志（环形缓冲为空）';
    return lines.join('\n');
  },
});

// ---- 生效配置 ----
register({
  name: 'env',
  desc: '查看当前生效配置（敏感项自动打码）',
  async handler() {
    const mask = (v: string) => (v ? '***（已设置）' : '（未设置）');
    return [
      `运行环境    : ${config.env}`,
      `监听        : ${config.host}:${config.port}`,
      `对外地址    : ${config.publicBaseUrl}`,
      `CORS 白名单 : ${config.corsOrigins.join(', ') || '（仅同源）'}`,
      `数据库      : ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.name} (密码 ${mask(config.db.password)})`,
      `会话        : maxAge=${Math.round(config.session.maxAge / 3600000)}h secure=${config.session.secure} crossSite=${config.session.crossSite} (secret ${mask(config.session.secret)})`,
      `上传目录    : ${config.upload.dir} · 配额 ${config.upload.quotaPerUserMB}MB/人 · 单文件 ≤ ${Math.round(config.upload.maxFileSize / 1048576)}MB`,
      `开放注册    : ${config.auth.allowRegister ? '开' : '关'} · 每 IP 上限 ${config.auth.maxAccountsPerIp}`,
      `登录通知    : ${config.notify.enabled ? `开 (${config.notify.channel})` : '关'} · 接收人 ${config.notify.wecom.touser} (corpid ${mask(config.notify.wecom.corpid)} secret ${mask(config.notify.wecom.secret)})`,
      `远程控制    : ${config.remote.enabled ? '开' : '关'} · 票据 TTL ${config.remote.ticketTtlSec}s`,
    ].join('\n');
  },
});

// ---- 上传目录 ----
register({
  name: 'uploads',
  desc: '上传目录统计（文件数 / 总大小 / 最大文件）',
  async handler() {
    const dir = path.resolve(config.upload.dir);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return `上传目录不可读：${dir}`;
    }
    let count = 0;
    let total = 0;
    let largest = { name: '', size: 0 };
    for (const name of names) {
      try {
        const st = fs.statSync(path.join(dir, name));
        if (!st.isFile()) continue;
        count += 1;
        total += st.size;
        if (st.size > largest.size) largest = { name, size: st.size };
      } catch {
        /* 跳过无法 stat 的项 */
      }
    }
    const fmt = (b: number) =>
      b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB'
        : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB'
        : (b / 1024).toFixed(1) + ' KB';
    if (count === 0) return `上传目录为空：${dir}`;
    return [
      `目录      : ${dir}`,
      `文件数    : ${count}`,
      `总大小    : ${fmt(total)} (配额 ${config.upload.quotaPerUserMB} MB/人)`,
      `最大文件  : ${largest.name || '-'} (${fmt(largest.size)})`,
    ].join('\n');
  },
});

// ---- 网络端口 ----
register({
  name: 'net',
  desc: '容器 TCP 连接状态（读 /proc/net，不依赖外部工具）',
  async handler() {
    const STATE: Record<string, string> = {
      '01': 'ESTABLISHED', '02': 'SYN_SENT', '03': 'SYN_RECV', '04': 'FIN_WAIT1',
      '05': 'FIN_WAIT2', '06': 'TIME_WAIT', '07': 'CLOSE', '08': 'CLOSE_WAIT',
      '09': 'LAST_ACK', '0A': 'LISTEN', '0B': 'CLOSING',
    };
    const decode = (file: string) => {
      try {
        return fs.readFileSync(file, 'utf8').trim().split('\n').slice(1);
      } catch {
        return [];
      }
    };
    const rows: Array<{ line: string; v6: boolean }> = [
      ...decode('/proc/net/tcp').map((line) => ({ line, v6: false })),
      ...decode('/proc/net/tcp6').map((line) => ({ line, v6: true })),
    ];
    if (rows.length === 0) return '/proc/net/tcp 不可读（当前环境可能非 Linux）';
    const byState = new Map<string, number>();
    const listeners: string[] = [];
    for (const { line, v6 } of rows) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const st = STATE[cols[3]] || cols[3];
      byState.set(st, (byState.get(st) || 0) + 1);
      if (cols[3] === '0A') {
        const [addr, portHex] = cols[1].split(':');
        // tcp6 地址为 32 位十六进制；全零或 IPv4 映射段视为回环/本机
        const isLocal =
          /^[0]+$/.test(addr) || addr.startsWith('0000000000000000FFFF');
        listeners.push(
          `${isLocal ? 'local' : addr.slice(-8)}:${parseInt(portHex, 16)} (${v6 ? 'tcp6' : 'tcp'})`
        );
      }
    }
    const stateLine = [...byState.entries()].map(([k, v]) => `${k}=${v}`).join(' · ');
    return [
      `连接状态分布: ${stateLine}`,
      `监听端口 (${listeners.length}):`,
      ...listeners.slice(0, 20).map((l) => `  ${l}`),
    ].join('\n');
  },
});

// ---- 数据库 ----
register({
  name: 'db',
  desc: '数据库概览（版本 / 各表行数与占用空间）',
  async handler() {
    const [vRows] = await pool.query('SELECT VERSION() AS v');
    const version = (vRows as Array<{ v: string }>)[0]?.v || '?';
    const [tRows] = await pool.query(
      `SELECT TABLE_NAME AS name, TABLE_ROWS AS rows_cnt,
              DATA_LENGTH + INDEX_LENGTH AS bytes
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC`
    );
    const tables = tRows as Array<{ name: string; rows_cnt: number; bytes: number }>;
    const fmt = (b: number) =>
      b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(1) + ' KB';
    return [
      `MariaDB/MySQL 版本: ${version}`,
      ...tables.map(
        (t) => `  ${String(t.name).padEnd(20)} ${String(t.rows_cnt ?? 0).padStart(8)} 行  ${fmt(Number(t.bytes))}`
      ),
    ].join('\n');
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
