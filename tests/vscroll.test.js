// 虚拟滚动纯函数：range 计算、NaN/负高度防护、滞回覆盖（v0.13.1 向上滑卡住闪黑修复）
const test = require('node:test');
const assert = require('node:assert');
const V = require('../app/src/main/assets/www/vscroll.js');
const fs = require('fs'), path = require('path');
const hs = (n, h = 100) => Array.from({ length: n }, () => h);

test('range 基本：顶部 / 中部 / 底部', () => {
  let r = V.computeRange(hs(100), 0, 600, 2);
  assert.strictEqual(r.start, 0); assert.strictEqual(r.topH, 0);
  assert.ok(r.end > 6 && r.end <= 100);
  assert.strictEqual(r.topH + r.bottomH + (r.end - r.start) * 100, 10000);
  r = V.computeRange(hs(100), 5000, 600, 2);
  assert.strictEqual(r.start, 38); assert.strictEqual(r.topH, 3800);
  assert.ok(r.end * 100 >= 5000 + 600 * 3, '窗口下沿覆盖视口+overscan');
  r = V.computeRange(hs(100), 1e9, 600, 2);
  assert.strictEqual(r.end, 100); assert.strictEqual(r.bottomH, 0); assert.ok(r.start < r.end);
});

test('NaN / 负数 / 0 高度与 scrollTop 不产生 NaN 或负 spacer', () => {
  const h = [100, NaN, -50, 0, undefined, 100, 100];
  for (const st of [NaN, -100, 0, 150, Infinity]) {
    const r = V.computeRange(h, st, NaN, 2);
    for (const k of ['start', 'end', 'topH', 'bottomH']) assert.ok(Number.isFinite(r[k]) && r[k] >= 0, k + '@' + st);
    assert.ok(r.end > r.start);
  }
  assert.deepStrictEqual(V.computeRange([], 0, 600, 2), { start: 0, end: 0, topH: 0, bottomH: 0 });
});

test('向上滑连续 range：start 单调不增、topH 与 start 一致（spacer 不突变）', () => {
  const h = Array.from({ length: 200 }, (_, i) => 80 + (i * 37) % 300);
  let prev = null;
  for (let st = 30000; st >= 0; st -= 37) {
    const r = V.computeRange(h, st, 700, 2);
    const top = h.slice(0, r.start).reduce((a, b) => a + b, 0);
    assert.strictEqual(r.topH, top);
    assert.ok(r.topH <= Math.max(0, st), '上 spacer 不超过 scrollTop，否则视口落在空白');
    if (prev) assert.ok(r.start <= prev.start);
    prev = r;
  }
});

test('滞回：窗口仍覆盖视口+余量时不重建，接近边缘才重建', () => {
  const h = hs(200);
  const r = V.computeRange(h, 10000, 600, 2);
  const last = { start: r.start, end: r.end, empty: false };
  assert.ok(V.windowCovers(last, h, 10000, 600));
  assert.ok(V.windowCovers(last, h, 9950, 600), '小幅上滑不重建');
  assert.ok(!V.windowCovers(last, h, r.topH + 100, 600), '靠近上沿需重建');
  assert.ok(!V.windowCovers({ empty: true }, h, 0, 600));
  assert.ok(!V.windowCovers({ start: 0, end: 500, empty: false }, h, 0, 600), '越界窗口失效');
  assert.ok(V.windowCovers({ start: 0, end: 20, empty: false }, h, 0, 600), '在列表顶部');
});

test('app.js 不再整体清空重建虚拟窗口、spacer 不按实测重算', () => {
  const s = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/app.js'), 'utf8');
  const fn = s.slice(s.indexOf('function renderMessages'), s.indexOf('function buildMsgEl'));
  const virt = fn.slice(fn.indexOf('const viewH'));
  assert.ok(virt.includes('win.replaceChildren') && virt.includes('VScroll.windowCovers'));
  assert.ok(!/topH2|botH2/.test(virt));
  assert.ok(fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/index.html'), 'utf8').includes('vscroll.js'));
});

test('v0.13.2：回收重建的消息不再播放 opacity:0 入场动画（向上滑一黑一黑）', () => {
  const s = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/app.css'), 'utf8');
  assert.match(css, /\.msg\.no-anim\s*\{\s*animation:\s*none/);
  const fill = s.slice(s.indexOf('function fillMsgEl'), s.indexOf('function fillMsgEl') + 600);
  assert.ok(fill.includes("vsSeen.has(m.id)) el.classList.add('no-anim')"), 'fillMsgEl 设置 className 后补 no-anim');
  assert.ok(/VS_OVERSCAN = 3/.test(s));
});
test('v0.13.2：overscan 3 时窗口覆盖视口上下各 ≥3 屏（除边界）', () => {
  const r = V.computeRange(hs(500), 20000, 600, 3);
  assert.ok(20000 - r.topH >= 1800 && r.topH + (r.end - r.start) * 100 >= 20000 + 600 * 4);
});
