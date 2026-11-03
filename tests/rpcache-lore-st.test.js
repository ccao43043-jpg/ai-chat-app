// v0.12：世界书 ST 语义（scanDepth / secondaryKeys / 递归 / 预算 / 概率）+ 双轨
const test = require('node:test');
const assert = require('node:assert');
const R = require('../app/src/main/assets/www/rpcache.js');
const u = (id, c) => ({ id, role: 'user', content: c });
const a = (id, c) => ({ id, role: 'assistant', content: c });

test('默认行为兼容：scanDepth=2 等价于本轮+上一条', () => {
  const LORE = '## 王都 | 王都\n三重城墙';
  let st = R.setLore(R.newState(), LORE);
  // 关键词只在更早消息：默认 depth=2 扫不到
  let items = [u('1', '我们去王都吧'), a('2', '好'), u('3', '今天天气不错')];
  assert.strictEqual(R.fireLore(st, items, 1).fired.length, 0);
  // 本轮含关键词
  items = [u('1', '你好'), a('2', '你好呀'), u('3', '我们去王都吧')];
  assert.strictEqual(R.fireLore(st, items, 1).fired.length, 1);
});

test('scanDepth 扩大可扫到更早消息', () => {
  const LORE = '## 王都 | 王都 | depth=4\n三重城墙';
  let st = R.setLore(R.newState(), LORE);
  st.settings.lore.scanDepth = 2;
  const items = [u('1', '我们去王都吧'), a('2', '好'), a('3', '嗯'), u('4', '然后呢')];
  // 条目自身 depth=4，应命中
  assert.strictEqual(R.fireLore(st, items, 1).fired.length, 1);
});

test('secondaryKeys AND_ALL', () => {
  const LORE = '## 龙药 | 龙 | sec=鳞片;secLogic=AND_ALL\n龙鳞可炼药';
  let st = R.setLore(R.newState(), LORE);
  assert.strictEqual(R.fireLore(st, [u('1', '听说有龙')], 1).fired.length, 0);
  assert.strictEqual(R.fireLore(st, [u('1', '龙的鳞片在哪')], 1).fired.length, 1);
});

test('递归：激活内容再触发下一条', () => {
  const LORE = '## A | 苹果\n香蕉香甜\n\n## B | 香蕉\n香蕉园在东郊';
  let st = R.setLore(R.newState(), LORE);
  st.settings.lore.recursionDepth = 2;
  const r = R.fireLore(st, [u('1', '我想吃苹果')], 1);
  assert.strictEqual(r.fired.length, 2);
  assert.deepStrictEqual(r.fired.map(x => x.name).sort(), ['A', 'B']);
});

test('概率 0 永不触发；常驻预算截断', () => {
  const LORE = '## X | 触发词 | prob=0\n不该出现\n\n## C1 | *\n' + '甲'.repeat(5000) + '\n\n## C2 | * | priority=1\n' + '乙'.repeat(5000);
  let st = R.setLore(R.newState(), LORE);
  st.settings.max_context = 2000;
  st.settings.lore.constantBudgetPct = 0.1;
  assert.strictEqual(R.fireLore(st, [u('1', '触发词来了')], 1).fired.length, 0);
  const selected = R.selectConstantLore(st);
  assert.ok(selected.length >= 1);
  assert.ok(selected.length < 3, '预算应截断部分常驻条目');
  // 高 priority 优先
  assert.strictEqual(selected[0].name, 'C1');
});

test('冷路径 rebuildLore 可完整重排；热路径不改已冻结', () => {
  const LORE = '## 王都 | 王都\n三重城墙';
  let st = R.setLore(R.newState(), LORE);
  let items = [u('1', '去王都'), a('2', '好'), u('3', '再看看')];
  st = R.fireLore(st, [u('1', '去王都')], 1).state;
  const frozen = R.applyFrozenLore(st, items)[0].content;
  // 编辑世界书：默认不重建，冻结内容不变
  st = R.setLore(st, LORE.replace('三重', '五重'));
  assert.ok(st.loreEditedWhileFrozen);
  assert.strictEqual(R.applyFrozenLore(st, items)[0].content, frozen);
  // 冷路径重建
  const reb = R.rebuildLore(st, items, 2);
  st = reb.state;
  assert.ok(reb.fired.some(f => f.content.includes('五重')));
  assert.ok(R.applyFrozenLore(st, items)[0].content.includes('五重'));
});

test('rebuildOnEdit 开关清空冻结', () => {
  let st = R.setLore(R.newState(), '## 王都 | 王都\n三重城墙');
  st = R.fireLore(st, [u('1', '王都')], 1).state;
  assert.ok(st.loreFired.length);
  st.settings.lore.rebuildOnEdit = true;
  st = R.setLore(st, '## 王都 | 王都\n五重城墙');
  assert.strictEqual(st.loreFired.length, 0);
  assert.ok(st.loreNeedsRebuild);
});

test('reasons 含 loreEditedButFrozen', () => {
  const r = R.reasons({ loreEditedButFrozen: true, diag: {} }, { static_hash: 'x' });
  assert.ok(r.some(x => /loreEditedButFrozen|冻结/.test(x)));
});
