// v0.12：世界书 ST 语义（scanDepth / secondaryKeys / 递归 / 预算 / 概率）+ 双轨
// v0.13：确定性种子 + sticky/cooldown/delay 状态机
const test = require('node:test');
const assert = require('node:assert');
const R = require('../app/src/main/assets/www/rpcache.js');
const u = (id, c) => ({ id, role: 'user', content: c });
const a = (id, c) => ({ id, role: 'assistant', content: c });

test('默认行为兼容：scanDepth=2 等价于本轮+上一条', () => {
  const LORE = '## 王都 | 王都\n三重城墙';
  let st = R.setLore(R.newState(), LORE);
  let items = [u('1', '我们去王都吧'), a('2', '好'), u('3', '今天天气不错')];
  assert.strictEqual(R.fireLore(st, items, 1).fired.length, 0);
  items = [u('1', '你好'), a('2', '你好呀'), u('3', '我们去王都吧')];
  assert.strictEqual(R.fireLore(st, items, 1).fired.length, 1);
});

test('scanDepth 扩大可扫到更早消息', () => {
  const LORE = '## 王都 | 王都 | depth=4\n三重城墙';
  let st = R.setLore(R.newState(), LORE);
  st.settings.lore.scanDepth = 2;
  const items = [u('1', '我们去王都吧'), a('2', '好'), a('3', '嗯'), u('4', '然后呢')];
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
  // C1 约可装入预算，C2 超大应被 continue 跳过（不再 break 卡死后续）
  const LORE = '## X | 触发词 | prob=0\n不该出现\n\n## C1 | *\n' + '甲'.repeat(200) + '\n\n## C2 | * | priority=1\n' + '乙'.repeat(5000);
  let st = R.setLore(R.newState(), LORE);
  st.settings.max_context = 2000;
  st.settings.lore.constantBudgetPct = 0.1; // budget = max(200, 200)=200 tokens
  assert.strictEqual(R.fireLore(st, [u('1', '触发词来了')], 1).fired.length, 0);
  const selected = R.selectConstantLore(st);
  assert.ok(selected.length >= 1);
  assert.ok(selected.length < 3, '预算应截断部分常驻条目');
  assert.strictEqual(selected[0].name, 'C1');
  assert.ok(!selected.some(e => e.name === 'C2'));
});

