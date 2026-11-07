const test = require('node:test');
const assert = require('node:assert');
const R = require('../app/src/main/assets/www/router.js');
const RP = require('../app/src/main/assets/www/rpcache.js');

test('D3：每请求 1 份证据（同命中率、不同 prompt 长度 → 后验增量同量级）', () => {
  const stateA = {}, stateB = {};
  // 90% 命中，短 prompt vs 长 prompt
  for (let i = 0; i < 10; i++) {
    R.observe(stateA, 'm', 'u', { hitTokens: 90, promptTokens: 100, ok: true });
    R.observe(stateB, 'm', 'u', { hitTokens: 9000, promptTokens: 10000, ok: true });
  }
  const a = stateA.m.upstreams.u;
  const b = stateB.m.upstreams.u;
  assert.strictEqual(a.obs, 10);
  assert.strictEqual(b.obs, 10);
  // 旧 bug：长 prompt 会把 α/β 撑到几千；现在应接近先验+10 份
  assert.ok(a.a < 20 && b.a < 20, `a.a=${a.a} b.a=${b.a}`);
  assert.ok(Math.abs(a.a - b.a) < 1e-9 && Math.abs(a.b - b.b) < 1e-9);
  // 与 rpcache.hitPosterior 同构
  const post = RP.hitPosterior(Array.from({ length: 10 }, () => ({ hit: 90, prompt: 100 })));
  assert.ok(Math.abs(a.a - post.alpha) < 1e-9);
  assert.ok(Math.abs(a.b - post.beta) < 1e-9);
});

test('D3：禁止 token 当样本——单次长 prompt 不得使 obs 证据爆炸', () => {
  const state = {};
  R.observe(state, 'm', 'u', { hitTokens: 50000, promptTokens: 100000, ok: true });
  const u = state.m.upstreams.u;
  assert.strictEqual(u.obs, 1);
  assert.ok(u.a < 8 && u.b < 6, `a=${u.a} b=${u.b}（先验 6+0.5 / 4+0.5）`);
});

test('D3：信息量权重有界（0.5..2）', () => {
  assert.strictEqual(R.evidenceWeight(8000, { infoWeight: true, refTokens: 8000 }), 1);
  assert.ok(R.evidenceWeight(100, { infoWeight: true }) >= 0.5);
  assert.ok(R.evidenceWeight(1e7, { infoWeight: true }) <= 2);
  const state = {};
  R.observe(state, 'm', 'u', { hitTokens: 50, promptTokens: 100, ok: true }, Date.now(), { infoWeight: true, refTokens: 100 });
  const u = state.m.upstreams.u;
  // w=1 at ref；h=0.5 → a=6.5 b=4.5
  assert.ok(Math.abs(u.a - 6.5) < 1e-9);
});

test('D3：冷启动/滞回不坏（replay 仍偏好缓存亲和）', () => {
  const prices = [
    { slug: 'p1', pMiss: 0.22, pHit: 0.05, ok: true },
    { slug: 'p2', pMiss: 0.18, pHit: 0.18, ok: true },
  ];
  const steps = [];
  for (let t = 0; t < 15; t++) {
    steps.push({ prices, promptTokens: 18000, hitTokens: t > 2 ? 12000 : 1000, ok: true });
  }
  const res = R.replay(steps, { prefixTokens: 18000 });
  assert.ok(res.switches <= 2, 'switches=' + res.switches);
  assert.strictEqual(res.current, 'p1');
});
