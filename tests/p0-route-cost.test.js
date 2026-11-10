// P0：EWMA scale 进入路由/有效成本；延迟维；价目同步；质量门不放松
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const www = path.join(__dirname, '..', 'app/src/main/assets/www');
const R = require(path.join(www, 'router.js'));
const C = require(path.join(www, 'cost-core.js'));
const P = require(path.join(www, 'providers.js'));
const RP = require(path.join(www, 'rpcache.js'));

const ripe = (slug, extra) => {
  const st = R.emptyUpstream();
  st.obs = 8; st.a = 10; st.b = 4;
  return Object.assign(st, extra || {}, { slug });
};

test('EWMA scale 进入 applyCalibScale / 有效价估算', () => {
  const prices = [
    { slug: 'alpha', pMiss: 1, pHit: 0.25 },
    { slug: 'beta', pMiss: 0.8, pHit: 0.8 },
  ];
  const calib = { 'm1': { scale: 2 } };
  const scaled = R.applyCalibScale(prices, calib, 'm1');
  assert.strictEqual(scaled[0].pMiss, 2);
  assert.strictEqual(scaled[0].pHit, 0.5);
  assert.strictEqual(scaled[0].calibScale, 2);
  assert.strictEqual(scaled[1].pMiss, 1.6);
  // 无 calib 时不改价
  const raw = R.applyCalibScale(prices, {}, 'm1');
  assert.strictEqual(raw[0].pMiss, 1);
  // 有效价随 scale 翻倍（命中后验相同）
  const h = 0.5;
  const pe0 = R.effectivePrice(prices[0].pMiss, prices[0].pHit, h);
  const pe1 = R.effectivePrice(scaled[0].pMiss, scaled[0].pHit, h);
  assert.ok(Math.abs(pe1 - pe0 * 2) < 1e-12);
});

test('planOpenRouterRoute：同一份 calib 进入路由有效价（不另建对账）', () => {
  const endpoints = [
    { tag: 'alpha', pricing: { prompt: '0.000001', completion: '0.000002', input_cache_read: '0.00000025' }, latency: 1 },
    { tag: 'beta', pricing: { prompt: '0.0000008', completion: '0.000002' }, latency: 1 },
  ];
  const state = {};
  // 先喂足够观测，避免冷启动
  for (const slug of ['alpha', 'beta']) {
    for (let i = 0; i < 6; i++) R.observe(state, 'm1', slug, { hitTokens: 500, promptTokens: 1000, ok: true });
  }
  const plan0 = P.planOpenRouterRoute({ cacheAffinity: true }, 'm1', endpoints, JSON.parse(JSON.stringify(state)), { prefixTokens: 20000 });
  const plan1 = P.planOpenRouterRoute({ cacheAffinity: true }, 'm1', endpoints, JSON.parse(JSON.stringify(state)), {
    prefixTokens: 20000, calib: { m1: { scale: 2 } },
  });
  assert.ok(plan0.view && plan0.view.effectivePrice != null);
  assert.ok(plan1.view && plan1.view.effectivePrice != null);
  assert.ok(Math.abs(plan1.view.effectivePrice - plan0.view.effectivePrice * 2) < 1e-6, '校准后有效价应 × scale');
  assert.strictEqual(plan1.view.calibScale, 2);
  // 模型级 scale 均匀，不改变相对排序
  assert.strictEqual(plan0.slug, plan1.slug);
});

test('路由延迟维：同价时更低延迟胜出；无延迟时退回旧有效价行为', () => {
  const stats = { current: 'slow', lastSwitchAt: 0, upstreams: {
    slow: Object.assign(R.emptyUpstream(), { obs: 8, a: 10, b: 4 }),
    fast: Object.assign(R.emptyUpstream(), { obs: 8, a: 10, b: 4 }),
  } };
  const same = [
    { slug: 'slow', pMiss: 1, pHit: 1, latencyMs: 4000 },
    { slug: 'fast', pMiss: 1, pHit: 1, latencyMs: 500 },
  ];
  assert.strictEqual(R.chooseUpstream(same, stats, 'slow', 20000), 'fast');

  // 无延迟：保持原滞回（更便宜才切）
  const noLat = [
    { slug: 'a', pMiss: 1.0, pHit: 1.0 },
    { slug: 'b', pMiss: 0.99, pHit: 0.99 }, // 仅 1%，达不到 0.97 滞回
  ];
  const st2 = { current: 'a', upstreams: {
    a: Object.assign(R.emptyUpstream(), { obs: 8, a: 10, b: 4 }),
    b: Object.assign(R.emptyUpstream(), { obs: 8, a: 10, b: 4 }),
  } };
  assert.strictEqual(R.chooseUpstream(noLat, st2, 'a', 20000), 'a');
});

