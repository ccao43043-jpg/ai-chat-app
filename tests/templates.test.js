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
  assert.deepStrictEqual(all.filter(t => t.pinned).slice(0, 3).map(t => t.name), ['通用助手', '简洁回答', '沉浸式角色扮演'], '内置收藏在前');
  assert.deepStrictEqual(T.filter(l, { query: '翻译' }).map(t => t.id), ['t-translate']);
  assert.deepStrictEqual(T.filter(l, { query: '角色扮演' }).map(t => t.id), ['t-rp-immersive', 't-rp-cardgen', 't-rp-narrator', 't-rp-longform', 't-rp-cardrefine'], '按标签搜索');
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

test('自动宏：time/date/时间/日期 自动替换且不进入变量表单', () => {
  const s = '现在{{time}} {{date}} {{时间}} {{日期}} {{角色名}}';
  assert.deepStrictEqual(T.variables(s), ['角色名']);
  const out = T.fill(s, {});
  assert.match(out, /^现在\d{2}:\d{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \d{4}-\d{2}-\d{2} \{\{角色名\}\}$/);
  assert.strictEqual(T.fill('{{date}}', { date: '自定义' }), '自定义');
});

// v0.7.6：RP 模板
test('v0.7.6 RP 模板：变量完整、支持 date/time、留空省略、旧内置原文升级', () => {
  const d = T.defaultTemplates(); const by = id => d.find(t => t.id === id);
  ['沉浸式角色扮演', 'RP 叙事风格', '长篇续写', '角色卡生成助手'].forEach(n => assert.ok(d.some(t => t.name === n), n));
  const imm = by('t-rp-immersive');
  ['角色名', '用户名', '角色设定', '性格', '世界背景', '场景', '规则', '禁止事项'].forEach(v => assert.ok(T.variables(imm.content).includes(v), v));
  assert.ok(/\{\{date\}\}/.test(imm.content) && /\{\{time\}\}/.test(imm.content));
  const out = T.fill(imm.content, { 角色名: '艾琳', 用户名: '阿杰' }, { dropEmpty: true });
  assert.ok(!/\{\{/.test(out), '留空的变量行被省略、默认值生效'); assert.ok(out.includes('200–400'));
  assert.ok(!out.includes('【世界背景】'), '空分段标题也省略');
  assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(out));
  assert.ok(out.includes('艾琳') && out.includes('【规则】'));
  assert.ok(T.fill('- {{x}}', {}).includes('{{x}}'), '默认仍保留原样');
  // 旧版内置原文（用户没改过）升级为新内容；改过的保留
  const oldNar = '你是一名沉浸式角色扮演的叙事者，扮演{{角色名}}，世界背景：{{世界背景}}。\n- 以第三人称描写环境、动作与神态，对话用引号；\n- 只描写{{角色名}}和 NPC 的言行，绝不替玩家决定行动或心理；\n- NPC 只知道自己应该知道的信息；\n- 每次回复 150–300 字，结尾留下可以继续互动的钩子。';
  const m = T.mergeBuiltins([{ id: 't-rp-narrator', name: 'RP 叙事风格', content: oldNar, builtin: true }, { id: 't-rp-immersive', name: 'x', content: '我改过', builtin: true }], []);
  assert.strictEqual(m.find(t => t.id === 't-rp-narrator').content, by('t-rp-narrator').content);
  assert.strictEqual(m.find(t => t.id === 't-rp-immersive').content, '我改过');
});
test('v0.7.6 分段设定解析与块模板', () => {
  assert.strictEqual(R.parseSections('只有一段【世界观】'), null);
  const f = R.parseSections('好的，设定如下：\n【世界观】\n蒸汽朋克王都\n【角色卡】姓名：莉亚\n【示例对白】\n用户：你好\n角色：哼。\n【开场白】\n雨夜……');
  assert.deepStrictEqual(Object.keys(f).sort(), ['character', 'fewshot', 'opening', 'world']);
  assert.strictEqual(f.character, '姓名：莉亚');
  ['world', 'character', 'rules', 'format', 'fewshot', 'prohibit', 'style'].forEach(k => assert.ok(R.BLOCK_TEMPLATES[k], k));
});

// v0.7.7：角色卡生成助手完善
test('v0.7.7 角色卡生成助手：模式变量、一句话/问答、分层字段、精修模板、旧文升级', () => {
  const d = T.defaultTemplates(); const by = id => d.find(t => t.id === id);
  const gen = by('t-rp-cardgen'), ref = by('t-rp-cardrefine');
  assert.ok(gen && gen.pinned);
  assert.deepStrictEqual(T.variables(gen.content).sort(), ['额外要求', '想法', '模式', '用户名', '风格偏好'].sort());
  assert.ok(gen.content.includes('一句话生成') && gen.content.includes('逐步问答'));
  ['外貌', '性格优点', '性格缺点', '说话方式', '背景经历', '人物关系', '秘密', '禁忌'].forEach(k => assert.ok(gen.content.includes(k), k));
  ['【世界观】','【角色卡】','【RP规则】','【输出格式】','【示例对白】','【禁止事项】','【写作风格】','【开场白】'].forEach(h => assert.ok(gen.content.includes(h), h));
  const one = T.fill(gen.content, { 模式: '一句话生成', 想法: '冷淡黑客' }, { dropEmpty: true });
  assert.ok(one.includes('一句话生成') && one.includes('冷淡黑客') && !one.includes('风格偏好'));
  const ask = T.fill(gen.content, { 模式: '逐步问答' }, { dropEmpty: true });
  assert.ok(ask.includes('逐步问答') && !/想法：/.test(ask));
  assert.ok(ref && ref.content.includes('【精修说明】'));
  assert.ok(T.variables(ref.content).includes('精修重点'));
  // 旧版 cardgen 原文升级
  const old = '你是一名角色卡设计助手，帮助用户把零散的想法整理成可以直接用于角色扮演的完整设定。\n\n用户会给出一个角色或故事的想法（可能只有一两句话）。请：\n1. 先用 1–3 个简短问题确认最关键的缺失信息；如果用户说「直接写」，就合理补全。\n2. 然后按下面的分段输出设定，每段标题保持不变，方便复制到 RP 缓存优化器的「分层设定」对应块里：\n\n【世界观】时代、地点、势力、规则与基调（150–300 字）\n【角色卡】姓名、年龄、外貌、身份、背景经历、性格（优点与缺点）、说话方式与口头禅、喜好与禁忌、与用户的关系\n【RP规则】扮演时必须遵守的规则（如视角、不替用户行动、知识边界）\n【输出格式】回复长度、动作 / 对白的写法、人称\n【示例对白】3 组「用户：…… / 角色：……」的示范，体现角色的语气\n【禁止事项】角色绝不会做 / 说的事，以及不希望出现的内容\n【写作风格】文风、节奏、描写侧重\n【开场白】一段可以直接作为第一条消息的开场（100–200 字）\n\n不要输出与设定无关的解释。';
  const m = T.mergeBuiltins([{ id: 't-rp-cardgen', name: '角色卡生成助手', content: old, builtin: true }], []);
  assert.strictEqual(m.find(t => t.id === 't-rp-cardgen').content, gen.content);
});
test('v0.7.7 parseSections：开场白 / 精修说明 / 往回查找', () => {
  const f = R.parseSections('【世界观】A\n【角色卡】B\n【开场白】开场\n【精修说明】改了外貌');
  assert.strictEqual(f.opening, '开场'); assert.ok(!f.精修说明); assert.strictEqual(f.world, 'A');
  assert.ok(R.BLOCK_TEMPLATES.character.includes('性格优点'));
  const hit = R.findSectionMessage([{ role: 'assistant', content: '无' }, { role: 'assistant', content: '【世界观】X\n【角色卡】Y' }], 8);
  assert.strictEqual(hit.fields.world, 'X');
});
