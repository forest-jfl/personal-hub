/* 首屏：北京时间时钟。
   只被 index.html 引用 —— 其余四页没有首屏，不该为它们多付一次请求。

   刻意的一点：时间按 UTC+8 现算，不用本机时区。读者可能在任意时区，
   而时钟旁写着 UTC+8；若跟着本机走，这个标签就成了假话。（与主页同一个口径。） */
(function () {
  'use strict';

  /** 与主页一致：固定 UTC+8，不读本机时区 */
  function beijingNow() {
    var now = new Date();
    return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  var WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  function tick() {
    var t = document.getElementById('clockTime');
    if (!t) return; // 首页之外误引本文件时静默退出，不抛错
    var now = beijingNow();
    t.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
    var d = document.getElementById('clockDate');
    if (d) {
      d.textContent = now.getFullYear() + '年' + pad(now.getMonth() + 1) + '月' +
        pad(now.getDate()) + '日 ' + WEEK[now.getDay()];
    }
  }

  function start() {
    tick();
    setInterval(tick, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