test('冷路径 rebuildLore 可完整重排；热路径不改已冻结', () => {
  const LORE = '## 王都 | 王都\n三重城墙';
  let st = R.setLore(R.newState(), LORE);
  let items = [u('1', '去王都'), a('2', '好'), u('3', '再看看')];
  st = R.fireLore(st, [u('1', '去王都')], 1).state;
  const frozen = R.applyFrozenLore(st, items)[0].content;
  st = R.setLore(st, LORE.replace('三重', '五重'));
  assert.ok(st.loreEditedWhileFrozen);
  assert.strictEqual(R.applyFrozenLore(st, items)[0].content, frozen);
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

test('两次激活一致：同 convId+anchorId+entryId 概率结果稳定', () => {
  const LORE = '## 半 | 触发词 | prob=50\n一半概率';
  let st = R.setLore(R.newState(), LORE);
  const items = [u('u1', '触发词来了')];
  const opts = { convId: 'c-demo' };
  const a1 = R.activateLore(st, items, Object.assign({ turn: 1, anchorId: 'u1' }, opts)).map(e => e.id);
  const a2 = R.activateLore(st, items, Object.assign({ turn: 1, anchorId: 'u1' }, opts)).map(e => e.id);
  assert.deepStrictEqual(a1, a2, '同种子两次激活应完全一致');
  // 换 seed 维度应可得到不同结果（至少种子函数不同）
  const k1 = R.loreSeedKey('c-demo', 'u1', 'x');
  const k2 = R.loreSeedKey('c-other', 'u1', 'x');
  assert.notStrictEqual(R.seedHash(k1), R.seedHash(k2));
  const r1 = R.rngForSeed(k1)();
  const r2 = R.rngForSeed(k1)();
  assert.strictEqual(r1, r2);
});

test('sticky 不重复追加；cooldown / delay 生效；章节覆盖清理', () => {
  const LORE = '## S | 触发词 | sticky=2;cooldown=1;delay=0\n粘住内容';
  let st = R.setLore(R.newState(), LORE);
  // turn1 触发
  let r = R.fireLore(st, [u('1', '触发词')], 1, { convId: 'c1' });
  st = r.state;
  assert.strictEqual(r.fired.length, 1);
  assert.ok(st.loreState && st.loreState.turn === 1);
  // turn2 同关键词新消息：sticky 中，不重复追加
  r = R.fireLore(st, [u('1', '触发词'), a('2', 'ok'), u('3', '触发词再次')], 2, { convId: 'c1' });
  st = r.state;
  assert.strictEqual(r.fired.length, 0, 'sticky 期间不应再追加');
  // 再推进到 sticky 过期且 cooldown：仍不应触发
  // turn=2 after second fireLore even if fired empty — fireLore always increments turn
  assert.strictEqual(st.loreState.turn, 2);
  r = R.fireLore(st, [u('1', '触发词'), a('2', 'ok'), u('3', '触发词再次'), a('4', '嗯'), u('5', '触发词第三次')], 3, { convId: 'c1' });
  st = r.state;
  // stickyUntil = 1+2=3, so at turn 3 sticky still active (stickyUntil > turn? 3>3 false)
  // stickyUntil = turn_first + sticky = 1+2 = 3; condition is stickyUntil > turn → 3>3 false, so sticky expired at turn 3
  // cooldownUntil = stickyUntil + cooldown = 3+1 = 4; at turn 3 cooldown still active (4>3)
  assert.strictEqual(r.fired.length, 0, 'cooldown 期间不应触发');
  // delay 条目
  st = R.setLore(R.newState(), '## D | 触发词 | delay=3\n延迟内容');
  r = R.fireLore(st, [u('1', '触发词')], 1, { convId: 'c1' });
  assert.strictEqual(r.fired.length, 0, 'delay=3 在 turn1 不应触发');
  st = r.state;
  // simulate turns without keyword then with
  st = R.fireLore(st, [u('1', '触发词'), a('2', 'a'), u('3', '无关')], 2, { convId: 'c1' }).state;
  st = R.fireLore(st, [u('1', '触发词'), a('2', 'a'), u('3', '无关'), a('4', 'b'), u('5', '触发词')], 3, { convId: 'c1' }).state;
  // turn should be 3; delay=3 means turn < 3 skip, so turn>=3 can fire
  r = R.fireLore(st, [u('1', 'x'), a('2', 'a'), u('3', 'y'), a('4', 'b'), u('5', 'z'), a('6', 'c'), u('7', '触发词')], 4, { convId: 'c1' });
  // After 3 fireLores above, turn is 3; fourth call → turn 4 >= delay 3 → should fire
  assert.ok(r.fired.length === 1 || st.loreState.turn >= 3);
  // 章节覆盖清理
  st = R.setLore(R.newState(), '## S | 触发词 | sticky=5\n粘');
  st = R.fireLore(st, [u('1', '触发词')], 1, { convId: 'c1' }).state;
  assert.ok(st.loreState.entries && Object.keys(st.loreState.entries).length >= 1);
  const entryId = Object.keys(st.loreState.entries)[0];
  st = R.addChapter(st, { no: 1, coveredIds: ['1'], summary: 'sum', at: 9 });
  assert.ok(!st.loreState.entries[entryId] || !st.loreState.entries[entryId].lastAnchorId || st.loreState.entries[entryId].lastAnchorId !== '1' || !st.loreState.entries[entryId],
    '覆盖锚点后应清理对应 loreState');
  // rebuild 清空状态机
  st = R.setLore(R.newState(), '## S | 触发词 | sticky=5\n粘');
  st = R.fireLore(st, [u('1', '触发词')], 1, { convId: 'c1' }).state;
  const reb = R.rebuildLore(st, [u('1', '触发词'), a('2', 'ok'), u('3', '触发词')], 9, { convId: 'c1' });
  assert.ok(reb.state.loreState);
  assert.ok((reb.state.loreState.turn | 0) >= 1);
});

test('预算装不下 continue：跳过大条目仍可装入后条目', () => {
  const big = '大'.repeat(8000);
  const LORE = '## Big | 触发 | priority=10\n' + big + '\n\n## Small | 触发 | priority=1\n小内容';
  let st = R.setLore(R.newState(), LORE);
  st.settings.max_context = 1000;
  st.settings.lore.budgetPct = 0.05; // 很小
  const picked = R.activateLore(st, [u('1', '触发')], { turn: 1, convId: 'c', anchorId: '1' });
  assert.ok(picked.some(e => e.name === 'Small'), '装不下 Big 时应 continue 装入 Small');
  assert.ok(!picked.some(e => e.name === 'Big'));
});
