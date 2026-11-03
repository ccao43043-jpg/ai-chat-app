const test = require('node:test');
const assert = require('node:assert');
globalThis.Plugins = require('../app/src/main/assets/www/plugins.js');
const M = require('../app/src/main/assets/www/rpmemory.js');

test('解析：代码块 JSON / 对象包裹 / 行格式 / 垃圾', () => {
  let r = M.parseExtraction('```json\n[{"type":"fact","text":"艾琳是药剂师","keywords":["艾琳"]},{"type":"bogus","text":"x"}]\n```');
  assert.strictEqual(r.length, 2); assert.strictEqual(r[0].type, 'fact'); assert.strictEqual(r[1].type, 'detail');
  r = M.parseExtraction('{"items":[{"type":"relation","text":"艾琳开始信任主角"}]}'); assert.strictEqual(r[0].type, 'relation'); assert.ok(r[0].keywords.length);
  r = M.parseExtraction('- [事件] 两人在雨夜相遇\n- [关系] 成为朋友'); assert.deepStrictEqual(r.map(x => x.type), ['event', 'relation']);
  assert.deepStrictEqual(M.parseExtraction('没有'), []);
});
test('去重合并', () => {
  let r = M.mergeEntries([], [{ type: 'fact', text: '艾琳是药剂师', keywords: ['艾琳'] }], 1);
  r = M.mergeEntries(r.list, [{ type: 'fact', text: '艾琳是药剂师。', keywords: ['药剂师'] }, { type: 'event', text: '主角救了艾琳', keywords: [] }], 2);
  assert.strictEqual(r.list.length, 2); assert.strictEqual(r.merged, 1); assert.deepStrictEqual(r.list[0].keywords, ['艾琳', '药剂师']);
});
test('相关性选择：关键词命中、置顶、停用、数量上限、顺序稳定', () => {
  const l = M.mergeEntries([], [{ type: 'fact', text: '艾琳是药剂师', keywords: ['艾琳'] }, { type: 'detail', text: '城堡地下有密道', keywords: ['密道'] },
    { type: 'fact', text: '主角怕水', keywords: ['游泳'] }], 1).list;
  l[2].pinned = true;
  let s = M.selectRelevant(l, '我们去找艾琳吧', { maxInject: 8 }); assert.deepStrictEqual(s.map(e => e.text), ['艾琳是药剂师', '主角怕水']);
  l[0].disabled = true; s = M.selectRelevant(l, '艾琳', {}); assert.deepStrictEqual(s.map(e => e.text), ['主角怕水']);
  assert.strictEqual(M.selectRelevant(l, '密道 艾琳', { maxInject: 1 }).length, 1);
  assert.ok(M.renderInjection(s).startsWith('[MEMORY_RECALL]')); assert.strictEqual(M.renderInjection([]), '');
  assert.ok(M.shouldExtract(20, 0, 20) && !M.shouldExtract(19, 0, 20));
});
test('插件：只改最后一条用户消息；第 N 轮后台提取，失败不抛', async () => {
  const pl = Plugins.registry.get('rpmemory'); assert.ok(pl);
  const mem = {}, settings = { plugins: { rpmemory: { enabled: true, interval: 5 } } };
  const conv = { id: 'c1', personaId: 'p1', messages: [] };
  for (let i = 0; i < 5; i++) conv.messages.push({ role: 'user', content: '艾琳' + i }, { role: 'assistant', content: 'ok' });
  let calls = 0, fail = false;
  const host = { settings: () => settings, saveSettings() {}, saveConv() {}, isCurrent: () => false, refresh() {},
    store: { get: (n, d) => mem[n] || d, set: (n, v) => { mem[n] = v; } },
    callModel: async () => { calls++; if (fail) throw new Error('boom'); return '[{"type":"fact","text":"艾琳是药剂师","keywords":["艾琳"]}]'; } };
  pl.hooks.onAfterResponse({ ok: true }, { conv }, host);
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(calls, 1); assert.strictEqual(mem[M.FILE]['persona:p1'].entries.length, 1);
  pl.hooks.onAfterResponse({ ok: true }, { conv }, host); await new Promise(r => setTimeout(r, 10)); assert.strictEqual(calls, 1);
  const ctx = { conv, systemPrompt: 'SYS', meta: {}, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: '艾琳在哪' }] };
  const c = pl.hooks.onBeforeRequest(ctx, host);
  assert.strictEqual(c.systemPrompt, 'SYS'); assert.strictEqual(c.messages[0].content, 'a'); assert.ok(c.messages[2].content.includes('[MEMORY_RECALL]'));
  fail = true; for (let i = 0; i < 5; i++) conv.messages.push({ role: 'user', content: 'x' });
  await assert.doesNotReject(M._extract(conv, host, false));
  assert.strictEqual(mem[M.FILE]['persona:p1'].lastError, 'boom');
});

test('中文关键词不截断成长词前两字；相关性可命中长词', () => {
  const M = require('../app/src/main/assets/www/rpmemory.js');
  const kws = M.autoKeywords('艾琳是王城东郊的药剂师');
  assert.ok(kws.some(k => k.includes('药剂师') || k === '药剂师' || k.length >= 3), '应保留有意义中文词');
  assert.ok(!kws.every(k => k.length <= 2 && /[\u4e00-\u9fff]/.test(k)), '不应只剩两字截断');
  const list = [{ id: '1', type: 'fact', text: '艾琳是王城东郊的药剂师', keywords: M.autoKeywords('艾琳是王城东郊的药剂师'), seq: 1, pinned: false }];
  const hit = M.selectRelevant(list, '去找药剂师', { maxInject: 4, minScore: 1 });
  assert.ok(hit.length >= 1, '查询「药剂师」应命中');
});
