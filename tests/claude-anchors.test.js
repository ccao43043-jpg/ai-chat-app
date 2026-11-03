'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../app/src/main/assets/www/providers.js');
const img = 'data:image/png;base64,AAAA';
const prov = { type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k' };

// 断点在全局块序列中的位置（system 块记为 0）
function breakpoints(body) {
  const pos = []; let n = 0;
  if (Array.isArray(body.system)) body.system.forEach(b => { if (b.cache_control) pos.push(n); n++; });
  body.messages.forEach(m => {
    const parts = typeof m.content === 'string' ? [m.content] : m.content;
    parts.forEach(b => { if (b && b.cache_control) { assert.strictEqual(b.type, 'text', '断点只能打在 text 块'); pos.push(n); } n++; });
  });
  return pos;
}
function build(hist, user, anchors) {
  const msgs = hist.map(m => Object.assign({}, m));
  if (msgs.length) msgs[msgs.length - 1]._cache = true;
  const r = P.buildChatRequest(prov, 'claude-x', msgs.concat([user]), 'SYS', { stream: false, cacheControl: true });
  const body = JSON.parse(r.body);
  if (!anchors) { // 对照：旧行为，只保留末尾断点
    const bp = breakpoints(body); return [bp[0], bp[bp.length - 1]];
  }
  return breakpoints(body);
}
// 模拟器：每轮能否在某个断点的 20 块回溯窗口内找到上一轮写入点
function simulate(imgsPerTurn, rounds, anchors) {
  const hist = []; let prev = null, misses = 0;
  for (let t = 0; t < rounds; t++) {
    const k = imgsPerTurn(t);
    const user = { role: 'user', content: '第' + t + '轮', images: Array(k).fill(img) };
    const bp = build(hist, user, anchors);
    assert.ok(bp.length <= 4, '断点总数 ≤ 4');
    if (prev && prev.length > 1) {
      const hit = bp.slice(1).some(c => prev.slice(1).some(w => w <= c && c - w < 20));
      const tailMoved = bp[bp.length - 1] !== prev[prev.length - 1];
      if (tailMoved && !hit) misses++;
    }
    prev = bp;
    hist.push(user, { role: 'assistant', content: '回复' + t });
  }
  return misses;
}

test('锚点：普通文字对话，每轮都能命中上一轮写入点', () => {
  assert.strictEqual(simulate(() => 0, 40, true), 0);
});
test('锚点：每轮附带大量图片（超过 20 块），仍能在窗口内命中', () => {
  assert.strictEqual(simulate(t => (t % 3 === 0 ? 12 : 2), 40, true), 0);
  assert.strictEqual(simulate(() => 25, 12, true), 0);
  // 对照：旧行为（只有末尾断点）在大图批次时会漏命中
  assert.ok(simulate(() => 25, 12, false) > 0);
});
test('锚点：历史最多 3 个，加 system 不超过 4；无 system 时历史仍最多 3 个', () => {
  const hist = [];
  for (let i = 0; i < 60; i++) hist.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
  hist[hist.length - 1]._cache = true;
  const withSys = JSON.parse(P.buildChatRequest(prov, 'c', hist.concat([{ role: 'user', content: 'q' }]), 'SYS', { cacheControl: true }).body);
  assert.strictEqual(breakpoints(withSys).length, 4);
  const noSys = JSON.parse(P.buildChatRequest(prov, 'c', hist.concat([{ role: 'user', content: 'q' }]), '', { cacheControl: true }).body);
  assert.strictEqual(breakpoints(noSys).length, 3);
});
test('锚点：短历史只有末尾断点；纯图片消息不打断点', () => {
  const a = P.claudeCacheAnchors([{ content: 'a' }, { content: 'b' }], [1]);
  assert.deepStrictEqual(a, [1]);
  const msgs = [{ content: [{ type: 'image' }] }, { content: [{ type: 'text', text: 'x' }] }].concat(Array(14).fill(0).map(() => ({ content: [{ type: 'image' }] })));
  // 末尾是纯图片 → 回退到含文本的消息
  assert.deepStrictEqual(P.claudeCacheAnchors(msgs, [msgs.length - 1]), [1]);
  assert.deepStrictEqual(P.claudeCacheAnchors(msgs, []), []);
});
test('未开启 cacheControl 时不打任何断点（其他提供商行为不变）', () => {
  const r = JSON.parse(P.buildChatRequest(prov, 'c', [{ role: 'user', content: 'a', _cache: true }, { role: 'user', content: 'q' }], 'S', {}).body);
  assert.ok(!JSON.stringify(r).includes('cache_control'));
});
