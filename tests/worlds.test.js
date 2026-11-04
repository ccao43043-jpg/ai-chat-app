// 世界模板：规范化、应用到对话后 blocks、开聊创建字段
const test = require('node:test');
const assert = require('assert');
const W = require('../app/src/main/assets/www/worlds.js');
const RPCache = require('../app/src/main/assets/www/rpcache.js');
const T = require('../app/src/main/assets/www/templates.js');

test('BLOCK_IDS 与 RPCache.STATIC_DEFS 对齐', () => {
  assert.deepStrictEqual(W.BLOCK_IDS, RPCache.STATIC_DEFS.map(d => d.id));
  assert.strictEqual(W.BLOCK_IDS.length, 7);
  ['world', 'character', 'rules', 'format', 'fewshot', 'prohibit', 'style'].forEach(id => {
    assert.ok(W.BLOCK_META[id] && W.BLOCK_META[id].title && W.BLOCK_META[id].hint);
  });
  // 情感硬约束提示出现在 character / prohibit / fewshot
  assert.ok(/必须|情感/.test(W.BLOCK_META.character.hint));
  assert.ok(/禁止/.test(W.BLOCK_META.prohibit.hint));
  assert.ok(/对白|情感|样例/.test(W.BLOCK_META.fewshot.hint));
});

test('模板规范化：缺省块、trim、emoji、JSON 往返', () => {
  const n = W.normalizeWorld({ name: '  星际港  ', emoji: '🚀🚀🚀🚀🚀', desc: ' 边陲 ', blocks: { world: 'A\r\nB', character: '角色' } });
  assert.strictEqual(n.name, '星际港');
  assert.strictEqual(n.emoji.length <= 4, true);
  assert.strictEqual(n.desc, '边陲');
  assert.strictEqual(n.blocks.world, 'A\nB');
  assert.strictEqual(n.blocks.character, '角色');
  assert.strictEqual(n.blocks.rules, '');
  assert.ok(n.id.startsWith('w-'));
  W.BLOCK_IDS.forEach(id => assert.ok(Object.prototype.hasOwnProperty.call(n.blocks, id)));

  let list = W.defaultWorlds();
  assert.deepStrictEqual(list, []);
  list = W.upsert(list, { name: '港', emoji: '🌍', blocks: { world: '设定' } });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].blocks.world, '设定');
  list = W.upsert(list, Object.assign({}, list[0], { desc: '简介', blocks: Object.assign({}, list[0].blocks, { prohibit: '禁 OOC' }) }));
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].desc, '简介');
  assert.strictEqual(list[0].blocks.prohibit, '禁 OOC');
  list = W.duplicate(list, list[0].id);
  assert.strictEqual(list.length, 2);
  assert.ok(list[1].name.includes('副本'));
  assert.notStrictEqual(list[1].id, list[0].id);
  const id0 = list[0].id;
  list = W.remove(list, id0);
  assert.strictEqual(list.length, 1);
  assert.ok(!list.some(x => x.id === id0));
  const stored = JSON.parse(JSON.stringify(list));
  assert.strictEqual(W.normalizeWorld(stored[0]).blocks.style, '');
});

test('开聊创建字段：worldId / 名称 / emoji / title + 沉浸式模板', () => {
  const providers = [{ id: 'deepseek', models: ['deepseek-flash'] }];
  const fb = { providerId: 'deepseek', model: 'deepseek-flash' };
  const world = W.normalizeWorld({ name: '雨港', emoji: '🌧️', blocks: { world: '雨夜' } });
  const c = W.conversationFromWorld(world, providers, fb, T);
  assert.strictEqual(c.worldId, world.id);
  assert.strictEqual(c.worldName, '雨港');
  assert.strictEqual(c.worldEmoji, '🌧️');
  assert.ok(c.title.includes('雨港'));
  assert.strictEqual(c.providerId, 'deepseek');
  assert.strictEqual(c.model, 'deepseek-flash');
  assert.strictEqual(W.WORLD_START_TEMPLATE_ID, 't-rp-immersive');
  assert.strictEqual(c.templateId, 't-rp-immersive');
  assert.strictEqual(c.templateName, '沉浸式 RP（全自动）');
  assert.strictEqual(c.templateEmoji, '🎬');
  assert.ok(typeof c.systemPrompt === 'string' && c.systemPrompt.length > 40);
  assert.ok(c.systemPrompt.includes('分层设定 / 世界模板'));
  assert.ok(!c.systemPrompt.includes('首条消息后自动生成'));
  assert.ok(/\d{4}-\d{2}-\d{2}/.test(c.systemPrompt) && /\d{2}:\d{2}/.test(c.systemPrompt), 'date/time filled');
  const imm = T.BUILTIN_TEMPLATES.find(x => x.id === 't-rp-immersive');
  const expected = T.applyToConv({}, imm);
  assert.strictEqual(c.systemPrompt, expected.systemPrompt);
});

