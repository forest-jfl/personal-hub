/* 首屏：北京时间时钟 + 轮换引言。
   只被 index.html 引用 —— 其余四页没有首屏，不该为它们多付一次请求。

   两点刻意的做法：
   1. 时间按 UTC+8 现算，不用本机时区。读者可能在任意时区，而面板上写着
      UTC+8；若跟着本机走，标签就成了假话。（与主页同一个口径。）
   2. 引言在 HTML 里已写死第一条，脚本只负责往下轮换。这样脚本挂掉、
      或被 CSP 拦掉时，首屏仍然是一句完整的话，而不是一片空白。 */
(function () {
  'use strict';

  var QUOTES = [
    '先把口径定下来，再谈结论。',
    '在数据里找线索，和在代码里找 bug，本质是同一件事。',
    '能被一条命令验证的事，就不要靠记性。',
    '把不确定性关在自己家门内，剩下的才交给网络。'
  ];

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
    var d = document.getElementById('clockDate');
    if (!t) return;
    var now = beijingNow();
    t.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
    if (d) {
      d.textContent = now.getFullYear() + '年' + pad(now.getMonth() + 1) + '月' +
        pad(now.getDate()) + '日 ' + WEEK[now.getDay()];
    }
  }

  function rotate() {
    var box = document.getElementById('heroQuote');
    if (!box || QUOTES.length < 2) return;
    var i = 0;
    // 尊重「减少动态效果」：不是关掉轮换，而是改成不淡入淡出地直接换字
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setInterval(function () {
      i = (i + 1) % QUOTES.length;
      if (still) {
        box.textContent = QUOTES[i];
        return;
      }
      box.classList.add('is-fading');
      setTimeout(function () {
        box.textContent = QUOTES[i];
        box.classList.remove('is-fading');
      }, 320);
    }, 12000);
  }

  function start() {
    tick();
    setInterval(tick, 1000);
    rotate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
