/* Personal Hub 共享工具：API 封装、格式化、顶部导航渲染 */
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
   * 渲染顶部导航到 #site-nav。
   * me: 当前用户（null 表示未登录）
   */
  function renderNav(me) {
    var nav = document.getElementById('site-nav');
    if (!nav) return;
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
        '    <a href="/editor">✎ 写文章</a>' +
        '    <a href="/console">🗂 管理控制台</a>' +
        '    <a href="/console?tab=account">🔑 修改密码</a>' +
        '    <a href="#" id="logoutLink">⎋ 退出登录</a>' +
        '  </div>' +
        '</div>';
    } else {
      loginArea = '<a class="btn btn-primary btn-sm" href="/login">登录</a>';
    }
    nav.innerHTML =
      '<div class="nav-inner">' +
      '  <a class="brand" href="/">Personal<span>Hub</span></a>' +
      '  <nav class="nav-links">' +
      '    <a href="/" class="' + (location.pathname === '/' ? 'active' : '') + '">首页</a>' +
      '    <a href="/?view=categories">分类</a>' +
      '    <a href="/?view=archive">归档</a>' +
      '    <a href="/?view=about">关于</a>' +
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

  /** 获取当前用户；未登录跳转登录页。 */
  async function requireMe() {
    var me = await fetchMe();
    if (!me) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
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
    renderNav: renderNav,
    fetchMe: fetchMe,
    requireMe: requireMe
  };
})();
