// v0.9.3：世界书常驻 / 触发分层、触发内容冻结进历史、摘要勘误
const test = require('node:test');
const assert = require('node:assert');
const R = require('../app/src/main/assets/www/rpcache.js');
const LORE = '## 法则 | *\n魔法需要代价\n\n## 王都 | 王都, 王城\n王都有三重城墙';
const u = (id, c) => ({ id, role: 'user', content: c });
const a = (id, c) => ({ id, role: 'assistant', content: c });

test('parseLore 区分常驻与触发', () => {
  const l = R.parseLore(LORE);
  assert.strictEqual(l.length, 2);
  assert.strictEqual(l[0].mode, 'constant');
  assert.deepStrictEqual(l[1].keys, ['王都', '王城']);
  assert.strictEqual(R.parseLore(R.loreToText(l)).length, 2);
});

test('常驻条目进固定设定，触发条目不进', () => {
  const st = R.setLore(R.newState(), LORE);
  const t = R.staticText(st, 'sys');
  assert.ok(t.includes('[LOREBOOK]') && t.includes('魔法需要代价'));
  assert.ok(!t.includes('三重城墙'));
});

test('触发后冻结到触发消息，之后前缀只追加', () => {
  let st = R.setLore(R.newState(), LORE);
  let items = [u('1', '你好'), a('2', '你好呀'), u('3', '我们去王都吧')];
  const r = R.fireLore(st, items, 1); st = r.state;
  assert.strictEqual(r.fired.length, 1);
  const m1 = R.assemble(R.plan(st, 'sys', items)).messages;
  assert.ok(m1[2].content.startsWith('我们去王都吧\n\n[LORE_TRIGGERED 王都]'));
  // 重新生成不重复冻结
  assert.strictEqual(R.fireLore(st, items, 2).fired.length, 0);
  // 下一轮再提王都：已冻结，不再触发；上一轮消息逐字不变
  items = items.concat([a('4', '好的'), u('5', '王都真大')]);
  assert.strictEqual(R.fireLore(st, items, 3).fired.length, 0);
  const m2 = R.assemble(R.plan(st, 'sys', items)).messages;
  assert.strictEqual(m2[2].content, m1[2].content);
  assert.strictEqual(m2[4].content, '王都真大');
  // 编辑世界书不改写已冻结片段
  st = R.setLore(st, LORE.replace('三重城墙', '五重城墙'));
  assert.strictEqual(R.assemble(R.plan(st, 'sys', items)).messages[2].content, m1[2].content);
});

test('锚点被章节覆盖后可再次触发', () => {
  let st = R.setLore(R.newState(), LORE);
  st = R.fireLore(st, [u('1', '王城')], 1).state;
  st = R.addChapter(st, { content: 'FACTS:\n- x', coveredIds: ['1'], at: 1 });
  const items = [u('1', '王城'), a('2', 'x'), u('3', '回王城')];
  assert.strictEqual(R.fireLore(st, items, 2).fired.length, 1);
});

test('摘要勘误写入记忆增量（历史之后），章节不变', () => {
  let st = R.addChapter(R.newState(), { content: 'FACTS:\n- x', coveredIds: [], at: 1 });
  const before = R.buildSystem(st, 'sys');
  st = R.addErratum(st, 1, '艾琳不知道真相', 2).state;
  assert.strictEqual(R.buildSystem(st, 'sys'), before);
  assert.ok(R.deltaText(st).includes('[SUMMARY_ERRATUM #001] 艾琳不知道真相'));
});
