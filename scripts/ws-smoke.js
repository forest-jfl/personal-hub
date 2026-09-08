/* 冒烟测试：WS 握手(有效票据/无效票据/缺Origin) + exec 两条命令 */
const WebSocket = require('ws');

const ticket = process.argv[2];
if (!ticket) { console.error('usage: node ws-smoke.js <ticket>'); process.exit(1); }

// 1) 无效票据应被拒绝
const bad = new WebSocket('ws://127.0.0.1:3000/ws/remote?ticket=invalid_ticket_xxx', {
  origin: 'http://127.0.0.1:3000',
});
bad.on('error', (e) => console.log('[case1 无效票据] 连接被拒:', e.message));
bad.on('open', () => console.log('[case1 无效票据] !!意外成功!!'));

// 2) 跨站 Origin 应被拒绝
const evil = new WebSocket(`ws://127.0.0.1:3000/ws/remote?ticket=${ticket}`, {
  origin: 'http://evil.example.com',
});
evil.on('error', (e) => console.log('[case2 跨站Origin] 连接被拒:', e.message));
evil.on('open', () => console.log('[case2 跨站Origin] !!意外成功!!'));

// 3) 合法连接 + 命令执行
const ws = new WebSocket(`ws://127.0.0.1:3000/ws/remote?ticket=${ticket}`, {
  origin: 'http://127.0.0.1:3000',
});
let hello = null;
let received = 0;
ws.on('open', () => console.log('[case3 正常连接] open'));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.op === 'hello') {
    hello = msg;
    console.log(`[case3 正常连接] hello, user=${msg.user}, commands=${msg.commands.length}`);
    ws.send(JSON.stringify({ id: 1, op: 'exec', command: 'status', args: [] }));
    ws.send(JSON.stringify({ id: 2, op: 'exec', command: 'sessions', args: [] }));
    ws.send(JSON.stringify({ id: 3, op: 'exec', command: 'rm_rf_slash', args: [] })); // 未知命令
    ws.send(JSON.stringify({ id: 4, op: 'exec', command: 'help; DROP TABLE users', args: [] })); // 非法格式
  } else if (msg.op === 'result') {
    console.log(`\n===== result id=${msg.id} ok=${msg.ok} =====`);
    console.log(msg.output);
    received += 1;
    if (received >= 4) {
      console.log('\n[全部用例执行完毕]');
      process.exit(0);
    }
  }
});
ws.on('error', (e) => console.log('[case3] error:', e.message));
setTimeout(() => { console.log('timeout'); process.exit(2); }, 20000);
