// 第五轮 E：世界模板 version + 块 hash + 三路合并 + 一键回滚
const test = require('node:test');
const assert = require('assert');
const W = require('../app/src/main/assets/www/worlds.js');
const RPCache = require('../app/src/main/assets/www/rpcache.js');

function world(overrides) {
  return W.normalizeWorld(Object.assign({
    id: 'w-rain', name: '雨港', emoji: '🌧️',
    blocks: {
      world: '雨夜港湾',
      character: '私家侦探',
      rules: '不替玩家决定',
      format: '第三人称',
      fewshot: '',
      prohibit: '禁止突然冷暴力',
      style: '短句',
    },
  }, overrides));
}

function openConv(wd, at) {
  const conv0 = {
    id: 'c1', title: '新对话', providerId: 'deepseek', model: 'm',
    systemPrompt: '你是助手', messages: [], plugins: {},
  };
  return W.applyWorldToConversation(conv0, wd, RPCache, at || 1000).conv;
}

function bump(list, blocks, note) {
  const cur = list[0];
  return W.upsert(list, Object.assign({}, cur, {
    blocks: Object.assign({}, cur.blocks, blocks),
  }), note);
}

test('normalizeWorld 补齐 version / blockHash / changelog；旧数据可迁移', () => {
  const legacy = { id: 'w-old', name: '旧世界', blocks: { world: '北方', character: 'A' } };
  const n = W.normalizeWorld(legacy);
  assert.strictEqual(n.version, 1);
  assert.ok(n.blockHash.world);
  assert.strictEqual(n.blockHash.world, W.hashBlock('北方'));
  assert.strictEqual(n.blockHash.character, W.hashBlock('A'));
  assert.ok(Array.isArray(n.changelog) && n.changelog[0].version === 1);
  W.BLOCK_IDS.forEach(id => assert.ok(Object.prototype.hasOwnProperty.call(n.blockHash, id)));
  // 往返稳定
  const n2 = W.normalizeWorld(JSON.parse(JSON.stringify(n)));
  assert.strictEqual(n2.version, 1);
  assert.deepStrictEqual(n2.blockHash, n.blockHash);
});

test('upsert：块变更才升 version 并追加 changelog；仅元数据不升版', () => {
  let list = W.upsert([], { id: 'w1', name: '港', blocks: { world: '设定 A' } });
  assert.strictEqual(list[0].version, 1);
  assert.strictEqual(list[0].changelog.length, 1);
  const v1hash = list[0].blockHash.world;
  list = W.upsert(list, Object.assign({}, list[0], { desc: '简介', name: '港湾' }));
  assert.strictEqual(list[0].version, 1, '元数据变更不升版');
  assert.strictEqual(list[0].blockHash.world, v1hash);
  list = bump(list, { world: '设定 B（南方改为北方）' }, '修正方位');
  assert.strictEqual(list[0].version, 2);
  assert.notStrictEqual(list[0].blockHash.world, v1hash);
  assert.strictEqual(list[0].changelog.length, 2);
  assert.strictEqual(list[0].changelog[1].note, '修正方位');
  assert.strictEqual(list[0].changelog[1].version, 2);
});

test('开聊写入 worldRef，与模板 version / blockHash 一致', () => {
  const wd = world();
  const conv = openConv(wd, 1700);
  assert.ok(conv.worldRef);
  assert.strictEqual(conv.worldRef.id, wd.id);
  assert.strictEqual(conv.worldRef.version, wd.version);
  assert.deepStrictEqual(conv.worldRef.blockHash, wd.blockHash);
  assert.strictEqual(conv.worldRef.syncedAt, 1700);
});

