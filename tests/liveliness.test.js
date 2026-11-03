const test = require('node:test');
const assert = require('node:assert');
const L = require('../app/src/main/assets/www/liveliness.js');

test('TC-01 半衰期衰减', () => { const s = L.newState('d', 0); s.vars.tension = 0.8; L.applyDecay(s, 7200); assert.ok(Math.abs(s.vars.tension - 0.4) < 1e-6); });
test('TC-02/03 道歉与单轮钳制', () => {
  const s = L.newState('d', 0);
  let r = L.step(s, ['insult_or_harsh', 'insult_or_harsh'], 1);
  for (const k in r.after) assert.ok(Math.abs(r.after[k] - r.before[k]) <= L.MAX_DELTA_PER_TURN + 1e-9);
  r = L.step(s, ['user_apology'], 2); assert.ok(r.after.tension < r.before.tension && r.after.valence > r.before.valence);
});
test('TC-04 5 档', () => assert.deepStrictEqual([0.1, 0.3, 0.5, 0.7, 0.9].map(w => L.level(L.newState('x', 0), w, 0)[0]), [1, 2, 3, 4, 5]));
test('TC-05 底线硬约束', () => {
  const s = L.newState('d', 0); s.vars.affection = 1; s.vars.trust = 1;
  let r = L.step(s, ['boundary_violation', 'user_compliment'], 10); assert.strictEqual(r.level, 1); assert.ok(r.hard_floor);
  r = L.step(s, ['user_compliment'], 10 + L.HARD_FLOOR_LOCK_SEC + 1); assert.ok(!r.hard_floor);
});
test('TC-07 阶段迟滞', () => {
  const s = L.newState('h', 0); s.vars.trust = 0.4; s.vars.affection = 0.31;
  L.updateStage(s); assert.strictEqual(s.stage, 0); L.updateStage(s); L.updateStage(s); assert.strictEqual(s.stage, 1);
  s.vars.trust = 0.22; for (let i = 0; i < 5; i++) L.updateStage(s); assert.strictEqual(s.stage, 1);
});
test('TC-08 注入块离散稳定、无浮点', () => {
  const s = L.newState('c', 0); const a = L.renderInjection(s, 0); s.vars.valence += 0.01; const b = L.renderInjection(s, 0);
  assert.strictEqual(a, b); assert.ok(a.startsWith('[STATE] mood=')); assert.ok(!/\d\.\d/.test(a));
});
test('事件识别', () => {
  assert.deepStrictEqual(L.detectEvents('对不起，谢谢你', 0).sort(), ['user_apology', 'user_thanks']);
  assert.ok(L.detectEvents('滚', 0).includes('insult_or_harsh'));
  assert.ok(L.detectEvents('hi', 7 * 3600).includes('long_absence_return'));
  assert.deepStrictEqual(L.detectEvents('今天天气不错', 0), []);
});
test('插件：只改最后一条用户消息、不改系统提示词、重新生成不重复计', async () => {
  globalThis.Plugins = require('../app/src/main/assets/www/plugins.js');
  delete require.cache[require.resolve('../app/src/main/assets/www/liveliness.js')];
  require('../app/src/main/assets/www/liveliness.js');
  const pl = Plugins.registry.get('liveliness'); assert.ok(pl);
  const mem = {}, logs = [];
  const host = { store: { get: (n, d) => mem[n] || d, set: (n, v) => { mem[n] = v; }, append: (n, v) => logs.push(v) } };
  const lastUser = { id: 'u1', content: '谢谢你' };
  const mk = () => ({ conv: { id: 'c1', personaId: 'p1' }, systemPrompt: 'SYS', lastUser, meta: {}, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: '谢谢你' }] });
  const c1 = pl.hooks.onBeforeRequest(mk(), host);
  assert.strictEqual(c1.systemPrompt, 'SYS'); assert.strictEqual(c1.messages[0].content, 'a');
  assert.ok(c1.messages[2].content.includes('[STATE]'));
  pl.hooks.onBeforeRequest(mk(), host);
  assert.strictEqual(logs.length, 1); assert.ok(mem['liveliness-state.json']['persona:p1']);
});
