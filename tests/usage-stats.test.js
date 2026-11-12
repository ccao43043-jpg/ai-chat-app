const test = require('node:test');
const assert = require('node:assert');
const U = require('../app/src/main/assets/www/usage-stats.js');

const usage = (p, c, hit, miss) => ({ prompt: p, completion: c, hit, miss, cacheSupported: hit != null });

test('record + prune 到 LOG_LIMIT', () => {
  let s = U.emptyState();
  for (let i = 0; i < 10; i++) {
    s = U.record(s, U.makeEntry({ usage: usage(100, 10), at: 1000 + i, msgId: 'm' + i, key: 'k' + i }));
  }
  assert.strictEqual(s.log.length, 10);
  // 强制小上限：直接塞满后用内部逻辑
  const lim = U.LOG_LIMIT;
  assert.ok(lim >= 100);
  let big = U.emptyState();
  for (let i = 0; i < lim + 5; i++) {
    big = U.record(big, U.makeEntry({ usage: usage(1, 1), at: i + 1, key: 'x' + i }));
  }
  assert.strictEqual(big.log.length, lim);
  assert.strictEqual(big.log[0].key, 'x5');
  assert.strictEqual(big.log[lim - 1].key, 'x' + (lim + 4));
});

test('同 key 不重复记账', () => {
  let s = U.emptyState();
  const e = U.makeEntry({ usage: usage(50, 5, 40, 10), at: 1, key: 'same' });
  s = U.record(s, e);
  s = U.record(s, U.makeEntry({ usage: usage(50, 5, 40, 10), at: 2, key: 'same' }));
  assert.strictEqual(s.log.length, 1);
});

test('聚合 totals / byDay / byModel / byProvider / byConv', () => {
  const now = Date.parse('2026-10-05T12:00:00+08:00');
  let s = U.emptyState();
  const rows = [
    { usage: usage(1000, 100, 800, 200), at: now - 864e5, model: 'deepseek-flash', providerId: 'ds', providerName: 'DeepSeek', convId: 'c1', convTitle: '甲', key: 'a' },
    { usage: usage(500, 50), at: now, model: 'gpt-4o', providerId: 'oa', providerName: 'OpenAI', convId: 'c2', convTitle: '乙', key: 'b' },
    { usage: usage(200, 20, 100, 100), at: now, model: 'deepseek-flash', providerId: 'ds', providerName: 'DeepSeek', convId: 'c1', convTitle: '甲', type: 'summary', key: 'c' },
  ];
  rows.forEach(r => { s = U.record(s, U.makeEntry(r)); });
  const range = U.rangeOf('30d', now);
  const list = U.filterLog(s.log, range);
  const t = U.sumList(list);
  assert.strictEqual(t.prompt, 1700);
  assert.strictEqual(t.completion, 170);
  assert.strictEqual(t.requests, 3);
  assert.strictEqual(t.hit, 900);
  assert.strictEqual(t.miss, 800); // 200+100 + 500(无缓存按整段 miss)
  const models = U.groupBy(list, e => e.model);
  assert.strictEqual(models[0].key, 'deepseek-flash');
  assert.strictEqual(models[0].requests, 2);
  const prov = U.groupBy(list, e => e.providerName || e.providerId);
  assert.ok(prov.find(x => x.key === 'DeepSeek').total === 1320);
  const convs = U.groupBy(list, e => e.convTitle || e.convId);
  assert.strictEqual(convs[0].key, '甲');
  const days = U.byDay(list, 3, now);
  assert.strictEqual(days.length, 3);
  assert.strictEqual(days[2].requests, 2); // 今天
  assert.strictEqual(days[1].requests, 1); // 昨天
});

test('花费估算：DeepSeek 高峰/非高峰', () => {
  // 北京时间周二 10:00 = UTC 02:00 → 高峰
  const peakAt = Date.parse('2026-10-06T10:00:00+08:00');
  const offAt = Date.parse('2026-10-05T20:00:00+08:00'); // 周日晚 → 非高峰
  const e1 = U.makeEntry({ usage: usage(1e6, 1e6, 5e5, 5e5), at: peakAt, model: 'deepseek-flash', key: 'p' });
  const e2 = U.makeEntry({ usage: usage(1e6, 0, 0, 1e6), at: offAt, model: 'deepseek-flash', key: 'o' });
  const prices = U.DEFAULT_PRICES;
  // peak: (5e5*0.006 + 5e5*0.3 + 1e6*1.2) / 1e6 = 0.003 + 0.15 + 1.2 = 1.353
  assert.ok(Math.abs(U.costOf(e1, prices, 'peak') - 1.353) < 1e-9);
  // offpeak half of miss-only input: (1e6*0.3)/1e6 * 0.5 = 0.15
  assert.ok(Math.abs(U.costOf(e2, prices, 'offpeak') - 0.15) < 1e-9);
  const est = U.estimateCost([e1, e2], prices, 'peak');
  assert.strictEqual(est.priced, 2);
  assert.ok(est.cost > 1);
});

