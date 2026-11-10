// feat(eval) §9 门禁：golden set 指标不得劣于 tests/golden/baseline.json（含 routing/knowledge/affect）
const test = require('node:test');
const assert = require('node:assert');
const core = require('../scripts/lib/eval-core.js');

test('eval 门禁：golden 规模达标、expect 与 entry id 对齐', () => {
  assert.ok(core.readJsonl('memory.jsonl').length >= 20);
  assert.ok(core.readJsonl('summary.jsonl').length >= 10);
  assert.ok(core.readJsonl('cost.jsonl').length >= 5);
  assert.ok(core.readJsonl('routing.jsonl').length >= 15);
  assert.ok(core.readJsonl('knowledge.jsonl').length >= 25);
  assert.ok(core.readJsonl('affect.jsonl').length >= 20);
  assert.ok(core.readJsonl('oplog.jsonl').length >= 5);
  core.readJsonl('memory.jsonl').forEach(c => { const ids = new Set(c.conv.entries.map(e => e.id)); c.expect.forEach(id => assert.ok(ids.has(id), c.id + ' expect ' + id)); });
  core.readJsonl('knowledge.jsonl').forEach(c => {
    const ids = new Set();
    (c.doc.categories || []).forEach(cat => (cat.entries || []).forEach(e => ids.add(e.id)));
    (c.expect || []).forEach(id => assert.ok(ids.has(id), c.id + ' expect ' + id));
  });
});
test('eval 门禁：指标计算标准定义自检', () => {
  const m = core.rankMetrics(['a', 'b', 'c'], ['b'], 5); assert.strictEqual(m.rr, 0.5); assert.strictEqual(m.p, 1);
  assert.deepStrictEqual(core.rankMetrics([], [], 5), { p: 1, rr: 1, ndcg: 1 });
});
test('eval 门禁：当前实现不劣于 baseline', () => {
  assert.deepStrictEqual(core.compare(core.runAll(), core.loadBaseline()), []);
});
test('eval 门禁：cost 回放确定性', () => {
  assert.strictEqual(core.evalCost().totalPromptTokens, core.evalCost().totalPromptTokens);
});
test('eval 门禁：routing/knowledge/affect/oplog 可计算', () => {
  const r = core.evalRouting();
  assert.ok(r.n >= 15);
  const k = core.evalKnowledge();
  assert.ok(k.n >= 25);
  assert.ok(k.pAt5 >= 0);
  const a = core.evalAffect();
  assert.ok(a.n >= 20);
  assert.ok(a.directionAgree >= 0);
  const o = core.evalOplog();
  assert.ok(o.n >= 5);
  assert.strictEqual(o.passRate, 1);
});
