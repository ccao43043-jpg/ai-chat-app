// 缓存经济 C：C-2 层序与 summary|memory 断点、C-3 Beta 后验命中率、C-1 摘要时机两分支
const test = require('node:test');
const assert = require('node:assert');
const Plugins = require('../app/src/main/assets/www/plugins.js');
const R = require('../app/src/main/assets/www/rpcache.js');
global.window = global.window || {};
Object.assign(global.window, { Plugins, RPCache: R });
if (!Plugins.registry.get('rpcache')) require('../app/src/main/assets/www/rp-plugin.js');
const P = require('../app/src/main/assets/www/providers.js');
const I = Plugins.registry.get('rpcache')._internals;
const QW = Object.assign({ apiKey: 'sk', id: 'qwen' }, P.PRESETS.find(p => p.presetId === 'qwen'));

function stWith(mem) {
  let st = R.setBlock(R.normalizeState(null), 'character', '角色'.repeat(1500), 1).state;
  if (mem) st = R.setBlock(st, 'memory', mem, 1).state;
  st = R.addChapter(st, { content: 'FACTS:\n- ' + '章节'.repeat(400), coveredIds: [], at: 1 });
  return st;
}
const items = [{ id: 'u1', role: 'user', content: '你好' }, { id: 'a1', role: 'assistant', content: '嗯' }, { id: 'u2', role: 'user', content: '继续' }];

test('C-2：system 层序 static → summary → memory；memory 变化不影响 static+summary 前缀', () => {
  const p1 = R.plan(stWith('记忆一'), 'SYS', items), p2 = R.plan(stWith('记忆二改了'), 'SYS', items);
  const s = p1.system;
  assert.ok(s.indexOf('[CHAPTER_SUMMARY') < s.indexOf('[LONG_TERM_MEMORY]'));
  assert.ok(s.startsWith(p1.stablePrefix) && p2.system.startsWith(p1.stablePrefix), 'memory 变化后稳定前缀不变');
  assert.strictEqual(p1.stablePrefix, p2.stablePrefix);
});

test('C-2：placeMarkers 在 summary|memory 交界加第二个断点，总数 ≤ maxMarkers', () => {
  const cap = { explicit: { maxMarkers: 4, minTokens: 1024 } };
  const p = R.plan(stWith('记忆'), 'SYS', items); const a = R.assemble(p);
  const m = I.placeMarkers(a, p, cap);
  assert.strictEqual(m.systemSplit, p.stablePrefix.length);
  assert.ok(m.system && m.history >= 0 && m.count === 3 && m.count <= 4);
  // maxMarkers=2：保留 system + 历史，不加交界断点
  const m2 = I.placeMarkers(R.assemble(p), p, { explicit: { maxMarkers: 2, minTokens: 1024 } });
  assert.strictEqual(m2.systemSplit, null); assert.strictEqual(m2.count, 2);
  // 没有 memory：不加
  const p3 = R.plan(stWith(''), 'SYS', items);
  assert.strictEqual(I.placeMarkers(R.assemble(p3), p3, cap).systemSplit, null);
  // providers：两段 system，各带 cache_control
  const body = JSON.parse(P.buildChatRequest(QW, 'qwen3.7-plus', a.messages, a.system, { cacheControl: true, cacheSystem: true, cacheSystemSplit: m.systemSplit }).body);
  const sc = body.messages[0].content;
  assert.ok(Array.isArray(sc) && sc.length === 2 && sc.every(x => x.cache_control));
  assert.strictEqual(sc[0].text + sc[1].text, a.system);
  assert.strictEqual(sc[0].text, p.stablePrefix);
});