test('回填：扫描对话 + 版本分支，不重复；第二次跳过', () => {
  const convs = [{
    id: 'c1', title: '旧', providerId: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-flash', updatedAt: 1000,
    messages: [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 100 },
      { id: 'a1', role: 'assistant', content: 'v2', createdAt: 300, usage: usage(30, 5, 10, 20), model: 'deepseek-flash',
        vi: 1, versions: [
          { content: 'v1', createdAt: 200, usage: usage(20, 4), model: 'deepseek-flash', tail: [
            { id: 'u2', role: 'user', content: 'cont', createdAt: 250 },
            { id: 'a2', role: 'assistant', content: 'old branch', createdAt: 260, usage: usage(40, 6), model: 'deepseek-flash' },
          ]},
          null,
        ]},
    ],
  }];
  let s = U.backfill(U.emptyState(), convs);
  assert.ok(s.backfilled);
  assert.strictEqual(s.log.length, 3); // v1, branch a2, current a1
  const prompts = s.log.map(e => e.prompt).sort((a, b) => a - b);
  assert.deepStrictEqual(prompts, [20, 30, 40]);
  // 再回填不变
  const s2 = U.backfill(s, convs);
  assert.strictEqual(s2.log.length, 3);
  // 直播再记同一 key 不增加
  const again = U.makeEntry({ usage: usage(30, 5, 10, 20), at: 300, msgId: 'a1',
    key: 'bf:a1:300:30:5:chat' });
  const s3 = U.record(s2, again);
  assert.strictEqual(s3.log.length, 3);
});
test('日期范围 preset 与 clear / CSV', () => {
  const now = Date.parse('2026-10-05T15:00:00+08:00');
  assert.strictEqual(U.rangeOf('today', now).from, new Date(now).setHours(0, 0, 0, 0));
  const r7 = U.rangeOf('7d', now);
  assert.ok(r7.to - r7.from >= 6 * 864e5);
  let s = U.emptyState();
  s = U.record(s, U.makeEntry({ usage: usage(10, 1), at: now, key: 'z', model: 'deepseek-flash', providerName: 'DeepSeek', convTitle: '测' }));
  const csv = U.toCSV(s.log);
  assert.ok(csv.includes('输入') && csv.includes('DeepSeek'));
  s = U.clear(s);
  assert.strictEqual(s.log.length, 0);
  assert.ok(s.backfilled);
});

// ---------- v0.28.5：部分价目 / NaN 不得让估算花费变成 $NaN ----------
const CostCore = require('../app/src/main/assets/www/cost-core.js');
const fsNan = require('fs');
const pathNan = require('path');

test('v0.28.5：价目缺 hit/out（OpenRouter 部分最低价）时 estimateCost 仍为有限数', () => {
  const prices = Object.assign({}, U.DEFAULT_PRICES, { 'vendor/partial': { miss: 0.3, source: 'openrouter-floor' } });
  const list = [
    U.makeEntry({ usage: usage(4000, 600, 3000, 1000), model: 'vendor/partial', at: 1000, key: 'p1' }),
    U.makeEntry({ usage: usage(1200, 300), model: 'deepseek-chat', at: 2000, key: 'p2' }),
  ];
  const est = U.estimateCost(list, prices, 'peak');
  assert.ok(Number.isFinite(est.cost), 'cost 应为有限数: ' + est.cost);
  assert.ok(est.cost > 0);
  assert.strictEqual(est.priced, 2);
  // 单条
  const one = CostCore.costOfEntry(list[0], prices, 'peak');
  assert.ok(Number.isFinite(one), 'costOfEntry 应为有限数: ' + one);
  // 1000 miss × 0.3 / 1e6；hit / out 缺失按 0
  assert.ok(Math.abs(one - 1000 * 0.3 / 1e6) < 1e-12, String(one));
  const raw = CostCore.costOf({ model: 'vendor/partial', prompt_tokens: 4000, cache_hit_tokens: 3000, cache_miss_tokens: 1000, completion_tokens: 600 }, prices, 'peak');
  assert.ok(Number.isFinite(raw.actual) && Number.isFinite(raw.noCache) && Number.isFinite(raw.saved), JSON.stringify(raw));
});

