/* 远程控制面板：REST 签发一次性票据 → 同源 WebSocket → 白名单命令执行 */
(function () {
  'use strict';

  var api = HUB.api;
  var ws = null;
  var seq = 0;
  var outEl = document.getElementById('remoteOut');
  var statusEl = document.getElementById('rcStatus');

  function out(text) {
    outEl.textContent += (outEl.textContent ? '\n' : '') + text;
    // 防止长时间运行下输出无限膨胀（保留最近 150KB）
    if (outEl.textContent.length > 200000) {
      outEl.textContent = outEl.textContent.slice(-150000);
    }
    outEl.scrollTop = outEl.scrollHeight;
  }

  function setStatus(text) { statusEl.textContent = text; }

  function setButtons(connected) {
    document.getElementById('rcConnect').classList.toggle('hidden', connected);
    document.getElementById('rcDisconnect').classList.toggle('hidden', !connected);
  }

  /** 根据服务端下发的命令清单渲染快捷按钮（顺序固定，逐个匹配）。 */
  function renderQuick(commands) {
    var box = document.getElementById('rcQuick');
    box.innerHTML = '';
    ['status', 'disk', 'docker', 'stats', 'sessions', 'audit', 'help'].forEach(function (n) {
      var c = (commands || []).filter(function (x) { return x.name === n; })[0];
      if (!c) return;
      var b = document.createElement('button');
      b.className = 'btn btn-sm';
      b.textContent = n;
      b.title = c.desc;
      b.addEventListener('click', function () { exec(n, []); });
      box.appendChild(b);
    });
  }

  function exec(command, args) {
    if (!ws || ws.readyState !== 1) { out('[!] 未连接，请先点击「连接」'); return; }
    seq += 1;
    ws.send(JSON.stringify({ id: seq, op: 'exec', command: command, args: args || [] }));
    out('$ ' + command + (args && args.length ? ' ' + args.join(' ') : ''));
  }

  async function connect() {
    if (ws && ws.readyState === 1) return;
    // 第一步：REST 签发一次性票据（此步完成会话 + admin 鉴权）
    var d;
    try {
      d = await api('/api/remote/token', { method: 'POST' });
    } catch (e) {
      var m = e.message;
      if (m === 'REMOTE_CONTROL_DISABLED') m = '远程控制功能未开启';
      else if (m === 'TOO_MANY_REQUESTS') m = '操作过于频繁，请稍后再试';
      out('[!] 签发连接票据失败：' + m);
      return;
    }
    // 第二步：凭票据建立同源 WebSocket（console 页仅由后端同源托管，直接用当前 host）
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + d.ws_path + '?ticket=' + encodeURIComponent(d.ticket));

    setStatus('连接中…');
    ws.onopen = function () { setStatus('已连接'); setButtons(true); };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.op === 'hello') {
        renderQuick(msg.commands || []);
        out('[i] 通道已建立（' + (msg.user || '') + '）· 输入 help 查看全部命令');
      } else if (msg.op === 'result') {
        out(msg.output || '(空结果)');
      } else if (msg.op === 'error') {
        out('[!] 协议错误：' + msg.error);
      }
    };
    ws.onclose = function (ev) {
      setStatus('未连接');
      setButtons(false);
      ws = null;
      if (ev && ev.code && ev.code !== 1000) {
        out('[i] 连接已断开 (code ' + ev.code + (ev.reason ? ' · ' + ev.reason : '') + ')');
      }
    };
  }

  function disconnect() {
    if (ws) { try { ws.close(1000); } catch (e) { /* ignore */ } }
  }

  // ---- 事件绑定（脚本在页面末尾加载，元素均已存在） ----
  document.getElementById('rcConnect').addEventListener('click', connect);
  document.getElementById('rcDisconnect').addEventListener('click', disconnect);
  document.getElementById('rcSend').addEventListener('click', function () {
    var v = document.getElementById('rcInput').value.trim();
    if (!v) return;
    document.getElementById('rcInput').value = '';
    var parts = v.split(/\s+/);
    exec(parts[0], parts.slice(1));
  });
  document.getElementById('rcInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('rcSend').click();
  });
})();