test('C-3：Beta 后验悲观分位：先验、少量样本、多样本收敛', () => {
  const b0 = R.hitPosterior([]);
  assert.strictEqual(b0.alpha, 6); assert.strictEqual(b0.beta, 4);
  const sd0 = Math.sqrt(24 / (100 * 11));
  assert.ok(Math.abs(b0.q - (0.6 - 1.28 * sd0)) < 1e-12);
  // 少量样本（全命中，但 token 少）：仍被先验拉住
  const few = R.hitPosterior([{ hit: 1, prompt: 1 }, { hit: 1, prompt: 1 }]);
  assert.ok(few.mean < 0.7 && few.q < few.mean);
  // 多样本：收敛到真实命中率 0.9
  const mid = R.hitPosterior(Array.from({ length: 20 }, () => ({ hit: 900, prompt: 1000 })));
  const many = R.hitPosterior(Array.from({ length: 2000 }, () => ({ hit: 900, prompt: 1000 })));
  assert.ok(b0.q < mid.q && mid.q < many.q, '样本越多悲观分位越接近真实值');
  assert.ok(Math.abs(many.mean - 0.9) < 0.002 && Math.abs(many.q - 0.9) < 0.015);
  // runtimeEnv 从日志的 cache_hit_tokens / prompt_tokens 累计
  const logs = [{ supported: true, prompt_tokens: 100, cache_hit_tokens: 80, timestamp: 1 }];
  const env = R.runtimeEnv(logs, 2, {});
  assert.ok(Math.abs(env.hitPost.alpha - 6.8) < 1e-9 && Math.abs(env.hitPost.beta - 4.2) < 1e-9); assert.strictEqual(env.hitPost.n, 1);
});

// C-1：两分支比较
function adaptEnv(over) {
  return Object.assign({ cold: false, hitRate: 0.9, hitSamples: 5, hitPost: R.hitPosterior(Array.from({ length: 2000 }, () => ({ hit: 95, prompt: 100 }))), strategy: 'implicit', warm: 1,
    cost: { model: 'deepseek-chat', at: Date.UTC(2026, 0, 1, 4) } }, over || {});
}
function bigPlan(histTurns, opts) {
  opts = opts || {};
  let st = R.normalizeState(null);
  st.settings.summary = Object.assign({}, st.settings.summary, { trigger_tokens: opts.trigger || 2000, min_new_turns: 3, keep_recent_turns: 2, min_interval_turns: 0 });
  const it = [];
  for (let i = 1; i <= histTurns; i++) { it.push({ id: 'u' + i, role: 'user', content: '剧情'.repeat(opts.len || 200) }); it.push({ id: 'a' + i, role: 'assistant', content: '回复'.repeat(opts.len || 200) }); }
  it.push({ id: 'uX', role: 'user', content: '下一步' });
  return R.plan(st, 'SYS', it);
}

test('C-1：明显该摘时选 now', () => {
  const p = bigPlan(30);
  const r = R.adaptiveSummary(p, adaptEnv({ hitPost: R.hitPosterior([]) , hitRate: 0.2 }));
  assert.ok(r.costNow != null && r.costLate != null);
  assert.strictEqual(r.choice, 'now'); assert.strictEqual(r.reason, 'adaptive');
  assert.ok(r.costNow < r.costLate);
});

test('C-1：质量差时 cost_now 加 15% 风险罚，更倾向 late', () => {
  const p = bigPlan(30);
  const good = R.adaptiveSummary(p, adaptEnv({ hitPost: R.hitPosterior([]) }));
  const bad = R.adaptiveSummary(p, adaptEnv({ hitPost: R.hitPosterior([]), summaryQuality: 0.4 }));
  assert.ok(Math.abs(bad.costNow - good.costNow * 1.15) < 1e-12);
  assert.strictEqual(bad.costLate, good.costLate);
  assert.ok(bad.qualityPenalty && !good.qualityPenalty);
});

test('C-1：明显不该摘时选 late（高命中、批次小）', () => {
  const p = bigPlan(8, { len: 160, trigger: 2500 });
  const r = R.adaptiveSummary(p, adaptEnv());
  assert.ok(r.costNow != null, r.why);
  assert.strictEqual(r.choice, 'late'); assert.strictEqual(r.reason, null);
  assert.ok(r.costNow >= r.costLate);
});
