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
