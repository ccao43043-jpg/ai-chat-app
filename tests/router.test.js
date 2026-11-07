const test = require('node:test');
const assert = require('node:assert');
const R = require('../app/src/main/assets/www/router.js');

test('effectivePrice：命中拉低有效价', () => {
  const pe = R.effectivePrice(0.20, 0.04, 0.70);
  assert.ok(Math.abs(pe - 0.088) < 1e-9);
  assert.ok(pe < R.effectivePrice(0.16, 0.16, 0.70));
});

test('chooseUpstream：冷启动维持 current', () => {
  const prices = [
    { slug: 'a', pMiss: 0.2, pHit: 0.05, ok: true },
    { slug: 'b', pMiss: 0.1, pHit: 0.1, ok: true },
  ];
  const stats = { upstreams: {
    a: { a: 6, b: 4, obs: 2, fails: 0 },
    b: { a: 6, b: 4, obs: 1, fails: 0 },
  }};
  assert.strictEqual(R.chooseUpstream(prices, stats, 'a', 20000), 'a');
});

test('chooseUpstream：明显更优才切换（滞回）', () => {
  const prices = [
    { slug: 'alpha', pMiss: 0.50, pHit: 0.40, ok: true },
    { slug: 'beta', pMiss: 0.10, pHit: 0.02, ok: true },
  ];
  const stats = { upstreams: {
    alpha: { a: 20, b: 80, obs: 10, fails: 0 },
    beta: { a: 80, b: 20, obs: 10, fails: 0 },
  }};
  assert.strictEqual(R.chooseUpstream(prices, stats, 'alpha', 20000), 'beta');
});

test('chooseUpstream：高命中贵表价胜过无缓存低表价', () => {
  const prices = [
    { slug: 'alpha', pMiss: 0.20, pHit: 0.04, ok: true },
    { slug: 'beta', pMiss: 0.16, pHit: 0.16, ok: true },
  ];
  const stats = { upstreams: {
    alpha: { a: 70, b: 30, obs: 10, fails: 0 },
    beta: { a: 6, b: 4, obs: 10, fails: 0 },
  }};
  assert.strictEqual(R.chooseUpstream(prices, stats, 'alpha', 20000), 'alpha');
});

test('熔断：fails>=3 跳过', () => {
  const prices = [
    { slug: 'a', pMiss: 0.05, pHit: 0.05, ok: true },
    { slug: 'b', pMiss: 0.20, pHit: 0.04, ok: true },
  ];
  const stats = { upstreams: {
    a: { a: 50, b: 50, obs: 10, fails: 3 },
    b: { a: 50, b: 50, obs: 10, fails: 0 },
  }};
  assert.strictEqual(R.chooseUpstream(prices, stats, 'a', 10000), 'b');
});

test('buildProviderField：开/关', () => {
  assert.deepStrictEqual(R.buildProviderField('x', { enabled: true }).order, ['x']);
  assert.strictEqual(R.buildProviderField(null, { enabled: false }).sort, 'price');
});

test('replay：切换次数受滞回约束', () => {
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