test('世界开聊后 template + L1 blocks 一并正确', () => {
  const world = W.normalizeWorld({
    name: '雨港', emoji: '🌧️',
    blocks: { world: '雨夜港湾', character: '私家侦探', rules: '不替玩家决定' },
  });
  const fields = W.conversationFromWorld(world, [{ id: 'deepseek', models: ['m'] }], { providerId: 'deepseek', model: 'm' }, T);
  const conv0 = Object.assign({
    id: 'c-w', title: '新对话', messages: [], plugins: {},
  }, fields);
  const { conv, changed } = W.applyWorldToConversation(conv0, world, RPCache, 1700000000000);
  assert.ok(changed);
  assert.strictEqual(conv.templateId, 't-rp-immersive');
  assert.ok(conv.systemPrompt.includes('世界模板'));
  assert.strictEqual(conv.plugins.rpcache.enabled, true);
  assert.strictEqual(RPCache.getBlock(conv.plugins.rpcache.state, 'world').content, '雨夜港湾');
  assert.strictEqual(RPCache.getBlock(conv.plugins.rpcache.state, 'character').content, '私家侦探');
  assert.ok(conv.plugins.rpcache.state.baseHash);
});

test('应用到对话后 L1 blocks 内容正确，并启用 RP', () => {
  const world = W.normalizeWorld({
    name: '学院',
    emoji: '🎓',
    blocks: {
      world: '魔法学院',
      character: '必须温柔；禁止 Orth',
      rules: '不替玩家决定',
      format: '第三人称',
      fewshot: '「早上好。」',
      prohibit: '禁止突然冷暴力',
      style: '短句',
    },
  });
  const conv0 = {
    id: 'c1', title: '新对话', providerId: 'deepseek', model: 'deepseek-flash',
    systemPrompt: '你是助手', messages: [], plugins: {},
  };
  const { conv, changed } = W.applyWorldToConversation(conv0, world, RPCache, 1700000000000);
  assert.ok(changed);
  assert.strictEqual(conv.plugins.rpcache.enabled, true);
  assert.ok(conv.plugins.rpcache.state);
  assert.strictEqual(conv.worldId, world.id);
  assert.strictEqual(conv.worldName, '学院');
  W.BLOCK_IDS.forEach(id => {
    const b = RPCache.getBlock(conv.plugins.rpcache.state, id);
    assert.ok(b, id);
    assert.strictEqual(b.content, world.blocks[id], id);
    assert.ok(b.version >= 1, id + ' version');
  });
  // system/base 已 sync
  assert.ok(conv.plugins.rpcache.state.baseHash);

  // 同步第二次（内容相同）不应再抬版本
  const again = W.applyWorldToConversation(conv, world, RPCache, 1700000001000);
  W.BLOCK_IDS.forEach(id => {
    const b0 = RPCache.getBlock(conv.plugins.rpcache.state, id);
    const b1 = RPCache.getBlock(again.conv.plugins.rpcache.state, id);
    assert.strictEqual(b1.version, b0.version, id);
  });
});

test('applyWorldToState 空块可清空已有内容', () => {
  let st = RPCache.newState();
  st = RPCache.setBlock(st, 'world', '旧世界观', 1).state;
  const empty = W.normalizeWorld({ name: '空', blocks: {} });
  const r = W.applyWorldToState(st, empty, 2, RPCache.setBlock);
  assert.strictEqual(RPCache.getBlock(r.state, 'world').content, '');
  assert.ok(r.changed);
});

test('filledBlockCount', () => {
  assert.strictEqual(W.filledBlockCount({ name: 'x', blocks: { world: 'a', style: '  ' } }), 1);
});
