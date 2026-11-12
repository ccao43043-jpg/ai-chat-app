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
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(c.systemPrompt) && c.systemPrompt.includes('本轮动态信息'), 'v0.21.3：时间不冻进 system');
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

test('开场白：normalize 保留内部换行、缺省为空', () => {
  assert.strictEqual(W.normalizeWorld({}).greeting, '');
  assert.strictEqual(W.normalizeWorld({ greeting: '  *雨夜*\r\n\r\n「……又是新面孔。」 ' }).greeting, '*雨夜*\n\n「……又是新面孔。」');
  assert.strictEqual(W.normalizeWorld(JSON.parse(JSON.stringify(W.normalizeWorld({ greeting: 'hi' })))).greeting, 'hi');
});

test('开场白：空则不插；有则生成首条助手消息；已有消息不插（同步路径）', () => {
  assert.strictEqual(W.greetingMessage({ greeting: '  ' }, { model: 'm', messages: [] }), null);
  const m = W.greetingMessage({ greeting: '「你好」' }, { model: 'gpt', messages: [] }, 123, () => 'id1');
  assert.deepStrictEqual(m, { id: 'id1', role: 'assistant', content: '「你好」', model: 'gpt', createdAt: 123 });
  assert.strictEqual(W.greetingMessage({ greeting: 'x' }, { model: 'gpt', messages: [{ role: 'user', content: 'a' }] }), null);
  const conv = W.applyWorldToConversation({ messages: [] }, { greeting: 'x', blocks: { world: 'w' } }, RPCache, 1).conv;
  assert.ok(!(conv.messages || []).length, '套用世界本身不插开场白');
});

// ---------- v0.28.7：从全文填入 / 复制全文 ----------
const AutoChar = require('../app/src/main/assets/www/autochar.js');
const fs = require('fs');
const path = require('path');
const P = { RPCache, AutoChar };
const FULL = [
  '【世界观】', '- 雨港：常年下雨的港口城', '### 势力', '- 码头公会',
  '【角色卡】', '- 姓名：林晚', '- 28 岁私家侦探', '【主要NPC】', '- 老周：线人',
  '【RP规则】', '- 不替玩家决定',
  '【输出格式】', '- 第三人称',
  '【示例对白】', '用户：好累', '角色：「先喝口茶。」',
  '【禁止事项】', '- 禁止 OOC',
  '【写作风格】', '- 短句',
  '【开场白】', '*雨夜，门被推开*「……又是新面孔。」',
].join('\n');

test('parseWorldSections：标准 8 段 → 7 块 + 开场白 + 姓名；段内小标题保留', () => {
  const p = W.parseWorldSections(FULL, P);
  assert.ok(p);
  assert.deepStrictEqual(Object.keys(p.blocks).sort(), W.BLOCK_IDS.slice().sort());
  assert.strictEqual(p.blocks.world, '- 雨港：常年下雨的港口城\n### 势力\n- 码头公会');
  assert.strictEqual(p.blocks.character, '- 姓名：林晚\n- 28 岁私家侦探\n【主要NPC】\n- 老周：线人');
  assert.strictEqual(p.blocks.rules, '- 不替玩家决定');
  assert.strictEqual(p.blocks.fewshot, '用户：好累\n角色：「先喝口茶。」');
  assert.strictEqual(p.blocks.style, '- 短句');
  assert.strictEqual(p.greeting, '*雨夜，门被推开*「……又是新面孔。」');
  assert.strictEqual(p.name, '林晚');
  // 不传 AutoChar 也能用（只用 RPCache.parseSections）
  const p2 = W.parseWorldSections(FULL, { RPCache });
  assert.deepStrictEqual(p2.blocks, p.blocks);
  assert.strictEqual(p2.name, '林晚');
});

test('parseWorldSections：标题变体 / 思考块 / 精修说明跳过', () => {
  const t = '<think>先想想</think>\n1. 世界观\n魔法学院\n**角色设定**\n- 名字：艾琳\n### 【RP规则】\n不 OOC\n【精修说明】\n这里不导入\n文风：\n古风短句\n【开场】\n「早。」';
  const p = W.parseWorldSections(t, P);
  assert.ok(p);
  assert.strictEqual(p.blocks.world, '魔法学院');
  assert.strictEqual(p.blocks.character, '- 名字：艾琳');
  assert.strictEqual(p.blocks.rules, '不 OOC');
  assert.strictEqual(p.blocks.style, '古风短句');
  assert.strictEqual(p.greeting, '「早。」');
  assert.strictEqual(p.name, '艾琳');
  assert.ok(!Object.values(p.blocks).some(v => v.includes('这里不导入')));
  assert.ok(!('精修说明' in p.fields));
});

test('parseWorldSections：无法识别返回 null', () => {
  assert.strictEqual(W.parseWorldSections('', P), null);
  assert.strictEqual(W.parseWorldSections('只是一段普通文字，没有标题。', P), null);
  assert.strictEqual(W.parseWorldSections('【世界观】\n只有一段', P), null);
  assert.strictEqual(W.parseWorldSections('【世界观】\n一段\n【开场白】\n开场不算块', P), null);
  assert.strictEqual(W.parseWorldSections('【精修说明】\nA\n【备注】\nB', P), null);
});

