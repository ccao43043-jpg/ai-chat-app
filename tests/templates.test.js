// 提示词模板：增删改、复制、排序、收藏、搜索、变量、导入导出、助手套用、与 RP 插件的交互
const test = require('node:test');
const assert = require('node:assert');
const T = require('../app/src/main/assets/www/templates.js');
const R = require('../app/src/main/assets/www/rpcache.js');

test('内置模板与合并', () => {
  const d = T.defaultTemplates();
  assert.ok(d.length >= 6);
  ['通用助手', '简洁回答', '中英互译', '润色改写', 'RP 叙事风格'].forEach(n => assert.ok(d.some(t => t.name === n), n));
  assert.ok(d.every(t => t.builtin && t.id.startsWith('t-')));
  // 旧数据只有部分模板 + 用户删除了一个内置模板
  const merged = T.mergeBuiltins([{ id: 'mine', name: '我的', content: 'X' }], ['t-coder']);
  assert.strictEqual(merged[0].id, 'mine');
  assert.ok(!merged.some(t => t.id === 't-coder'));
  assert.strictEqual(merged.length, d.length);
});

test('规范化：名称兜底、标签拆分去重、emoji 截断', () => {
  const t = T.normalizeTemplate({ content: '你是一个非常专业的法律顾问助手', tags: '法律, 工作，法律 、 咨询' });
  assert.strictEqual(t.name, '你是一个非常专业的法律顾');
  assert.deepStrictEqual(t.tags, ['法律', '工作', '咨询']);
  assert.ok(t.id.startsWith('t-'));
  assert.strictEqual(T.normalizeTemplate({ name: ' A ', emoji: '😀😀😀', content: 'x' }).name, 'A');
});

test('增删改、复制、排序、收藏', () => {
  let l = T.defaultTemplates();
  const n = l.length;
  l = T.upsert(l, { id: 'a', name: '新模板', content: '内容 A' });
  assert.strictEqual(l[0].id, 'a'); assert.strictEqual(l.length, n + 1);
  l = T.upsert(l, { id: 'a', name: '改名', content: '内容 B' });
  assert.strictEqual(l.length, n + 1); assert.strictEqual(l[0].name, '改名'); assert.strictEqual(l[0].content, '内容 B');
  l = T.duplicate(l, 'a');
  assert.strictEqual(l[1].name, '改名（副本）'); assert.notStrictEqual(l[1].id, 'a'); assert.strictEqual(l[1].builtin, false);
  l = T.move(l, 'a', 1);
  assert.strictEqual(l[1].id, 'a');
  assert.strictEqual(T.move(l, l[0].id, -1), l, '已经在最前面');
  l = T.togglePin(l, 'a');
  assert.strictEqual(l.find(t => t.id === 'a').pinned, true);
  l = T.remove(l, 'a');
  assert.ok(!l.some(t => t.id === 'a'));
});

test('搜索与标签筛选：收藏在前', () => {
  const l = T.defaultTemplates();
  const all = T.filter(l, {});
  assert.deepStrictEqual(all.slice(0, 2).map(t => t.name), ['通用助手', '简洁回答'], '内置收藏在前');
  assert.deepStrictEqual(T.filter(l, { query: '翻译' }).map(t => t.id), ['t-translate']);
  assert.deepStrictEqual(T.filter(l, { query: '角色扮演' }).map(t => t.id), ['t-rp-narrator'], '按标签搜索');
  assert.ok(T.filter(l, { tag: '常用' }).every(t => t.tags.includes('常用')));
  assert.ok(T.allTags(l).includes('写作'));
});

test('最近使用', () => {
  let r = [];
  ['a', 'b', 'a', 'c', 'd', 'e', 'f'].forEach(id => { r = T.pushRecent(r, id, 5); });
  assert.deepStrictEqual(r, ['f', 'e', 'd', 'c', 'a']);
  assert.deepStrictEqual(T.recentOf([{ id: 'a' }, { id: 'c' }], r).map(t => t.id), ['c', 'a']);
});

test('变量：提取、填写、未填保留', () => {
  const c = '请以{{身份}}的身份回答，语气{{ 语气 }}。再次强调：{{身份}}。不是变量：{单括号} {{}}';
  assert.deepStrictEqual(T.variables(c), ['身份', '语气']);
  assert.strictEqual(T.fill(c, { 身份: '律师', 语气: '' }), '请以律师的身份回答，语气{{ 语气 }}。再次强调：律师。不是变量：{单括号} {{}}');
  assert.deepStrictEqual(T.variables('没有变量'), []);
});

