// 方向 F：渲染 / 滚动复杂度治理
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const RD = require('../app/src/main/assets/www/render-diff.js');
const V = require('../app/src/main/assets/www/vscroll.js');
const www = f => fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/www', f), 'utf8');

test('splitBlocks：按顶层块切分 p/h/pre/ul/blockquote/table', () => {
  const html = '<p>a</p><h2>t</h2><pre><code>x</code></pre><ul><li>1</li></ul><blockquote><p>q</p></blockquote><table><tr><td>1</td></tr></table>';
  const blocks = RD.splitBlocks(html);
  assert.strictEqual(blocks.length, 6);
  assert.deepStrictEqual(blocks.map(b => b.tag), ['p', 'h2', 'pre', 'ul', 'blockquote', 'table']);
  blocks.forEach(b => assert.ok(b.key && b.html));
});

test('splitBlocks：嵌套同名标签不误切', () => {
  const html = '<blockquote><blockquote><p>x</p></blockquote></blockquote><p>y</p>';
  const blocks = RD.splitBlocks(html);
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].tag, 'blockquote');
  assert.ok(blocks[0].html.includes('<blockquote><p>x</p></blockquote>'));
  assert.strictEqual(blocks[1].tag, 'p');
});

test('commonPrefix / planBlockDiff：相同前缀只重建尾部', () => {
  const a = RD.splitBlocks('<p>1</p><p>2</p><p>3</p>');
  const b = RD.splitBlocks('<p>1</p><p>2</p><p>3x</p><p>4</p>');
  assert.strictEqual(RD.commonPrefix(a.map(x => x.key), b.map(x => x.key)), 2);
  const plan = RD.planBlockDiff(a.map(x => x.key), b);
  assert.strictEqual(plan.keep, 2);
  assert.strictEqual(plan.rebuild.length, 2);
  assert.strictEqual(plan.rebuild[0].html, '<p>3x</p>');
});

test('planBlockDiff：稳定块前缀增长时 keep 增加（永不重建已稳定）', () => {
  const t1 = RD.splitBlocks('<p>Hello</p>');
  const t2 = RD.splitBlocks('<p>Hello</p><p>World</p>');
  const t3 = RD.splitBlocks('<p>Hello</p><p>World</p><p>!</p>');
  assert.strictEqual(RD.planBlockDiff(t1.map(b => b.key), t2).keep, 1);
  assert.strictEqual(RD.planBlockDiff(t2.map(b => b.key), t3).keep, 2);
  // 全量相同 → 全部 keep
  assert.strictEqual(RD.planBlockDiff(t3.map(b => b.key), t3).keep, 3);
  assert.strictEqual(RD.planBlockDiff(t3.map(b => b.key), t3).rebuild.length, 0);
});

test('blockHash：同文同钥、改文改钥', () => {
  assert.strictEqual(RD.blockHash('<p>a</p>'), RD.blockHash('<p>a</p>'));
  assert.notStrictEqual(RD.blockHash('<p>a</p>'), RD.blockHash('<p>b</p>'));
});

test('streamHeadCache 多槽：另一条流不会踢掉当前槽', () => {
  const c = RD.createStreamHeadCache(4);
  c.set('m1', { src: 'A', html: '<p>A</p>', codes: 0 });
  c.set('m2', { src: 'B', html: '<p>B</p>', codes: 0 });
  assert.strictEqual(c.get('m1').src, 'A');
  assert.strictEqual(c.get('m2').src, 'B');
  c.set('m2', { src: 'B2', html: '<p>B2</p>', codes: 0 });
  assert.strictEqual(c.get('m1').src, 'A', 'm2 更新不踢 m1');
  assert.strictEqual(c.get('m2').src, 'B2');
  // LRU：塞满后最旧被踢
  c.set('m3', { src: 'C' });
  c.set('m4', { src: 'D' });
  c.set('m5', { src: 'E' }); // 超出 4，踢最久未用
  assert.ok(c.size() <= 4);
  assert.ok(c.get('m2') && c.get('m5'));
});

test('guessAspect：URL 参数与 800x600 模式；否则 null', () => {
  assert.strictEqual(RD.guessAspect('https://x/a.png?w=800&h=600'), '800 / 600');
  assert.strictEqual(RD.guessAspect('https://cdn/img/800x600/photo.jpg'), '800 / 600');
  assert.strictEqual(RD.guessAspect('https://x/a.png'), null);
});

test('createFrameScheduler：同帧多次 schedule 只 flush 一次', async () => {
  const calls = [];
  let trigger;
  const raf = (cb) => { trigger = cb; return 1; };
  const sched = RD.createFrameScheduler(x => calls.push(x), raf);
  const a = { id: 1 }, b = { id: 2 };
  sched.schedule(a);
  sched.schedule(a);
  sched.schedule(b);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(sched.pending(), 2);
  trigger();
  assert.deepStrictEqual(calls, [a, b]);
  assert.strictEqual(sched.pending(), 0);
});

test('高度缓存 clear：尺寸变化入口可清空（配合 RO）', () => {
  const c = V.createHeightCache();
  const m = { id: 'x', content: 'hi' };
  c.set(m, 120);
  assert.strictEqual(c.get(m), 120);
  c.clear();
  assert.strictEqual(c.get(m), null);
  assert.strictEqual(c.size(), 0);
});

test('app.js 接入：多槽缓存 / 块差分 / rAF / ResizeObserver 清高度', () => {
  const s = www('app.js');
  const rd = www('render-diff.js');
  assert.ok(rd.includes('function applyBlockDiff') && rd.includes('createStreamHeadCache'));
  assert.ok(s.includes('RenderDiff.createStreamHeadCache'));
  assert.ok(s.includes('RenderDiff.applyBlockDiff'));
  assert.ok(s.includes('RenderDiff.createFrameScheduler'));
  assert.ok(s.includes('ensureBoxSizeObserver'));
  assert.ok(s.includes('vsHeight.clear()'));
  assert.ok(s.includes('guessAspect') || s.includes('RenderDiff.guessAspect'));
  assert.ok(s.includes('patchMsgMarkdown'));
  assert.ok(s.includes('aspectRatio'));
  // 不再使用单槽 null 赋值或 70ms 批量
  assert.ok(!/let streamHeadCache = null/.test(s));
  assert.ok(!/setTimeout\(\(\) => \{ rafTimer = null;[\s\S]*?\}, 70\)/.test(s));
  // index 引入模块
  assert.ok(www('index.html').includes('render-diff.js'));
});

test('version-sync 兼容：streaming 选项仍在', () => {
  const s = www('app.js');
  assert.ok(s.includes('streaming: !!m.pending'));
  assert.ok(/MD_CACHE_MAX = 80/.test(s) && /HL_CACHE_MAX = 300/.test(s));
});