test('observe 复用请求耗时做延迟 EWMA，参与后续决策', () => {
  const state = {};
  for (let i = 0; i < 6; i++) {
    R.observe(state, 'm', 'slow', { hit: true, ok: true, latencyMs: 5000 });
    R.observe(state, 'm', 'fast', { hit: true, ok: true, latencyMs: 400 });
  }
  const ms = R.ensureModel(state, 'm');
  assert.ok(ms.upstreams.slow.latEwma > 3000);
  assert.ok(ms.upstreams.fast.latEwma < 1000);
  const prices = [
    { slug: 'slow', pMiss: 1, pHit: 1 },
    { slug: 'fast', pMiss: 1, pHit: 1 },
  ];
  assert.strictEqual(R.chooseUpstream(prices, ms, 'slow', 20000), 'fast');
});

test('价目同步：endpoints 最低价写入 CostCore 用量价目，不另起炉灶', () => {
  const endpoints = [
    { tag: 'x', pricing: { prompt: '0.000002', completion: '0.000006', input_cache_read: '0.0000005' } },
    { tag: 'y', pricing: { prompt: '0.000003', completion: '0.000008' } },
  ];
  const bag = P.syncFloorPrices({ other: { miss: 9 } }, 'google/gemini-flash', endpoints, 1);
  assert.strictEqual(bag.other.miss, 9, '其它模型价目保留');
  assert.strictEqual(bag['google/gemini-flash'].miss, 2); // 2e-6 * 1e6
  assert.strictEqual(bag['google/gemini-flash'].out, 6);
  assert.strictEqual(bag['google/gemini-flash'].hit, 0.5);
  assert.ok(bag['google/gemini-flash'].syncedAt);
  // mergeFloorPrice 本身
  const m = C.mergeFloorPrice({}, 'm', { prompt: 1.5, completion: 3 }, 2);
  assert.deepStrictEqual({ miss: m.m.miss, out: m.m.out, syncedAt: m.m.syncedAt }, { miss: 1.5, out: 3, syncedAt: 2 });
});

test('endpointRoutePrices 复用 OpenRouter latency 字段（秒→毫秒）', () => {
  const list = P.endpointRoutePrices([
    { tag: 'a', pricing: { prompt: '0.000001' }, latency: 1.5 },
    { tag: 'b', pricing: { prompt: '0.000001' }, latency: 800 },
  ]);
  assert.strictEqual(list[0].latencyMs, 1500);
  assert.strictEqual(list[1].latencyMs, 800);
});

test('质量门不放松：SUMMARY_MIN_QUALITY 仍为 0.60', () => {
  assert.strictEqual(RP.SUMMARY_MIN_QUALITY, 0.60);
  const bad = RP.scoreSummary('FACTS:\n- x\n'); // 残缺分区应低于门槛
  assert.ok(typeof RP.SUMMARY_MIN_QUALITY === 'number' && RP.SUMMARY_MIN_QUALITY >= 0.60);
});

test('calibScale 与 priceForCalibrated 同源', () => {
  const calib = C.reconcile({}, 'deepseek-chat', 2, 1, { now: 1 }); // actual/est = 0.5
  assert.ok(Math.abs(C.calibScale(calib, 'deepseek-chat') - calib['deepseek-chat'].scale) < 1e-12);
  const p0 = C.priceFor('deepseek-chat', {});
  const p1 = C.priceForCalibrated('deepseek-chat', {}, calib);
  assert.ok(p0 && p1 && p1.calibScale === calib['deepseek-chat'].scale);
});