test('v0.28.5：价目字段为 NaN / 非数字字符串、条目 token 缺失时不污染合计', () => {
  const prices = Object.assign({}, U.DEFAULT_PRICES, {
    'bad-nan': { hit: NaN, miss: NaN, out: 'abc' },
    'str-ok': { hit: '0.1', miss: '1', out: '2' },
  });
  const list = [
    { model: 'bad-nan', at: 1, prompt: 100, completion: 10, hit: 50, miss: 50, cache: true },
    { model: 'str-ok', at: 2, prompt: 1000, completion: 1000, hit: 0, miss: 1000, cache: false },
    { model: 'deepseek-chat', at: 3, prompt: undefined, completion: undefined, cache: true },
    { model: 'unknown-x', at: 4, prompt: 100, completion: 10 }, // default 兜底分支，hit/miss 未给
  ];
  const est = U.estimateCost(list, prices, 'peak');
  assert.ok(Number.isFinite(est.cost), 'cost 应为有限数: ' + est.cost);
  assert.ok(Math.abs(CostCore.costOfEntry(list[1], prices, 'peak') - (1000 * 1 + 1000 * 2) / 1e6) < 1e-12);
});

test('v0.28.5：价目为 Infinity 时合计仍为有限数', () => {
  const prices = Object.assign({}, U.DEFAULT_PRICES, { 'inf-model': { hit: 0, miss: Infinity, out: 1 } });
  const est = U.estimateCost([{ model: 'inf-model', at: 1, prompt: 10, completion: 1, hit: 0, miss: 10, cache: false }], prices, 'peak');
  assert.ok(Number.isFinite(est.cost), 'Infinity 价目按 0 处理，合计仍为有限数: ' + est.cost);
});

test('v0.28.5：mergeFloorPrice 只给部分字段时补齐 miss/hit/out', () => {
  const a = CostCore.mergeFloorPrice({}, 'm1', { prompt: 0.3 }, 5).m1;
  assert.strictEqual(a.miss, 0.3);
  assert.ok(Number.isFinite(a.hit) && Number.isFinite(a.out), JSON.stringify(a));
  assert.strictEqual(a.out, CostCore.USAGE_DEFAULT_PRICES.default.out);
  // 旧条目有 out/hit：保留
  const b = CostCore.mergeFloorPrice({ m2: { hit: 0.02, miss: 1, out: 4 } }, 'm2', { prompt: 0.5 }, 6).m2;
  assert.deepStrictEqual({ hit: b.hit, miss: b.miss, out: b.out }, { hit: 0.02, miss: 0.5, out: 4 });
  // 只给 completion：miss 用 default 兜底
  const c = CostCore.mergeFloorPrice({}, 'm3', { completion: 2 }, 7).m3;
  assert.strictEqual(c.out, 2);
  assert.strictEqual(c.miss, CostCore.USAGE_DEFAULT_PRICES.default.miss);
  // 合并后估算不为 NaN
  const est = U.estimateCost([{ model: 'm1', at: 1, prompt: 100, completion: 50, hit: 20, miss: 80, cache: true }],
    Object.assign({}, U.DEFAULT_PRICES, { m1: a }), 'peak');
  assert.ok(Number.isFinite(est.cost) && est.cost > 0);
});

test('v0.28.5：app.js 的 usFmtUsd / fmtUsdShort 永不输出 $NaN', () => {
  const src = fsNan.readFileSync(pathNan.join(__dirname, '../app/src/main/assets/www/app.js'), 'utf8');
  const m1 = src.match(/const usFmtUsd = (v => [^\n]+);/);
  assert.ok(m1, '找不到 usFmtUsd');
  const usFmtUsd = eval(m1[1]);
  const m2 = src.match(/function fmtUsdShort\(n\) \{[\s\S]*?\n  \}/);
  assert.ok(m2, '找不到 fmtUsdShort');
  const fmtUsdShort = eval('(' + m2[0] + ')');
  [NaN, Infinity, -Infinity, undefined, null, 'abc'].forEach(v => {
    assert.doesNotMatch(String(usFmtUsd(v)), /NaN|Infinity/, 'usFmtUsd(' + String(v) + ')');
    assert.doesNotMatch(String(fmtUsdShort(v)), /NaN|Infinity/, 'fmtUsdShort(' + String(v) + ')');
  });
  assert.strictEqual(usFmtUsd(NaN), '—');
  assert.strictEqual(usFmtUsd(0.302), '$0.302');
  assert.strictEqual(fmtUsdShort(0), '$0.0');
  assert.strictEqual(fmtUsdShort(1.5), '$1.50');
});
