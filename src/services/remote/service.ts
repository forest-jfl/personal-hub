import { config } from '../../config';
import { logger } from '../../utils/logger';
import { pool } from '../../db/connection';
import { getCommand, CommandContext } from './registry';

export interface ExecResult {
  ok: boolean;
  output: string;
}

/** 审计记录允许入库的最大输出长度（TEXT 足够，避免超大行）。 */
const AUDIT_OUTPUT_MAX = 4000;

/** 截断输出到指定字节数（按 UTF-8 边界，避免截出半个多字节字符）。 */
function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const sliced = buf.subarray(0, maxBytes).toString('utf8');
  // 末尾可能残留 replacement char，简单去一次即可
  return sliced.replace(/\ufffd+$/, '') + `\n…(输出已截断，原始 ${buf.length} 字节)`;
}

async function writeAudit(
  ctx: CommandContext,
  command: string,
  args: string,
  ok: boolean,
  output: string
): Promise<void> {
  try {
    await pool.query(
      'INSERT INTO remote_cmd_log (user_id, username, command, args, ok, output, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [ctx.userId, ctx.username, command, args.slice(0, 500), ok ? 1 : 0, output.slice(0, AUDIT_OUTPUT_MAX), ctx.ip]
    );
  } catch (e) {
    // 审计失败不阻断命令结果返回，但要留痕排查
    logger.error({ err: e, command }, '远程命令审计写入失败');
  }
}

/**
 * 命令分发入口：白名单校验 → 超时控制 → 输出截断 → 审计落库。
 * 该函数是 WS 通道与未来 REST 通道共用的唯一执行路径。
 */
export async function dispatchCommand(
  name: string,
  args: string[],
  ctx: CommandContext
): Promise<ExecResult> {
  const def = getCommand(name);
  if (!def) {
    await writeAudit(ctx, name, args.join(' '), false, 'UNKNOWN_COMMAND');
    return { ok: false, output: `未知命令：${name}（输入 help 查看可用命令）` };
  }

  let result: ExecResult;
  try {
    const output = await Promise.race([
      def.handler(args, ctx),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('COMMAND_TIMEOUT')), config.remote.commandTimeoutMs)
      ),
    ]);
    result = { ok: true, output: truncateBytes(String(output), config.remote.maxOutputBytes) };
  } catch (e) {
    const err = e as Error;
    const output =
      err.message === 'COMMAND_TIMEOUT'
        ? `命令执行超时（>${Math.round(config.remote.commandTimeoutMs / 1000)}s）`
        : `命令执行失败：${err.message}`;
    logger.warn({ command: name, err }, '远程命令执行失败');
    result = { ok: false, output: truncateBytes(output, config.remote.maxOutputBytes) };
  }

  await writeAudit(ctx, name, args.join(' '), result.ok, result.output);
  return result;
}

/** 对客户端提交的命令与参数做规范化校验，非法返回 null。 */
export function sanitizeCommandInput(
  raw: unknown
): { command: string; args: string[] } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { command, args } = raw as { command?: unknown; args?: unknown };
  if (typeof command !== 'string' || command.length === 0 || command.length > 64) return null;
  if (!/^[a-z][a-z0-9_]*$/i.test(command)) return null;
  let cleanArgs: string[] = [];
  if (args !== undefined) {
    if (!Array.isArray(args) || args.length > 8) return null;
    cleanArgs = args.map((a) => String(a));
    if (cleanArgs.some((a) => a.length > 200)) return null;
  }
  return { command, args: cleanArgs };
}
