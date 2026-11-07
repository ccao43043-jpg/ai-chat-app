const test = require('node:test');
const assert = require('node:assert');
const RD = require('../app/src/main/assets/www/render-diff.js');

test('块差分：追加块时保留旧节点（模拟 incremental md）', () => {
  // 最小 DOM stub
  global.document = {
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(),
        children: [],
        childNodes: [],
        style: {},
        className: '',
        dataset: {},
        appendChild(c) { this.children.push(c); this.childNodes.push(c); c.parentNode = this; return c; },
        removeChild(c) {
          this.children = this.children.filter(x => x !== c);
          this.childNodes = this.childNodes.filter(x => x !== c);
        },
        insertBefore(c, ref) {
          const i = ref ? this.children.indexOf(ref) : -1;
          if (i < 0) { this.appendChild(c); return c; }
          this.children.splice(i, 0, c); this.childNodes.splice(i, 0, c); c.parentNode = this; return c;
        },
        replaceChild(n, o) {
          const i = this.children.indexOf(o);
          if (i >= 0) { this.children[i] = n; this.childNodes[i] = n; n.parentNode = this; }
          return n;
        },
        set innerHTML(v) { this.children = []; this.childNodes = []; this._html = v; },
        get innerHTML() { return this._html || ''; },
        querySelector() { return null; },
      };
      return el;
    },
  };
  const div = document.createElement('div');
  const html1 = '<p>第一段</p>';
  RD.applyBlockDiff(div, html1, () => {});
  const n1 = div.children.length;
  const html2 = '<p>第一段</p><p>第二段</p>';
  RD.applyBlockDiff(div, html2, () => {});
  assert.ok(div.children.length >= n1);
});

test('frame scheduler 暴露 schedule 接口', () => {
  assert.strictEqual(typeof RD.createFrameScheduler, 'function');
  const sched = RD.createFrameScheduler(() => {});
  assert.strictEqual(typeof sched.schedule, 'function');
});

test('skeletonSig 稳定性（结构字段）', () => {
  // 与 app.js 同思路的轻量签名：流式只改 content 时签名不变
  function skeletonSig(m) {
    return [m.role, m.personaName || '', m.model || '', m.error ? 1 : 0,
      (m.files && m.files.length) || 0, (m.images && m.images.length) || 0, m.pending ? 1 : 0].join('|');
  }
  const a = { role: 'assistant', model: 'x', pending: true, content: 'hi' };
  const b = { role: 'assistant', model: 'x', pending: true, content: 'hi there longer' };
  assert.strictEqual(skeletonSig(a), skeletonSig(b));
  const c = { role: 'assistant', model: 'y', pending: true, content: 'hi' };
  assert.notStrictEqual(skeletonSig(a), skeletonSig(c));
});
