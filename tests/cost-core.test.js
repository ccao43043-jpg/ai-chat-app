const test = require('node:test');
const assert = require('node:assert');
const C = require('../app/src/main/assets/www/cost-core.js');
const R = require('../app/src/main/assets/www/rpcache.js');
const U = require('../app/src/main/assets/www/usage-stats.js');

test('D1：三入口 priceFor 同源（千问不再被 default 高估）', () => {
  const q = 'qwen3.7-plus';
  const cp = C.priceFor(q, {});
  const rp = R.priceFor(q, R.DEFAULT_PRICES);
  const up = U.priceFor(q, U.DEFAULT_PRICES);
  assert.ok(cp && rp && up);
  assert.strictEqual(cp.miss, rp.miss);
  assert.strictEqual(cp.out, rp.out);
  assert.ok(Math.abs(up.miss - cp.miss) < 1e-12, 'usage-stats 应命中 builtin 而非 default=0.5');
  assert.ok(up.miss < 0.5, '千问 miss 应远低于 default 0.5');
  assert.ok(cp.builtin && cp.peak === false);
});

test('D1：同输入三入口 cost 一致（rpcache 对象 / usage 数字 / CostCore）', () => {
  const at = Date.parse('2026-10-06T10:00:00+08:00');
  const model = 'qwen3.7-plus';
  const rpc = {
    model, supported: true, timestamp: at,
    prompt_tokens: 10000, cache_hit_tokens: 8000, cache_miss_tokens: 2000,
    completion_tokens: 500, cache_mode: 'implicit',
  };
  const entry = U.makeEntry({
    usage: { prompt: 10000, completion: 500, hit: 8000, miss: 2000, cacheSupported: true },
    at, model, key: 't1',
  });
  const a = C.costOf(rpc, {}, 'auto');
  const b = R.costOf(rpc, R.DEFAULT_PRICES, 'auto');
  const c = U.costOf(entry, U.DEFAULT_PRICES, 'auto');
  assert.ok(a && b);
  assert.ok(Math.abs(a.actual - b.actual) < 1e-12);
  assert.ok(Math.abs(a.actual - c) < 1e-12, `core=${a.actual} usage=${c}`);
});

test('D1：DeepSeek 高峰回归与旧 usage-stats 数值一致', () => {
  const peakAt = Date.parse('2026-10-06T10:00:00+08:00');
  const e1 = U.makeEntry({
    usage: { prompt: 1e6, completion: 1e6, hit: 5e5, miss: 5e5, cacheSupported: true },
    at: peakAt, model: 'deepseek-flash', key: 'p',
  });
  assert.ok(Math.abs(U.costOf(e1, U.DEFAULT_PRICES, 'peak') - 1.353) < 1e-9);
});

test('D2：EWMA 对账 scale 收敛 + 连续失真标记', () => {
  let calib = C.emptyCalib();
  // est 一直高估 2× → actual/est=0.5
  for (let i = 0; i < 5; i++) {
    calib = C.reconcile(calib, 'm1', 2.0, 1.0);
  }
  const v = C.calibView(calib, 'm1');
  assert.ok(v.n === 5);
  assert.ok(v.scale < 0.85 && v.scale > 0.4, 'scale=' + v.scale);
  assert.ok(v.distorted, '连续 |bias|>15% 应标记失真');
  assert.ok(C.distortedModels(calib).some(x => x.model === 'm1'));
});

test('D2：makeEntry 写入 actualCost；reconcileEntry 更新 state.calib', () => {
  const e = U.makeEntry({
    usage: { prompt: 1e6, completion: 0, hit: 0, miss: 1e6, cacheSupported: true, cost: 0.15 },
    at: Date.parse('2026-10-06T10:00:00+08:00'), model: 'deepseek-flash', key: 'c1',
  });
  assert.strictEqual(e.actualCost, 0.15);
  // peak miss-only 1e6 * 0.3 / 1e6 = 0.3；actual 0.15 → bias 100%
  let s = U.emptyState();
  s = U.record(s, e);
  s = U.reconcileEntry(s, e, 'peak');
  assert.ok(s.calib['deepseek-flash']);
  assert.ok(s.calib['deepseek-flash'].n >= 1);
  assert.ok(Math.abs(s.calib['deepseek-flash'].lastActual - 0.15) < 1e-12);
});

test('D2：校准后 priceForCalibrated 缩放价目', () => {
  const calib = C.reconcile({}, 'deepseek-flash', 1.0, 0.5); // scale ← 0.3*0.5 + 0.7*1 = 0.85
  const p0 = C.priceFor('deepseek-flash', {});
  const p1 = C.priceForCalibrated('deepseek-flash', {}, calib);
  assert.ok(Math.abs(p1.miss - p0.miss * calib['deepseek-flash'].scale) < 1e-9);
});