test('导出 / 导入 JSON', () => {
  const l = T.defaultTemplates().slice(0, 3);
  const json = T.exportJSON(l);
  const data = JSON.parse(json);
  assert.strictEqual(data.format, 'ai-chat-templates'); assert.strictEqual(data.templates.length, 3);
  assert.ok(!('id' in data.templates[0]) && !('builtin' in data.templates[0]));
  // 重复的跳过
  let r = T.importJSON(json, l);
  assert.strictEqual(r.added, 0); assert.strictEqual(r.skipped, 3);
  // 数组格式 + BOM + 无内容的跳过 + 兼容 title / systemPrompt 字段
  r = T.importJSON('\uFEFF' + JSON.stringify([{ title: '外部', systemPrompt: '你是外部模板' }, { name: '空' }]), l);
  assert.strictEqual(r.added, 1); assert.strictEqual(r.skipped, 1);
  const added = r.list[r.list.length - 1];
  assert.strictEqual(added.name, '外部'); assert.strictEqual(added.builtin, false);
  assert.throws(() => T.importJSON('not json', l), /JSON/);
  assert.throws(() => T.importJSON('{"a":1}', l), /模板列表/);
});

test('助手可以当模板套用；applyToConv 不修改原对象', () => {
  const t = T.fromPersona({ id: 'p-coder', name: '代码助手', emoji: '💻', systemPrompt: '你是工程师' });
  assert.strictEqual(t.id, 'persona:p-coder'); assert.strictEqual(t.content, '你是工程师');
  const conv = { systemPrompt: '旧' };
  const r = T.applyToConv(conv, T.defaultTemplates().find(x => x.id === 't-role'), { 身份: '医生' });
  assert.strictEqual(r.systemPrompt, '请以医生的身份和专业视角回答我的问题，语气{{语气}}。');
  assert.strictEqual(r.templateName, '以某种身份回答');
  assert.strictEqual(conv.systemPrompt, '旧');
  assert.deepStrictEqual(T.applyToConv(conv, null), { systemPrompt: '', templateId: null, templateName: null, templateEmoji: null });
});

test('RP 插件：切换模板走显式 L1 更新（static 版本 +1），诊断原因显示「切换了提示词模板」', () => {
  let st = R.normalizeState(null);
  st = R.syncBase(st, '旧提示词');
  assert.strictEqual(st.staticVersion, 1);
  const p1 = R.plan(st, '旧提示词', [{ id: 'u1', role: 'user', content: '你好' }]);
  const e1 = R.makeLogEntry({ fp: R.fingerprints(p1, '旧提示词'), at: 1, model: 'deepseek-flash' });
  // 同样的内容：不升级
  assert.strictEqual(R.explicitBaseUpdate(st, '旧提示词  ', { kind: 'template', name: 'X' }, 2).changed, false);
  const r = R.explicitBaseUpdate(st, '新的模板内容', { kind: 'template', name: '简洁回答' }, 2);
  assert.ok(r.changed); st = r.state;
  assert.strictEqual(st.staticVersion, 2);
  assert.deepStrictEqual(st.pendingStaticCause, { at: 2, kind: 'template', name: '简洁回答' });
  assert.strictEqual(R.syncBase(st, '新的模板内容'), st, '发送时不会再次升级版本');
  const items = [{ id: 'u1', role: 'user', content: '你好' }, { id: 'a1', role: 'assistant', content: '嗨' }, { id: 'u2', role: 'user', content: '继续' }];
  const p2 = R.plan(st, '新的模板内容', items); const fp2 = R.fingerprints(p2, '新的模板内容');
  const d2 = R.diagnose(e1, fp2, p2.hist);
  assert.strictEqual(d2.static, 'CHANGED'); assert.strictEqual(d2.history, 'APPEND');
  const e2 = R.makeLogEntry({ fp: fp2, diag: d2, at: 3, model: 'deepseek-flash', prev: e1, staticCause: st.pendingStaticCause });
  assert.strictEqual(e2.reason, '切换了提示词模板「简洁回答」，L1 固定前缀改变');
  assert.strictEqual(R.makeLogEntry({ fp: fp2, diag: d2, at: 3, prev: e1, staticCause: { kind: 'clear' } }).reason, '清空了提示词模板，L1 固定前缀改变');
  assert.strictEqual(R.makeLogEntry({ fp: fp2, diag: d2, at: 3, prev: e1 }).reason, '角色卡 / 世界观等永久锚点被修改');
});
