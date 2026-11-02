const test = require('node:test'); const assert = require('node:assert');
const A = require('../app/src/main/assets/www/autochar.js');
const conv = (o) => Object.assign({ templateId: 't-rp-immersive', systemPrompt: '请以 角色 的身份…\n【角色】\n', messages: [{ role: 'user', content: '我想玩一个吸血鬼城堡的故事' }] }, o);
test('首条消息 + RP 模板 + 无角色卡 → 询问', () => { assert.ok(A.shouldOffer(conv(), [], {})); });
test('已有角色设定 / 已问过 / 非首条 / 非 RP 模板 → 不问', () => {
  assert.ok(!A.shouldOffer(conv({ systemPrompt: '- 设定：冷淡的骑士' }), [], {}));
  assert.ok(!A.shouldOffer(conv({ autoChar: { asked: true } }), [], {}));
  assert.ok(!A.shouldOffer(conv({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] }), [], {}));
  assert.ok(!A.shouldOffer(conv({ templateId: 't-general' }), [], {}));
  assert.ok(!A.shouldOffer(conv({ templateId: 't-rp-cardgen' }), [], {}));
  assert.ok(!A.shouldOffer(conv({ plugins: { rpcache: { state: { blocks: [{ id: 'character', content: 'x' }] } } } }), [], {}));
  assert.ok(!A.shouldOffer(conv(), [], { autoCharGen: false }));
});
test('自定义角色扮演标签模板也算', () => { assert.ok(A.shouldOffer(conv({ templateId: 't-x' }), [{ id: 't-x', tags: ['角色扮演'] }], {})); });
test('解析 8 段输出', () => {
  const f = A.parse('【世界观】\n- 中世纪\n【角色卡】\n- 姓名：艾琳\n【开场白】\n你好');
  assert.equal(f.character.includes('艾琳'), true); assert.equal(A.charName(f), '艾琳');
  assert.ok(A.toPromptAppend(f).includes('【角色卡】'));
  assert.equal(A.parse('随便说点'), null);
});

// v0.8.3：触发 / 解析容错 / 变量清理
const T = require('../app/src/main/assets/www/templates.js');
const tpl = id => T.BUILTIN_TEMPLATES.find(t => t.id === id).content;
const filledConv = (id, vals) => conv({ templateId: id, systemPrompt: T.fill(tpl(id), vals, { dropEmpty: true }) });
test('三套内置模板：填了角色设定 → 不问；没填 → 问', () => {
  ['t-rp-immersive', 't-rp-narrator', 't-rp-longform'].forEach(id => {
    assert.ok(!A.shouldOffer(filledConv(id, { 角色名: '艾琳', 角色设定: '冷淡的吸血鬼伯爵' }), [], {}), id + ' filled');
    assert.ok(A.shouldOffer(filledConv(id, {}), [], {}), id + ' empty');
  });
});
test('设置 autoCharMode：off 不问；旧 autoCharGen=false 兼容；auto 仍触发', () => {
  assert.ok(!A.shouldOffer(conv(), [], { autoCharMode: 'off' }));
  assert.equal(A.mode({ autoCharGen: false }), 'off'); assert.equal(A.mode({ autoCharMode: 'auto' }), 'auto'); assert.equal(A.mode({}), 'ask');
  assert.ok(A.shouldOffer(conv(), [], { autoCharMode: 'auto' }));
});
test('已有助手开场白 → 不问', () => {
  assert.ok(!A.shouldOffer(conv({ messages: [{ role: 'assistant', content: '*夜色降临*' }, { role: 'user', content: '你好' }] }), [], {}));
});
const fx = {
  numbered: '1. 世界观\n- 中世纪城堡\n2. 角色卡\n- 姓名：艾琳\n- 性格：冷淡\n3. 开场白\n夜色降临。',
  bold: '**世界观**\n- 城堡\n**角色卡**：\n- **姓名**：艾琳（Erin）\n- 年龄：300',
  md: '```markdown\n## 【世界观】\n- 城堡\n## 【角色卡】\n- 名字：艾琳\n```',
  think: '<think>我先想想 【角色卡】 应该…</think>\n【世界观】\n- 城堡\n【角色卡】\n- 姓名：艾琳',
  chinese: '一、世界观\n- 城堡\n二、角色卡\n- 姓名：艾琳，女',
  only: '【角色卡】\n- 姓名：艾琳\n- 性格：冷淡、骄傲、嘴硬心软',
  plain: '姓名：艾琳\n年龄：三百岁\n性格：冷淡、骄傲，其实很孤独。身份：古堡主人，吸血鬼伯爵，守护着一个秘密。',
};
test('解析容错：序号 / 加粗 / Markdown 围栏 / 思考块 / 中文序号 / 单段 / 无标题', () => {
  Object.keys(fx).forEach(k => { const f = A.parse(fx[k]); assert.ok(f && f.character, k); assert.equal(A.charName(f), '艾琳', k); });
  assert.equal(A.parse('好的，我来帮你。'), null); assert.equal(A.parse(''), null);
});
test('正文里的「规则：xxx」不会被当成标题', () => {
  const f = A.parse('【角色卡】\n- 姓名：艾琳\n规则：不许 OOC\n【世界观】\n- 城堡');
  assert.ok(f.character.includes('不许 OOC'));
});
test('首条消息就是分段角色卡 → 直接识别', () => {
  assert.ok(A.fromUserText('【世界观】\n- 城堡\n【角色卡】\n- 姓名：艾琳'));
  assert.equal(A.fromUserText('我想玩吸血鬼故事'), null);
});
test('fillLeftovers：{{角色名}}→名字，空变量行与空分段删掉', () => {
  const sp = T.fill(tpl('t-rp-immersive'), {}, { dropEmpty: true });
  const out = A.fillLeftovers(sp, { character: '- 姓名：艾琳' });
  assert.ok(!/\{\{/.test(out), out); assert.ok(out.includes('请以 艾琳 的身份')); assert.ok(out.includes('与 你 进行'));
  assert.ok(!/【规则】\n- \n/.test(out));
});
test('提示词包含硬性格式要求和用户首条消息', () => {
  const p = A.buildPrompt('我叫小林，想和吸血鬼伯爵谈恋爱', '', '');
  assert.ok(p.includes('硬性要求') && p.includes('小林') && p.includes('【开场白】'));
});
