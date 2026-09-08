import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config';
import { logger } from '../utils/logger';
import { consumeTicket } from '../services/remote/tickets';
import { dispatchCommand, sanitizeCommandInput } from '../services/remote/service';
import { listCommands } from '../services/remote/registry';

const WS_PATH = '/ws/remote';

/** 每连接命令执行限速：60 秒窗口内最多 N 条。 */
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_CMDS = 10;
/** 同时在线的远程控制连接上限。 */
const MAX_CLIENTS = 3;

interface ClientState {
  userId: number;
  username: string;
  ip: string;
  isAlive: boolean;
  cmdTimestamps: number[];
}

/** 握手阶段的 Origin 校验：仅允许同源或 CORS 白名单来源（防跨站 WS 劫持）。 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false; // 浏览器 WS 握手必带 Origin；无 Origin 一律拒绝
  const host = req.headers.host || '';
  try {
    if (new URL(origin).host === host) return true;
  } catch {
    /* 非法 origin */
  }
  return config.corsOrigins.includes(origin);
}

function reject(socket: Duplex, code: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${code === 401 ? '401 Unauthorized' : '403 Forbidden'}\r\n` +
      `Connection: close\r\nContent-Type: text/plain\r\n\r\n${reason}`
  );
  socket.destroy();
  logger.warn({ code, reason }, '远程控制 WS 握手被拒绝');
}

/**
 * 将远程控制 WebSocket 通道挂载到主 HTTP 服务。
 * - 复用现有端口与 Caddy 反代（Caddy 原生透传 WS 升级，无需改配置）；
 * - 握手校验：路径 → Origin → 一次性票据（票据在签发时已完成 admin 鉴权）；
 * - 消息协议：
 *     client → server: {"id":1,"op":"exec","command":"status","args":[]}
 *     server → client: {"id":1,"op":"hello"|"result","ok":true,"output":"..."}
 */
export function attachRemoteWs(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const states = new WeakMap<WebSocket, ClientState>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let urlObj: URL;
    try {
      urlObj = new URL(req.url || '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (urlObj.pathname !== WS_PATH) {
      // 本应用仅有此一个 WS 端点，其余升级请求直接断开
      socket.destroy();
      return;
    }
    if (!config.remote.enabled) return reject(socket, 403, 'REMOTE_CONTROL_DISABLED');
    if (!originAllowed(req)) return reject(socket, 403, 'BAD_ORIGIN');

    const entry = consumeTicket(urlObj.searchParams.get('ticket') || '');
    if (!entry) return reject(socket, 401, 'INVALID_TICKET');

    wss.handleUpgrade(req, socket, head, (ws) => {
      const ip =
        (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
        req.socket.remoteAddress ||
        'unknown';
      states.set(ws, {
        userId: entry.userId,
        username: entry.username,
        ip,
        isAlive: true,
        cmdTimestamps: [],
      });
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    const state = states.get(ws)!;
    logger.info({ username: state.username, ip: state.ip }, '远程控制连接已建立');

    // 连接建立即下发可用命令清单
    ws.send(JSON.stringify({ op: 'hello', commands: listCommands(), user: state.username }));

    ws.on('pong', () => {
      state.isAlive = true;
    });

    ws.on('message', async (data: unknown) => {
      let msg: { id?: unknown; op?: unknown; command?: unknown; args?: unknown };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return ws.send(JSON.stringify({ op: 'error', error: 'BAD_JSON' }));
      }
      if (msg.op === 'ping') {
        return ws.send(JSON.stringify({ op: 'pong' }));
      }
      if (msg.op !== 'exec') {
        return ws.send(JSON.stringify({ op: 'error', error: 'UNSUPPORTED_OP' }));
      }

      // 限速：滑动窗口计数
      const now = Date.now();
      state.cmdTimestamps = state.cmdTimestamps.filter((t) => now - t < RATE_WINDOW_MS);
      if (state.cmdTimestamps.length >= RATE_MAX_CMDS) {
        return ws.send(
          JSON.stringify({ id: msg.id, op: 'result', ok: false, output: 'RATE_LIMITED：命令下发过于频繁，请稍后再试' })
        );
      }
      state.cmdTimestamps.push(now);

      const input = sanitizeCommandInput(msg);
      if (!input) {
        return ws.send(
          JSON.stringify({ id: msg.id, op: 'result', ok: false, output: 'BAD_INPUT：命令或参数格式非法' })
        );
      }

      const result = await dispatchCommand(input.command, input.args, {
        userId: state.userId,
        username: state.username,
        ip: state.ip,
      });
      ws.send(
        JSON.stringify({ id: msg.id, op: 'result', ok: result.ok, output: result.output })
      );
    });

    ws.on('close', () => {
      logger.info({ username: state.username }, '远程控制连接已断开');
    });
    ws.on('error', (err) => {
      logger.warn({ err }, '远程控制 WS 连接异常');
    });
  });

  // 心跳：30 秒一轮，两轮未回应则断开死连接
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const state = states.get(ws);
      if (!state) continue;
      if (!state.isAlive) {
        ws.terminate();
        continue;
      }
      state.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  logger.info(`远程控制 WS 通道已挂载: ${WS_PATH} (enabled=${config.remote.enabled})`);
}
