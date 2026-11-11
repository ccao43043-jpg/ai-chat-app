/* 诊断面板：必须在其他业务脚本之前加载，app.js 失败时仍可记录错误与点击。 */
(function () {
  'use strict';
  var APP_VERSION = '0.28.3';
  var MAX_LINES = 500;
  var lines = [];
  var logEl = null;
  var metaEl = null;
  var ready = false;
  var pending = [];

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function ts() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' +
      String(d.getMilliseconds() + 1000).slice(1);
  }
  function safeStr(v) {
    if (v == null) return String(v);
    if (typeof v === 'string') return v;
    if (v instanceof Error) return (v.name || 'Error') + ': ' + (v.message || '') + (v.stack ? '\n' + v.stack : '');
    try { return JSON.stringify(v); } catch (e) { try { return String(v); } catch (e2) { return '[unprintable]'; } }
  }
  function stackSrc(err) {
    var s = err && err.stack;
    if (!s) {
      try { throw new Error('x'); } catch (e) { s = e.stack; }
    }
    if (!s) return '';
    var rows = String(s).split('\n');
    for (var i = 0; i < rows.length; i++) {
      var m = rows[i].match(/(https?:\/\/[^\s)]+|file:[^\s)]+|[^()\s]+\.js):(\d+)(?::(\d+))?/);
      if (!m) continue;
      if (/diag\.js/.test(m[1])) continue;
      var name = m[1].replace(/^.*\//, '');
      return name + ':' + m[2] + (m[3] ? ':' + m[3] : '');
    }
    return '';
  }
  function elInfo(el) {
    if (!el) return '(null)';
    if (el === document) return 'document';
    if (el === window) return 'window';
    if (el.nodeType === 3) return '#text';
    if (el.nodeType !== 1) return '#' + (el.nodeName || 'node');
    var tag = (el.tagName || '').toLowerCase();
    var id = el.id ? '#' + el.id : '';
    var cls = '';
    if (typeof el.className === 'string' && el.className.trim()) {
      cls = '.' + el.className.trim().split(/\s+/).slice(0, 5).join('.');
    }
    var z = '?', pe = '?', op = '?';
    try {
      var cs = window.getComputedStyle(el);
      z = cs.zIndex; pe = cs.pointerEvents; op = cs.opacity;
    } catch (e) {}
    return tag + id + cls + ' z=' + z + ' pe=' + pe + ' op=' + op;
  }
  function closestUseful(el) {
    var n = el;
    while (n && n.nodeType === 1) {
      if (n.id || /^(BUTTON|A|INPUT|TEXTAREA|SELECT|LABEL)$/i.test(n.tagName)) return elInfo(n);
      n = n.parentElement;
    }
    return elInfo(el);
  }
  function covering() {
    var out = [];
    var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
    var area = vw * vh;
    if (!area) return out;
    var nodes = document.querySelectorAll('body *');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.id === 'diag-root' || (el.closest && el.closest('#diag-root'))) continue;
      var cs;
      try { cs = window.getComputedStyle(el); } catch (e) { continue; }
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (parseFloat(cs.opacity) < 0.01) continue;
      var r = el.getBoundingClientRect();
      var w = Math.min(r.right, vw) - Math.max(r.left, 0);
      var h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (w <= 0 || h <= 0) continue;
      var frac = (w * h) / area;
      if (frac > 0.5) {
        out.push(elInfo(el) + ' cover=' + Math.round(frac * 100) + '%');
      }
    }
    return out;
  }
  function metaText() {
    var cov = covering();
    return [
      'app=v' + APP_VERSION + ' (diagnostic)',
      'ua=' + navigator.userAgent,
      'viewport=' + (window.innerWidth || 0) + 'x' + (window.innerHeight || 0) +
        ' dpr=' + (window.devicePixelRatio || 1),
      'covers(>50% viewport, fixed/absolute):',
      cov.length ? cov.join('\n') : '(none)'
    ].join('\n');
  }
  function render() {
    if (!ready) return;
    if (metaEl) metaEl.textContent = metaText();
    if (logEl) logEl.textContent = lines.join('\n');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }
  function add(kind, text) {
    var line = ts() + ' [' + kind + '] ' + text;
    lines.push(line);
    if (lines.length > MAX_LINES) lines = lines.slice(lines.length - MAX_LINES);
    if (!ready) pending.push(line);
    else render();
  }
  function dumpText() {
    return metaText() + '\n\n--- log ---\n' + lines.join('\n');
  }

  /* ---- console / error hooks (before any app script) ---- */
  var c = window.console || {};
  function hookLevel(level) {
    var orig = typeof c[level] === 'function' ? c[level] : null;
    c[level] = function () {
      var args = [];
      for (var i = 0; i < arguments.length; i++) args.push(safeStr(arguments[i]));
      var src = stackSrc(args[0] && args[0].stack ? arguments[0] : null);
      add(level, args.join(' ') + (src ? ' @' + src : ''));
      if (orig) try { return orig.apply(c, arguments); } catch (e) {}
    };
  }
  hookLevel('error');
  hookLevel('warn');
  var origLog = typeof c.log === 'function' ? c.log : null;
  c.log = function () {
    var args = [];
    for (var i = 0; i < arguments.length; i++) args.push(safeStr(arguments[i]));
    var msg = args.join(' ');
    if (msg.indexOf('[init]') !== -1) add('init', msg);
    if (origLog) try { return origLog.apply(c, arguments); } catch (e) {}
  };
  window.console = c;

  window.addEventListener('error', function (e) {
    var src = (e.filename || '') + ':' + (e.lineno || 0) + ':' + (e.colno || 0);
    src = src.replace(/^.*\//, '');
    add('onerror', (e.message || 'error') + ' @' + src);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    var src = stackSrc(r);
    add('unhandledrejection', safeStr(r) + (src ? ' @' + src : ''));
  });

  /* ---- wrap listeners so we can tell if the target handler ran ---- */
  function markHandler(ev, node) {
    if (!ev || !ev.__diagRec) return;
    ev.__diagRec.handlers += 1;
    if (node === ev.__diagRec.target) ev.__diagRec.targetHandlerRan = true;
    else if (node && ev.__diagRec.target && node.contains && node.contains(ev.__diagRec.target)) {
      ev.__diagRec.ancestorHandlerRan = true;
    }
  }
  try {
    var et = EventTarget.prototype;
    var origAdd = et.addEventListener;
    var origRemove = et.removeEventListener;
    var wrapMap = typeof WeakMap === 'function' ? new WeakMap() : null;
    et.addEventListener = function (type, fn, opts) {
      if (typeof fn !== 'function') return origAdd.call(this, type, fn, opts);
      var node = this;
      var wrapped = function (ev) {
        markHandler(ev, node);
        return fn.apply(this, arguments);
      };
      if (wrapMap) {
        var byType = wrapMap.get(fn);
        if (!byType) { byType = {}; wrapMap.set(fn, byType); }
        byType[type] = wrapped;
      }
      return origAdd.call(this, type, wrapped, opts);
    };
    et.removeEventListener = function (type, fn, opts) {
      var w = fn;
      if (wrapMap && fn) {
        var byType = wrapMap.get(fn);
        if (byType && byType[type]) w = byType[type];
      }
      return origRemove.call(this, type, w, opts);
    };
  } catch (e) { add('sys', 'addEventListener hook failed: ' + safeStr(e)); }

  try {
    var proto = typeof HTMLElement === 'function' ? HTMLElement.prototype : Element.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'onclick') ||
      Object.getOwnPropertyDescriptor(Element.prototype, 'onclick');
    if (desc && desc.set && desc.get) {
      Object.defineProperty(proto, 'onclick', {
        configurable: true,
        enumerable: true,
        get: function () { return this.__diagOnclickFn || null; },
        set: function (fn) {
          this.__diagOnclickFn = fn;
          var node = this;
          var wrap = typeof fn === 'function' ? function (ev) {
            markHandler(ev, node);
            return fn.call(node, ev);
          } : fn;
          desc.set.call(this, wrap);
        }
      });
    }
  } catch (e) { add('sys', 'onclick hook failed: ' + safeStr(e)); }

  function onPointer(ev) {
    var t = ev.target;
    if (t && t.closest && t.closest('#diag-root')) return;
    var x = ev.clientX, y = ev.clientY;
    if ((x == null || isNaN(x)) && ev.touches && ev.touches[0]) {
      x = ev.touches[0].clientX; y = ev.touches[0].clientY;
    }
    var from = null;
    try { from = document.elementFromPoint(x, y); } catch (e) {}
    var rec = { target: t, targetHandlerRan: false, ancestorHandlerRan: false, handlers: 0 };
    ev.__diagRec = rec;
    setTimeout(function () {
      var ran = rec.targetHandlerRan || rec.ancestorHandlerRan;
      add('tap', ev.type + ' @' + Math.round(x) + ',' + Math.round(y) +
        ' fromPoint=' + elInfo(from) +
        ' via=' + closestUseful(from || t) +
        ' target=' + elInfo(t) +
        ' handlerRan=' + ran +
        (rec.handlers ? ' handlers=' + rec.handlers : ''));
    }, 0);
  }
  ['pointerdown', 'touchstart', 'click'].forEach(function (type) {
    document.addEventListener(type, onPointer, true);
  });

  function copyAll() {
    var text = dumpText();
    function ok() { add('sys', '已复制 ' + text.length + ' 字'); }
    function fail(err) {
      add('sys', '复制失败 ' + safeStr(err));
    }
    function fallback() {
      try {
        if (window.AndroidBridge && typeof AndroidBridge.copy === 'function') {
          AndroidBridge.copy(text);
          ok();
          return;
        }
      } catch (e) {}
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        var did = document.execCommand('copy');
        document.body.removeChild(ta);
        if (did) ok(); else fail('execCommand');
      } catch (e2) { fail(e2); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok).catch(fallback);
    } else fallback();
  }

  function bind() {
    logEl = document.getElementById('diag-log');
    metaEl = document.getElementById('diag-meta');
    var copyBtn = document.getElementById('diag-copy');
    var root = document.getElementById('diag-root');
    if (!logEl || !root) {
      add('sys', 'diag DOM missing');
      return;
    }
    ready = true;
    if (copyBtn) copyBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      copyAll();
    });
    var box = document.getElementById('diag-box');
    if (box) {
      box.addEventListener('toggle', function () { render(); });
    }
    add('sys', 'diagnostic panel ready v' + APP_VERSION);
    render();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.__diag = { add: add, dump: dumpText, version: APP_VERSION };
})();
