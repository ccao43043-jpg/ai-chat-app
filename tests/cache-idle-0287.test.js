// v0.28.7：空闲后钉住上次上游 + OpenRouter 稳定 session_id + DeepSeek 空闲不提前摘要
const test = require('node:test');
const assert = require('node:assert');
const Router = require('../app/src/main/assets/www/router.js');
const P = require('../app/src/main/assets/www/providers.js');
const C = require('../app/src/main/assets/www/plugins/cache/cache-common.js');
const R = require('../app/src/main/assets/www/rpcache.js');

const HOUR = 3600e3;
const now = 1e12;
// b 比 a 略便宜（有效分 < a × 0.97，且省下的钱 × dwell > 切换成本 → 非空闲时会切）
const prices = [
  { slug: 'a', pMiss: 0.30, pHit: 0.29, ok: true },
  { slug: 'b', pMiss: 0.25, pHit: 0.24, ok: true },
];
const statsAt = (lastAt, extraA) => ({ current: 'a', upstreams: {
  a: Object.assign({ a: 8, b: 2, obs: 10, fails: 0, lastAt }, extraA || {}),
  b: { a: 8, b: 2, obs: 10, fails: 0, lastAt: lastAt - 1000 },
} });

test('空闲前：略便宜的上游仍按原规则可以切换（基线不变）', () => {
  assert.strictEqual(Router.chooseUpstream(prices, statsAt(now - 60e3), 'a', 20000, { now }), 'b');
});

test('空闲 ≥ 60 分钟：current 仍可用就钉住，不因略便宜切走', () => {
  assert.strictEqual(Router.chooseUpstream(prices, statsAt(now - 61 * 60e3), 'a', 20000, { now }), 'a');
  assert.strictEqual(Router.chooseUpstream(prices, statsAt(now - 3 * HOUR), 'a', 20000, { now }), 'a');
  assert.strictEqual(Router.chooseUpstream(prices, statsAt(now - 48 * HOUR), 'a', 20000, { now }), 'a');
  // 显式 idleMs 也生效
  assert.strictEqual(Router.chooseUpstream(prices, statsAt(now), 'a', 20000, { now, idleMs: 2 * HOUR }), 'a');
  // 别家便宜一半以上时仍允许切
  const cheap = [prices[0], { slug: 'b', pMiss: 0.10, pHit: 0.09, ok: true }];
  assert.strictEqual(Router.chooseUpstream(cheap, statsAt(now - 3 * HOUR), 'a', 20000, { now }), 'b');
});

test('空闲后：current 缺失 / ok:false / 熔断 / 刚失败 → 仍会切走', () => {
  const idle = now - 3 * HOUR;
  assert.strictEqual(Router.chooseUpstream([prices[1]], statsAt(idle), 'a', 20000, { now }), 'b', 'current 不在列表');
  assert.strictEqual(Router.chooseUpstream([Object.assign({}, prices[0], { ok: false }), prices[1]], statsAt(idle), 'a', 20000, { now }), 'b', 'ok:false');
  assert.strictEqual(Router.chooseUpstream(prices, statsAt(idle, { fails: 3 }), 'a', 20000, { now }), 'b', '熔断');
  assert.strictEqual(Router.chooseUpstream(prices, statsAt(idle, { fails: 1 }), 'a', 20000, { now }), 'b', '上次失败');
});

test('planOpenRouterRoute：空闲后沿用持久化的 ms.current，不清空', () => {
  const state = { m: statsAt(now - 5 * HOUR) };
  const endpoints = [
    { tag: 'a', provider_name: 'A', pricing: { prompt: '0.00000030', input_cache_read: '0.00000029', completion: '0.000001' } },
    { tag: 'b', provider_name: 'B', pricing: { prompt: '0.00000025', input_cache_read: '0.00000024', completion: '0.000001' } },
  ];
  const prs = P.endpointRoutePrices(endpoints);
  assert.deepStrictEqual(prs.map(x => x.slug).sort(), ['a', 'b']);
  const plan = P.planOpenRouterRoute({ presetId: 'openrouter' }, 'm', endpoints, state, { prefixTokens: 20000, routerOpts: { now } });
  assert.strictEqual(plan.slug, 'a');
  assert.deepStrictEqual(plan.providerField.order, ['a']);
  assert.strictEqual(state.m.current, 'a');
});

const OR = Object.assign({ apiKey: 'sk', id: 'or' }, P.PRESETS.find(p => p.presetId === 'openrouter'));
const msgs = [{ role: 'user', content: '你好' }];
const bodyOf = opts => JSON.parse(P.buildChatRequest(OR, 'deepseek/deepseek-chat', msgs, '设定', opts).body);

test('OpenRouter：有对话 id 时发稳定 session_id（与 cache-common 同算法，命名空间 or）', () => {
  const b1 = bodyOf({ convId: 'c1', routeSlug: 'deepinfra' });
  const b2 = bodyOf({ convId: 'c1', routeSlug: 'deepinfra' });
  assert.ok(b1.session_id && b1.session_id === b2.session_id, '同一对话恒定');
  assert.strictEqual(b1.session_id, C.sessionIdFor('c1', 'or'));
  assert.notStrictEqual(bodyOf({ convId: 'c2' }).session_id, b1.session_id, '换对话即换');
  assert.deepStrictEqual(b1.provider.order, ['deepinfra'], '钉上游不受影响');
  const fb = bodyOf({ convId: 'c1', cacheAffinity: false });
  assert.strictEqual(fb.session_id, b1.session_id, '未钉上游（排序回退）时也带 session_id');
});

