const test = require('node:test');
const assert = require('node:assert');
globalThis.Plugins = require('../app/src/main/assets/www/plugins.js');
const M = require('../app/src/main/assets/www/rpmemory.js');
const E = (id, text, extra = {}) => Object.assign({ id, type: 'fact', text, keywords: [], seq: id }, extra);

test('terms：中文 bigram + 英文 \\w+', () => {
  assert.deepStrictEqual(M.terms('青铜钥匙 Key2'), ['key2', '青铜', '铜钥', '钥匙']);
});
test('IDF：稀有词胜过高频词', () => {
  const list = [E(1, '你说你好你来了'), E(2, '你看到青铜钥匙'), E(3, '你去了集市'), E(4, '你很累')];
  const idx = M.buildIndex(list);
  assert.ok(idx.df['青铜'] === 1 && idx.N === 4);
  const sel = M.selectRelevant(list, '青铜钥匙在哪', { tau: 1e9 });
  assert.strictEqual(sel[0].id, 2);
});
test('keywords 字段权重 > text', () => {
  const list = [E(1, '一段关于龙的长篇描述', { keywords: [] }), E(2, '其他内容', { keywords: ['巨龙'] })];
  const idx = M.buildIndex(list), Q = M.buildQuery('巨龙');
  assert.ok(M.bm25f(idx, Q, list[1]) > M.bm25f(idx, Q, list[0]));
});
test('时间衰减与 open 加成', () => {
  const list = [E(1, '艾琳的秘密', { turn: 0 }), E(2, '艾琳的秘密。', { turn: 50 })];
  let sel = M.selectRelevant(list, '艾琳秘密', { nowTurn: 50, maxInject: 1, memTokens: 15 });
  assert.deepStrictEqual(sel.map(e => e.id), [2]);
  const l2 = [E(1, '艾琳秘密', { turn: 50 }), E(2, '艾琳秘密', { turn: 51, status: 'open' })];
  sel = M.selectRelevant(l2, '艾琳秘密', { nowTurn: 51, maxInject: 1, memTokens: 10 });
  assert.deepStrictEqual(sel.map(e => e.id), [2]);
});
test('MMR 去冗余 + mem_tokens 预算', () => {
  const list = [E(1, '艾琳在雨夜救了主角'), E(2, '艾琳在雨夜救了主角一命'), E(3, '艾琳是城里的药剂师')];
  const sel = M.selectRelevant(list, '艾琳雨夜药剂师', { tau: 1e9, memTokens: 30 });
  assert.ok(sel.some(e => e.id === 3), '多样性条目入选');
  assert.ok(M.selectRelevant(list, '艾琳', { memTokens: 0 }).length === 0);
});
test('索引签名复用与失效', () => {
  const list = [E(1, 'a b')]; const i1 = M.buildIndex(list);
  assert.strictEqual(M.buildIndex(list, i1), i1);
  assert.notStrictEqual(M.buildIndex([E(1, 'a b', { updatedAt: 9 })], i1), i1);
});
test('回退开关 retrieval=legacy 走旧打分', () => {
  assert.strictEqual(M.settingsOf({ retrieval: 'legacy' }).retrieval, 'legacy');
  assert.strictEqual(M.settingsOf({}).retrieval, 'bm25');
  const list = [E(1, '艾琳是药剂师', { keywords: ['艾琳'] })];
  assert.strictEqual(M.selectRelevant(list, '艾琳', { retrieval: 'legacy' })[0].id, 1);
});
