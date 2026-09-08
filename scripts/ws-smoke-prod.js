/* 线上验证：wss 经 Cloudflare + Caddy；有效票据 exec / 无效票据 401 */
const WebSocket = require('ws');
const BASE = 'wss://blog.jiangfulin.com/ws/remote';
const ORIGIN = 'https://blog.jiangfulin.com';
const ticket = process.argv[2];

const bad = new WebSocket(BASE + '?ticket=invalid_xxx', { origin: ORIGIN });
bad.on('error', (e) => console.log('[无效票据] 拒绝:', e.message));

const ws = new WebSocket(`${BASE}?ticket=${encodeURIComponent(ticket)}`, { origin: ORIGIN });
let results = 0;
ws.on('open', () => console.log('[正常连接] open (wss 经 Cloudflare→Caddy→容器)'));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.op === 'hello') {
    console.log(`[hello] user=${msg.user} commands=${msg.commands.length}`);
    ws.send(JSON.stringify({ id: 1, op: 'exec', command: 'status', args: [] }));
    ws.send(JSON.stringify({ id: 2, op: 'exec', command: 'docker', args: [] }));
    ws.send(JSON.stringify({ id: 3, op: 'exec', command: 'sessions', args: [] }));
  } else if (msg.op === 'result') {
    console.log(`\n===== id=${msg.id} ok=${msg.ok} =====\n${msg.output}`);
    if (++results === 3) process.exit(0);
  }
});
ws.on('error', (e) => console.log('[error]', e.message));
setTimeout(() => { console.log('timeout'); process.exit(2); }, 25000);
