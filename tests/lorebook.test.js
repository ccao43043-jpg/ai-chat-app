const test = require('node:test');
const assert = require('node:assert');
const L = require('../app/src/main/assets/www/lorebook.js');
const P = require('../app/src/main/assets/www/personas.js');

test('normalize 关键词拆分与默认值', () => {
  const e = L.normalize({ title: '茶馆', keywords: '茶馆，雨夜, 灯笼', content: 'x' });
  assert.deepStrictEqual(e.keywords, ['茶馆', '雨夜', '灯笼']);
  assert.strictEqual(e.enabled, true); assert.strictEqual(e.sticky, false);
});
test('match：常驻 + 关键词命中，停用不注入', () => {
  let list = [L.normalize({ id: 'a', title: 'A', keywords: ['茶馆'], content: '茶馆设定' }),
    L.normalize({ id: 'b', title: 'B', sticky: true, content: '常驻设定' }),
    L.normalize({ id: 'c', title: 'C', keywords: ['龙'], content: '龙', enabled: false })];
  assert.deepStrictEqual(L.match(list, '去茶馆喝茶，看见龙').map(e => e.id), ['a', 'b']);
  assert.deepStrictEqual(L.match(list, '你好').map(e => e.id), ['b']);
  list = L.toggle(list, 'b');
  assert.deepStrictEqual(L.match(list, '你好'), []);
});
test('inject 拼到系统提示词后面', () => {
  const list = [L.normalize({ title: '茶馆', keywords: ['茶馆'], content: '雨夜茶馆' })];
  const r = L.inject('你是助手', list, '进茶馆');
  assert.match(r.systemPrompt, /^你是助手\n\n【世界书】\n## 茶馆\n雨夜茶馆$/);
  assert.strictEqual(L.inject('原样', list, '无关').systemPrompt, '原样');
});
test('filter 模式', () => {
  const list = [L.normalize({ title: 'a', sticky: true, content: '1' }), L.normalize({ title: 'b', keywords: ['k'], content: '2', enabled: false })];
  assert.strictEqual(L.filter(list, 'sticky').length, 1);
  assert.strictEqual(L.filter(list, 'enabled').length, 1);
  assert.strictEqual(L.filter(list, 'keyword')[0].title, 'b');
  assert.strictEqual(L.filter(list, 'all', 'B').length, 1);
});
test('导入酒馆世界书格式', () => {
  const st = { entries: { 0: { key: ['剑'], content: '古剑', comment: '剑', constant: false }, 1: { key: [], content: '世界', constant: true, disable: true } } };
  const r = L.importJSON(JSON.stringify(st), []);
  assert.strictEqual(r.added, 2);
  assert.strictEqual(r.list[1].sticky, true); assert.strictEqual(r.list[1].enabled, false);
  assert.strictEqual(L.importJSON(JSON.stringify(st), r.list).added, 0);
  assert.throws(() => L.importJSON('nope', []));
});
test('scanText 取最近消息', () => {
  const t = L.scanText([{ role: 'user', content: '1' }, { role: 'assistant', content: '2' }, { role: 'user', content: '3' }], 2);
  assert.strictEqual(t, '2\n3');
});
test('Personas.fromCard 解析酒馆 V2 角色卡', () => {
  const p = P.fromCard({ spec: 'chara_card_v2', data: { name: '林晚', description: '{{char}}是剑客', personality: '冷静', first_mes: '你好，{{user}}' } });
  assert.strictEqual(p.name, '林晚'); assert.strictEqual(p.tavern, true);
  assert.match(p.systemPrompt, /林晚是剑客/); assert.match(p.systemPrompt, /冷静/);
  assert.strictEqual(p.firstMes, '你好，你');
  assert.throws(() => P.fromCard({}));
});