test('验收：模板升级后老对话 100% 能检出漂移（含无 worldRef 的旧对话）', () => {
  const v1 = world({ version: 1 });
  const conv = openConv(v1, 1000);
  let list = [v1];
  list = bump(list, { world: '北方雪原（原误写南方）', prohibit: '禁止 Orth' });
  const v2 = list[0];
  assert.strictEqual(v2.version, 2);

  const report = W.detectDrift(conv, v2, W.getConvBlocks(conv, RPCache));
  assert.ok(report.ids.includes('world'));
  assert.ok(report.ids.includes('prohibit'));
  assert.ok(!report.ids.includes('character'), '未改的块不应标漂移');
  assert.ok(report.stale);
  assert.strictEqual(report.classified.find(x => x.id === 'world').action, 'takeTheirs');

  // 旧对话：没有 worldRef
  const legacyConv = {
    id: 'c-old', worldId: v1.id, plugins: conv.plugins, worldRef: undefined,
  };
  const oldReport = W.detectDrift(legacyConv, v2, W.getConvBlocks(legacyConv, RPCache));
  // 当前块仍是 v1 内容，与 v2 不同的块必须被检出
  assert.ok(oldReport.ids.includes('world') && oldReport.ids.includes('prohibit'));
  assert.ok(!oldReport.ids.includes('character'));
  // 无 base 时保守标冲突（避免误覆盖用户可能的本地改动）
  assert.strictEqual(oldReport.classified.find(x => x.id === 'world').action, 'conflict');
});

test('merge3：四分支（取 theirs / 无需变更 / 保留 current / 冲突+_pending）', () => {
  assert.deepStrictEqual(W.merge3('base', 'base', 'theirs'), { content: 'theirs', action: 'takeTheirs' });
  assert.deepStrictEqual(W.merge3('base', 'theirs', 'theirs'), { content: 'theirs', action: 'unchanged' });
  assert.deepStrictEqual(W.merge3('base', 'mine', 'base'), { content: 'mine', action: 'keepCurrent' });
  const c = W.merge3('base', 'mine', 'theirs');
  assert.strictEqual(c.action, 'conflict');
  assert.strictEqual(c.content, 'mine');
  assert.strictEqual(c._pending, 'theirs');
});

test('验收：用户本地改过的块同步后 0 丢失；未改动的块取新模板', () => {
  const v1 = world({ version: 1 });
  let conv = openConv(v1, 1000);
  // 用户在对话里改了角色卡
  let st = conv.plugins.rpcache.state;
  st = RPCache.setBlock(st, 'character', '私家侦探（用户加了左撇子设定）', 2000).state;
  conv = Object.assign({}, conv, { plugins: { rpcache: Object.assign({}, conv.plugins.rpcache, { state: st }) } });

  let list = [v1];
  list = bump(list, { world: '北方雪原', character: '私家侦探（模板也改了人设）' });
  const v2 = list[0];

  const cur = W.getConvBlocks(conv, RPCache);
  assert.ok(cur.character.includes('左撇子'));
  const report = W.detectDrift(conv, v2, cur);
  assert.strictEqual(report.classified.find(x => x.id === 'world').action, 'takeTheirs');
  assert.strictEqual(report.classified.find(x => x.id === 'character').action, 'conflict');

  const synced = W.applySyncToConversation(conv, v2, RPCache, { mode: 'merge', at: 3000 });
  const after = W.getConvBlocks(synced.conv, RPCache);
  assert.strictEqual(after.world, '北方雪原', '未改动的块应更新');
  assert.ok(after.character.includes('左撇子'), '用户改动不得丢失');
  assert.strictEqual(synced.conv.worldPending.character, '私家侦探（模板也改了人设）');
  assert.strictEqual(synced.conv.worldRef.version, 2);
  assert.strictEqual(synced.conv.worldLog.length, 1);
  assert.strictEqual(synced.conv.worldLog[0].mode, 'merge');
  assert.ok(synced.conv.worldLog[0].blocks.includes('world'));
  assert.ok(!synced.conv.worldLog[0].blocks.includes('character'), '冲突块不算已同步内容');

  const msg = W.formatDriftMessage(report, v2);
  assert.ok(/模板已更新到 v2/.test(msg));
  assert.ok(/世界观/.test(msg) && /有新内容/.test(msg));
  assert.ok(/角色卡/.test(msg) && /本地改过/.test(msg));
});

test('全部覆盖会写入模板，但可从 worldLog 一键回滚恢复用户改动', () => {
  const v1 = world({ version: 1 });
  let conv = openConv(v1, 1000);
  let st = conv.plugins.rpcache.state;
  st = RPCache.setBlock(st, 'character', '用户人设', 2000).state;
  conv = Object.assign({}, conv, { plugins: { rpcache: Object.assign({}, conv.plugins.rpcache, { state: st }) } });
  let list = [v1];
  list = bump(list, { character: '模板人设' });
  const overwritten = W.applySyncToConversation(conv, list[0], RPCache, { mode: 'overwrite', at: 3000 });
  assert.strictEqual(W.getConvBlocks(overwritten.conv, RPCache).character, '模板人设');
  const rolled = W.rollbackWorldLog(overwritten.conv, RPCache, { index: 0, at: 4000 });
  assert.strictEqual(W.getConvBlocks(rolled.conv, RPCache).character, '用户人设');
  assert.strictEqual((rolled.conv.worldLog || []).length, 0);
  assert.strictEqual(rolled.conv.worldRef.version, 1);
});