test('OpenRouter：没有对话 id 不发；gcache / mmcache 生效时交给插件；插件已写的 session_id 不被覆盖', () => {
  assert.strictEqual(bodyOf({}).session_id, undefined);
  assert.strictEqual(bodyOf({ convId: '' }).session_id, undefined);
  assert.strictEqual(bodyOf({ convId: 'c1', orGemini: { sessionId: true } }).session_id, undefined);
  assert.strictEqual(bodyOf({ convId: 'c1', orMiniMax: { sessionId: true } }).session_id, undefined);
  const gcache = require('../app/src/main/assets/www/plugins/cache/gcache.js');
  const b = { session_id: 'preset' };
  gcache.OpenRouterAdapter.applySession(b, 'other');
  assert.strictEqual(b.session_id, 'preset');
  // 非 OpenRouter 不发
  const DS = Object.assign({ apiKey: 'sk', id: 'ds' }, P.PRESETS.find(p => p.presetId === 'deepseek'));
  assert.strictEqual(JSON.parse(P.buildChatRequest(DS, 'deepseek-flash', msgs, '', { convId: 'c1' }).body).session_id, undefined);
});

function longItems(rounds, len) {
  const items = [];
  for (let i = 0; i < rounds; i++) { items.push({ id: 'u' + i, role: 'user', content: '行动' + i + '剧情'.repeat(len) }); items.push({ id: 'a' + i, role: 'assistant', content: '回复' + i + '描写'.repeat(len) }); }
  items.push({ id: 'in', role: 'user', content: '本轮' });
  return items;
}

test('DeepSeek：空闲超过估计 TTL 也不走「缓存已冷 → 提前摘要」；短 TTL 千问仍可以', () => {
  const DS = Object.assign({ apiKey: 'sk', id: 'ds' }, P.PRESETS.find(p => p.presetId === 'deepseek'));
  const QW = Object.assign({ apiKey: 'sk', id: 'qw' }, P.PRESETS.find(p => p.presetId === 'qwen'));
  const dsCap = R.capability(DS, 'deepseek-flash');
  const qwCap = R.capability(QW, 'qwen3.7-plus');
  assert.strictEqual(dsCap.vendor, 'deepseek');
  assert.strictEqual(dsCap.ttl, 24 * 3600, 'DeepSeek TTL 保守 24h');
  const st = R.normalizeState(null);
  st.settings.summary = Object.assign({}, st.settings.summary, { trigger_tokens: 10000, min_new_turns: 6, keep_recent_turns: 4, min_interval_turns: 4 });
  const items = longItems(30, 120);
  const base = R.plan(st, '', items);
  assert.ok(!base.needSummary, '未到固定阈值');
  const ds = R.plan(st, '', items, { cap: dsCap, cold: true, idleSec: 3 * 86400, warm: 0, cost: { model: 'deepseek-flash', prices: R.DEFAULT_PRICES, at: 0 } });
  assert.notStrictEqual(ds.summaryReason, 'cold', 'DeepSeek 不因空闲提前摘要');
  assert.ok(ds.auto && ds.auto.coldKept);
  const qw = R.plan(st, '', items, { cap: qwCap, cold: true, idleSec: 900, warm: 0, cost: { model: 'qwen3.7-plus', prices: R.DEFAULT_PRICES, at: 0 } });
  assert.strictEqual(qw.summaryReason, 'cold', '千问短 TTL 仍趁重建提前摘要');
  // runtimeEnv：DeepSeek 超过 TTL 时 cold 仅作提示，coldRebuild=false、warm=1
  const t0 = 1e12; const logs = [0, 60, 120].map(s => ({ timestamp: t0 + s * 1000, supported: true, hit_rate: 0.9 }));
  const e1 = R.runtimeEnv(logs, t0 + 120e3 + 3 * HOUR, dsCap);
  assert.strictEqual(e1.cold, false, '3 小时不算过期');
  const e2 = R.runtimeEnv(logs, t0 + 120e3 + 30 * HOUR, dsCap);
  assert.deepStrictEqual([e2.cold, e2.coldRebuild, e2.warm], [true, false, 1]);
  const e3 = R.runtimeEnv(logs, t0 + 120e3 + 601e3, qwCap);
  assert.deepStrictEqual([e3.cold, e3.coldRebuild, e3.warm], [true, true, 0]);
});

test('DeepSeek：空闲后也不趁「缓存已冷」提前合并章节', () => {
  const DS = Object.assign({ apiKey: 'sk', id: 'ds' }, P.PRESETS.find(p => p.presetId === 'deepseek'));
  let st = R.normalizeState(null);
  st.settings.summary = Object.assign({}, st.settings.summary, { trigger_tokens: 2000, min_new_turns: 3, keep_recent_turns: 2, min_interval_turns: 0, chapter_cap_tokens: 1000 });
  st = R.addChapter(st, { content: '章'.repeat(500), coveredIds: [], at: 1 });
  st = R.addChapter(st, { content: '节'.repeat(500), coveredIds: [], at: 2 });
  const items = longItems(12, 200);
  assert.ok(!R.plan(st, '', items, { cap: R.capability(DS, 'deepseek-flash'), cold: true, warm: 0 }).needConsolidate);
  assert.ok(R.plan(st, '', items, { cold: true, warm: 0 }).needConsolidate, '无 cap 时与旧行为一致');
});