test('applySectionsToWorld：只填空项 vs 覆盖；不动其它字段、不造空键', () => {
  const p = W.parseWorldSections(FULL, P);
  const form = { id: 'w-1', emoji: '🌧️', name: '', desc: '简介', greeting: '', createdAt: 5,
    blocks: { world: '我自己的世界观', character: '', rules: '  ', format: '', fewshot: '', prohibit: '', style: '' } };
  const r = W.applySectionsToWorld(form, p, { overwrite: false });
  assert.deepStrictEqual(r.skipped, ['world']);
  assert.deepStrictEqual(r.filled, ['character', 'rules', 'format', 'fewshot', 'prohibit', 'style']);
  assert.strictEqual(r.world.blocks.world, '我自己的世界观');
  assert.strictEqual(r.world.blocks.character, p.blocks.character);
  assert.ok(r.greetingFilled && r.nameFilled);
  assert.strictEqual(r.world.name, '林晚');
  assert.strictEqual(r.world.greeting, p.greeting);
  assert.strictEqual(r.world.desc, '简介');
  assert.strictEqual(r.world.emoji, '🌧️');
  assert.strictEqual(r.world.id, 'w-1');
  assert.strictEqual(form.blocks.character, '', '不改入参');

  const named = Object.assign({}, form, { name: '雨港', greeting: '旧开场' });
  const r1 = W.applySectionsToWorld(named, p, { overwrite: false });
  assert.ok(!r1.nameFilled && !r1.greetingFilled && r1.nameSkipped && r1.greetingSkipped);
  assert.strictEqual(r1.world.name, '雨港');
  const r2 = W.applySectionsToWorld(named, p, { overwrite: true });
  assert.ok(r2.filled.includes('world') && r2.nameFilled && r2.greetingFilled);
  assert.strictEqual(r2.world.blocks.world, p.blocks.world);
  assert.strictEqual(r2.world.name, '林晚');
  assert.deepStrictEqual(r2.skipped, []);

  // 只解析到两块：其它块不动、不新增空键
  const p3 = W.parseWorldSections('【世界观】\nA\n【写作风格】\nB', P);
  const r3 = W.applySectionsToWorld({ name: 'x', blocks: { world: '' } }, p3, { overwrite: true });
  assert.deepStrictEqual(Object.keys(r3.world.blocks).sort(), ['style', 'world']);
  assert.ok(!r3.nameFilled && !r3.greetingFilled);
  assert.strictEqual(r3.world.greeting, undefined);
});

test('formatWorldSections：固定标题、空块省略、往返一致', () => {
  const p = W.parseWorldSections(FULL, P);
  const text = W.formatWorldSections({ blocks: p.blocks, greeting: p.greeting });
  ['世界观', '角色卡', 'RP规则', '输出格式', '示例对白', '禁止事项', '写作风格', '开场白'].forEach(t => assert.ok(text.includes('【' + t + '】\n'), t));
  assert.ok(text.indexOf('【世界观】') < text.indexOf('【角色卡】') && text.indexOf('【写作风格】') < text.indexOf('【开场白】'));
  const back = W.parseWorldSections(text, P);
  assert.deepStrictEqual(back.blocks, p.blocks);
  assert.strictEqual(back.greeting, p.greeting);

  const partial = W.formatWorldSections({ blocks: { world: '世界', character: '', rules: '规则' }, greeting: '  ' });
  assert.strictEqual(partial, '【世界观】\n世界\n\n【RP规则】\n规则');
  assert.strictEqual(W.formatWorldSections({}), '');
  const full = W.normalizeWorld({ name: 'n', blocks: p.blocks, greeting: p.greeting });
  assert.deepStrictEqual(W.parseWorldSections(W.formatWorldSections(full), P).blocks, p.blocks);
});

test('世界编辑页：有「从全文填入」「复制全文」与粘贴弹窗，不复活诊断浮层', () => {
  const www = path.join(__dirname, '../app/src/main/assets/www');
  const html = fs.readFileSync(path.join(www, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(www, 'app.js'), 'utf8');
  const page = html.slice(html.indexOf('id="page-world"'), html.indexOf('<!-- 助手库 -->'));
  assert.ok(page.includes('id="wd-paste"') && page.includes('从全文填入'));
  assert.ok(page.includes('id="wd-copy-all"') && page.includes('复制全文'));
  assert.ok(page.indexOf('id="wd-paste"') < page.indexOf('id="wd-blocks"'), '按钮在设定块上方');
  assert.ok(html.includes('id="wp-mask"') && html.includes('id="wp-text"') && html.includes('id="wp-ok"') && html.includes('id="wp-cancel"'));
  assert.ok(/【开场白】填到上方开场白/.test(html));
  assert.ok(js.includes('Worlds.parseWorldSections') && js.includes('Worlds.formatWorldSections') && js.includes("label: '覆盖已有'"));
  assert.ok(html.includes('本轮请求数据'));
  assert.ok(!html.includes('diag-root') && !html.includes('diag.js'));
});