test('验收：任意一次同步可一键回滚（撤销该次及之后的同步）', () => {
  const v1 = world({ version: 1 });
  let conv = openConv(v1, 1000);
  let list = [v1];
  list = bump(list, { world: 'v2 世界' });
  const s1 = W.applySyncToConversation(conv, list[0], RPCache, { mode: 'merge', at: 2000 });
  list = bump(list, { world: 'v3 世界', rules: '新规则' });
  const s2 = W.applySyncToConversation(s1.conv, list[0], RPCache, { mode: 'merge', at: 3000 });
  assert.strictEqual(s2.conv.worldLog.length, 2);
  assert.strictEqual(s2.conv.worldRef.version, 3);
  assert.strictEqual(W.getConvBlocks(s2.conv, RPCache).world, 'v3 世界');

  // 回滚第一次同步：第一次及之后都撤销，回到开聊时的 v1
  const r = W.rollbackWorldLog(s2.conv, RPCache, { index: 0, at: 4000 });
  assert.strictEqual(r.conv.worldLog.length, 0);
  assert.strictEqual(r.conv.worldRef.version, 1);
  const blocks = W.getConvBlocks(r.conv, RPCache);
  assert.strictEqual(blocks.world, '雨夜港湾');
  assert.strictEqual(blocks.rules, '不替玩家决定');
});

test('不同步：记录 skip，同版本不再提示；模板再升版后重新提示', () => {
  const v1 = world({ version: 1 });
  const conv = openConv(v1, 1000);
  let list = [v1];
  list = bump(list, { world: 'v2' });
  const shown = W.shouldShowDrift(conv, list[0], W.getConvBlocks(conv, RPCache));
  assert.strictEqual(shown.show, true);
  const skipped = W.applySyncToConversation(conv, list[0], RPCache, { mode: 'skip', at: 2000 });
  assert.strictEqual(skipped.conv.worldSkipVersion, 2);
  assert.strictEqual(W.getConvBlocks(skipped.conv, RPCache).world, '雨夜港湾', 'skip 不改块');
  const hidden = W.shouldShowDrift(skipped.conv, list[0], W.getConvBlocks(skipped.conv, RPCache));
  assert.strictEqual(hidden.show, false);
  list = bump(list, { world: 'v3' });
  const again = W.shouldShowDrift(skipped.conv, list[0], W.getConvBlocks(skipped.conv, RPCache));
  assert.strictEqual(again.show, true);
});

test('采用 _pending：冲突块可一键换成模板并写入审计', () => {
  const v1 = world({ version: 1 });
  let conv = openConv(v1, 1000);
  let st = conv.plugins.rpcache.state;
  st = RPCache.setBlock(st, 'character', '我的人设', 2000).state;
  conv = Object.assign({}, conv, { plugins: { rpcache: Object.assign({}, conv.plugins.rpcache, { state: st }) } });
  let list = [v1];
  list = bump(list, { character: '模板人设' });
  const synced = W.applySyncToConversation(conv, list[0], RPCache, { mode: 'merge', at: 3000 });
  assert.ok(synced.conv.worldPending.character);
  const used = W.applyPendingBlock(synced.conv, 'character', RPCache, 4000);
  assert.strictEqual(W.getConvBlocks(used.conv, RPCache).character, '模板人设');
  assert.ok(!used.conv.worldPending.character);
  assert.strictEqual(used.conv.worldLog[1].mode, 'pending');
});

test('hash 对 CRLF / 行尾空白与 rpcache 写入后一致', () => {
  const raw = 'A\r\nB  \nC';
  const w = W.normalizeWorld({ name: 'x', blocks: { world: raw } });
  const conv = openConv(w, 1);
  const stored = RPCache.getBlock(conv.plugins.rpcache.state, 'world').content;
  assert.strictEqual(W.hashBlock(raw), W.hashBlock(stored));
  assert.strictEqual(w.blockHash.world, W.hashBlock(stored));
});
