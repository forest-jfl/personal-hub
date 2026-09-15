/* 半山日志 共享工具：API 封装、格式化、顶部导航渲染 */
(function () {
  'use strict';

  var API_BASE = (window.HUB_CONFIG && window.HUB_CONFIG.API_BASE) || '';

  function url(path) {
    return API_BASE + path;
  }

  async function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'include';
    opts.headers = Object.assign({}, opts.headers);
    var r = await fetch(url(path), opts);
    var d = null;
    try { d = await r.json(); } catch (e) { d = {}; }
    if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
    return d;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(s);
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function qs(name) {
    return new URLSearchParams(location.search).get(name) || '';
  }

  /**
   * 复制文本到剪贴板，返回是否成功。
   * navigator.clipboard 只在安全上下文（https / localhost）存在，
   * 用局域网 http 打开站点时它是 undefined —— 保留 execCommand 兜底，
   * 否则「复制链接」在非 https 环境下会静默失效，用户以为复制了其实没有。
   */
  async function copyText(text) {
    var s = String(text == null ? '' : text);
    if (!s) return false;
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(s); return true; } catch (e) { /* 落到兜底 */ }
    }
    try {
      var ta = document.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  /**
   * 由 files 记录拼出对外可用的图床地址。
   * 抽出来是因为「正文插图、封面、图片库」三处都要拼它，
   * 一旦 URL 形态变了（比如以后换成 /f/<token>），只改这一处。
   */
  function fileUrl(f) {
    if (!f || !f.id || !f.public_token) return '';
    return url('/api/public/files/' + f.id + '/' + f.public_token);
  }

  /**
   * 封面地址规范化：只认本站图床路径与 https 外链，其余一律返回空串。
   * 与后端 src/utils/cover.ts 的规则同源，这里是前端的第二道拦截 ——
   * 作用是让写错的值在页面上直接表现为「没有封面」，而不是塞进 img src 里。
   */
  function safeCover(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (/^\/api\/public\/files\/\d+\/[a-f0-9]{16,64}$/.test(s)) return s;
    if (/^https:\/\/[^\s]+$/i.test(s)) return s;
    return '';
  }

  /**
   * 渲染顶部导航到 #site-nav。
   * me: 当前用户（null 表示未登录）
   */
  function renderNav(me) {
    var nav = document.getElementById('site-nav');
    if (!nav) return;
    // editor/console/gallery 仅由后端同源托管：任何部署形态下都指向 API_BASE，
    // 避免 Pages 托管版里相对路径指向 Pages 域名而 404
    var editorHref = url('/editor');
    var consoleHref = url('/console');
    var galleryHref = url('/gallery');
    // 首页判定：净路径 / 、显式 /index.html、以及带查询串的首页视图都算
    var onHome = location.pathname === '/' || /\/index\.html$/.test(location.pathname);
    var loginArea;
    if (me) {
      var initial = (me.display_name || me.username || '?').slice(0, 1).toUpperCase();
      var roleTag = me.role === 'admin' ? '管理员' : '用户';
      loginArea =
        '<div class="nav-user">' +
        '  <button class="avatar-btn" id="avatarBtn">' +
        '    <span class="avatar">' + esc(initial) + '</span>' +
        '    <span class="avatar-name">' + esc(me.display_name || me.username) + '</span>' +
        '    <span class="caret">▾</span>' +
        '  </button>' +
        '  <div class="dropdown hidden" id="userMenu">' +
        '    <div class="dropdown-role">' + esc(roleTag) + ' · ' + esc(me.username) + '</div>' +
        '    <a href="' + editorHref + '">✎ 写文章</a>' +
        '    <a href="' + galleryHref + '">🖼 图片库</a>' +
        '    <a href="' + consoleHref + '">🗂 管理控制台</a>' +
        '    <a href="' + consoleHref + '?tab=account">🔑 修改密码</a>' +
        '    <a href="#" id="logoutLink">⎋ 退出登录</a>' +
        '  </div>' +
        '</div>';
    } else {
      loginArea = '<a class="btn btn-primary btn-sm" href="' + url('/login') + '">登录</a>';
    }
    nav.innerHTML =
      '<div class="nav-inner">' +
      '  <a class="brand" href="./">' +
      '    <span class="brand-mark" aria-hidden="true">半</span>' +
      '    <span class="brand-word">半山</span>' +
      '    <span class="brand-sub">日志</span>' +
      '  </a>' +
      // 编号与主页导航同一套语言（01 关于 / 02 作品 …）
      '  <nav class="nav-links" aria-label="主导航">' +
      '    <a href="./" class="' + (onHome ? 'active' : '') + '"><span>01</span>首页</a>' +
      '    <a href="./?view=categories"><span>02</span>分类</a>' +
      '    <a href="./?view=archive"><span>03</span>归档</a>' +
      '    <a href="./?view=about"><span>04</span>关于</a>' +
      '  </nav>' +
      '  <div class="nav-spacer"></div>' +
      loginArea +
      '</div>';

    if (me) {
      var btn = document.getElementById('avatarBtn');
      var menu = document.getElementById('userMenu');
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        menu.classList.toggle('hidden');
      });
      document.addEventListener('click', function () { menu.classList.add('hidden'); });
      document.getElementById('logoutLink').addEventListener('click', async function (e) {
        e.preventDefault();
        try { await api('/api/auth/logout', { method: 'POST' }); } catch (err) { /* ignore */ }
        location.href = '/';
      });
    }
  }

  /** 获取当前用户；未登录返回 null（不跳转）。 */
  async function fetchMe() {
    try {
      var d = await api('/api/auth/me');
      return d.user;
    } catch (e) {
      return null;
    }
  }

  /** 获取当前用户；未登录跳转登录页（登录后回跳原页面）。 */
  async function requireMe() {
    var me = await fetchMe();
    if (!me) {
      // next 携带完整地址，兼容 Pages 子路径部署；登录侧校验防开放重定向
      var back = encodeURIComponent(location.href);
      location.href = url('/login?next=' + back);
      return null;
    }
    return me;
  }

  window.HUB = {
    api: api,
    url: url,
    esc: esc,
    fmtSize: fmtSize,
    fmtDate: fmtDate,
    qs: qs,
    copyText: copyText,
    fileUrl: fileUrl,
    safeCover: safeCover,
    renderNav: renderNav,
    fetchMe: fetchMe,
    requireMe: requireMe
  };
})();
