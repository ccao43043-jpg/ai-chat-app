// RP 插件钩子（模拟宿主）：冻结用户消息、自动摘要流程（模型调用被模拟）、日志与徽章
const test = require('node:test');
const assert = require('node:assert');
const Plugins = require('../app/src/main/assets/www/plugins.js');
const R = require('../app/src/main/assets/www/rpcache.js');
global.window = { Plugins, RPCache: R };
require('../app/src/main/assets/www/rp-plugin.js');
const P = require('../app/src/main/assets/www/providers.js');
const reg = Plugins.registry;
const ds = Object.assign({ apiKey: 'sk', id: 'p1' }, P.PRESETS.find(p => p.presetId === 'deepseek'));

function mkHost(conv, settings, modelReply) {
  const store = {}; const calls = []; const toasts = [];
  return { calls, toasts, raw: store,
    settings: () => settings, saveSettings() {}, conv: () => conv, saveConv() {}, refresh() {}, toast: (t, a) => { toasts.push(t); if (a) toasts.actions = a; }, esc: s => s, provider: () => ds,
    store: { get: (k, d) => (k in store ? JSON.parse(store[k]) : d), set: (k, v) => { store[k] = JSON.stringify(v); } },
    openPanel() {},
    callModel: async (prompt, o) => { calls.push({ prompt, o }); if (o && o.setCancel) o.setCancel(() => {}); return typeof modelReply === 'function' ? modelReply(prompt) : modelReply; } };
}
async function send(conv, settings, host, text, state) {
  const user = { id: 'u' + conv.messages.length, role: 'user', content: text };
  conv.messages.push(user);
  const statuses = [];
  const ctx = { conv, provider: ds, model: 'deepseek-flash', systemPrompt: conv.systemPrompt, settings, lastUser: user, meta: {}, opts: { stream: true },
    messages: conv.messages.map(m => ({ role: m.role, content: m.content, _src: m })), setStatus: t => statuses.push(t), setCancel() {} };
  const out = await reg.runBeforeRequest(ctx, host);
  const req = P.buildChatRequest(ds, out.model, out.messages, out.systemPrompt, out.opts);
  const bot = { id: 'a' + conv.messages.length, role: 'assistant', content: '回复：' + text };
  conv.messages.push(bot);
  const body = JSON.parse(req.body);
  const n = body.messages.length * 100;
  reg.runAfterResponse(out, { ok: true, bot, usage: { prompt: n, hit: n - 50, miss: 50, completion: 20, cacheSupported: true } }, host);
  return { out, body, bot, statuses };
}

test('未在对话中开启时请求完全不变', async () => {
  const settings = {}; const conv = { id: 'c0', systemPrompt: 'S', messages: [] };
  const host = mkHost(conv, settings, '');
  const r = await send(conv, settings, host, '你好');
  assert.deepStrictEqual(r.body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: '你好' }]);
  assert.strictEqual(r.bot.rpCache, undefined);
});

test('开启后：状态后置、联网/文件内容冻结在用户消息里、日志记录诊断', async () => {
  const settings = {}; const conv = { id: 'c1', systemPrompt: '你是RP助手', messages: [] };
  reg.setForConversation(conv, 'rpcache', true);
  const d = reg.convData(conv, 'rpcache'); d.state = R.setBlock(R.normalizeState(null), 'state', 'HP: 80', 1).state;
  const host = mkHost(conv, settings, '');
  const r1 = await send(conv, settings, host, '【搜索结果…】推门');
  assert.strictEqual(r1.body.messages[1].content, '【搜索结果…】推门\n\n[CURRENT_STATE]\nHP: 80', 'V2：输入在前，状态在后');
  // 下一轮：宿主不再注入搜索结果，但历史里仍用首次发送的原文
  conv.messages[0].content = '推门';
  d.state = R.setBlock(d.state, 'state', 'HP: 75', 2).state;
  const r2 = await send(conv, settings, host, '拔剑');
  assert.deepStrictEqual(r2.body.messages.map(m => m.content), ['你是RP助手', '【搜索结果…】推门', '回复：【搜索结果…】推门', '拔剑\n\n[CURRENT_STATE]\nHP: 75']);
  const logs = JSON.parse(host.raw['rplog_c1.json']);
  assert.strictEqual(logs.length, 2);
  assert.deepStrictEqual(logs[1].diag, { static: 'SAME', memory: 'SAME', summary: 'SAME', delta: 'SAME', state: 'CHANGED', input: 'CHANGED', history: 'APPEND' });
  assert.strictEqual(logs[1].reason, '正常动态更新');
  assert.strictEqual(logs[1].request_id, 'req_0002');
  assert.ok(!host.raw['rplog_c1.json'].includes('拔剑'), '日志默认不含 Prompt 文本');
  const badges = reg.messageBadges(r2.bot, settings, conv, host);
  assert.ok(badges[0].text.startsWith('缓存 '));
});

test('自动摘要：达到阈值时先调用模型生成 #001，显示状态，再发送；被摘要的消息不发送但保留', async () => {
  const settings = {}; const conv = { id: 'c2', systemPrompt: '', messages: [] };
  reg.setForConversation(conv, 'rpcache', true);
  const d = reg.convData(conv, 'rpcache'); d.state = R.normalizeState(null);
  d.state.settings.summary = { enabled: true, trigger_tokens: 50, min_new_turns: 3, keep_recent_turns: 2 };
  const host = mkHost(conv, settings, p => 'FACTS:\n- 摘要内容\n\nCHARACTER_KNOWLEDGE:\n- 无\n\nPLAYER_KNOWLEDGE:\n- 无\n\nSECRET:\n- 无\n\nUNRESOLVED:\n- 无');
  for (let i = 1; i <= 5; i++) await send(conv, settings, host, '第' + i + '轮行动，描写一段比较长的剧情内容');
  assert.strictEqual(host.calls.length, 0, '可摘要轮数不足 min_new_turns 时不摘要');
  const r = await send(conv, settings, host, '第6轮');
  assert.strictEqual(host.calls.length, 1);
  assert.ok(host.calls[0].prompt.includes('第1轮行动'));
  assert.deepStrictEqual(r.statuses, ['正在生成章节摘要…', null]);
  assert.ok(r.body.messages[0].content.includes('[CHAPTER_SUMMARY #001]\nFACTS:\n- 摘要内容'));
  assert.deepStrictEqual(r.body.messages.slice(1).map(m => m.content), ['第4轮行动，描写一段比较长的剧情内容', '回复：第4轮行动，描写一段比较长的剧情内容',
    '第5轮行动，描写一段比较长的剧情内容', '回复：第5轮行动，描写一段比较长的剧情内容', '第6轮']);
  assert.strictEqual(conv.messages.length, 12, '原始消息全部保留');
  const st = reg.convData(conv, 'rpcache').state;
  assert.strictEqual(R.activeSummary(st).coveredIds.length, 6);
  assert.deepStrictEqual(reg.messageState(conv.messages[0], settings, conv, host), { dim: true, label: '' });
  assert.ok(reg.messageState(conv.messages[5], settings, conv, host).label.includes('#001'));
  const logs = JSON.parse(host.raw['rplog_c2.json']);
  const last = logs[logs.length - 1];
  assert.strictEqual(last.summary_happened, true); assert.strictEqual(last.summary_no, 1);
  assert.strictEqual(last.diag.summary, 'CHANGED');
  assert.ok(last.reason.includes('摘要'));
  assert.strictEqual(r.bot.rpCache.summaryNo, 1);
  // 下一轮：摘要冻结，不再调用模型；前缀稳定
  const r2 = await send(conv, settings, host, '第7轮');
  assert.strictEqual(host.calls.length, 1);
  assert.strictEqual(r2.body.messages[0].content, r.body.messages[0].content);
  const l2 = JSON.parse(host.raw['rplog_c2.json']).pop();
  assert.strictEqual(l2.diag.summary, 'SAME'); assert.strictEqual(l2.diag.history, 'APPEND');
});

test('摘要失败时不会静默卡住：提示并回退，请求照常发送', async () => {
  const settings = {}; const conv = { id: 'c3', systemPrompt: '', messages: [] };
  reg.setForConversation(conv, 'rpcache', true);
  const d = reg.convData(conv, 'rpcache'); d.state = R.normalizeState(null);
  d.state.settings.summary = { enabled: true, trigger_tokens: 10, min_new_turns: 1, keep_recent_turns: 1 };
  const host = mkHost(conv, settings, '随便聊聊');
  await send(conv, settings, host, '第一轮内容');
  await send(conv, settings, host, '第二轮内容');
  assert.strictEqual(host.calls.length, 0, '只有 1 轮历史且全部保留时不摘要');
  const r = await send(conv, settings, host, '第三轮内容');
  assert.strictEqual(host.calls.length, 1);
  assert.ok(host.toasts.some(t => t.includes('章节摘要生成失败')));
  assert.strictEqual(r.body.messages.length, 5, '摘要失败时照常发送完整历史');
  assert.strictEqual(JSON.parse(host.raw['rplog_c3.json']).pop().summary_error.includes('格式不完整'), true);
});

test('切换提示词模板：显式更新 L1，下一轮日志 static=CHANGED 且原因写明模板，之后恢复 SAME', async () => {
  const settings = {}; const conv = { id: 'c-tpl', systemPrompt: '旧系统提示词', messages: [] };
  reg.setForConversation(conv, 'rpcache', true);
  const host = mkHost(conv, settings, '');
  await send(conv, settings, host, '第一轮');
  const d = reg.convData(conv, 'rpcache');
  const v0 = d.state.staticVersion;
  // 宿主（app.js setConvSystem）切换模板时调用的路径
  conv.systemPrompt = '简洁回答模板内容';
  const r = R.explicitBaseUpdate(d.state, conv.systemPrompt, { kind: 'template', name: '简洁回答' }, 5);
  assert.ok(r.changed); d.state = r.state;
  assert.strictEqual(d.state.staticVersion, v0 + 1);
  const r2 = await send(conv, settings, host, '第二轮');
  assert.strictEqual(r2.body.messages[0].content, '简洁回答模板内容');
  let logs = JSON.parse(host.raw['rplog_c-tpl.json']);
  assert.strictEqual(logs[1].diag.static, 'CHANGED');
  assert.strictEqual(logs[1].reason, '切换了提示词模板「简洁回答」，L1 固定前缀改变');
  assert.strictEqual(logs[1].static_cause.name, '简洁回答');
  assert.strictEqual(d.state.pendingStaticCause, null, '成功后清掉原因');
  assert.strictEqual(d.state.staticVersion, v0 + 1, '发送时不重复升级');
  await send(conv, settings, host, '第三轮');
  logs = JSON.parse(host.raw['rplog_c-tpl.json']);
  assert.strictEqual(logs[2].diag.static, 'SAME');
});

// v0.3.4：回复版本。请求必须与「只有选中版本」时逐字节一致
const V = require('../app/src/main/assets/www/versions.js');
async function bodyOf(conv) {
  const settings = {}; const host = mkHost(conv, settings, '');
  const last = conv.messages[conv.messages.length - 1];
  const ctx = { conv, provider: ds, model: 'deepseek-flash', systemPrompt: conv.systemPrompt, settings, lastUser: last, meta: {}, opts: { stream: true },
    messages: conv.messages.map(m => ({ role: m.role, content: m.content, _src: m })), setStatus() {}, setCancel() {} };
  const out = await reg.runBeforeRequest(ctx, host);
  return P.buildChatRequest(ds, out.model, out.messages, out.systemPrompt, out.opts).body;
}
function rpConvWith(msgs, id) {
  const c = { id, systemPrompt: '你是RP助手', messages: msgs };
  reg.setForConversation(c, 'rpcache', true);
  reg.convData(c, 'rpcache').state = R.setBlock(R.normalizeState(null), 'state', 'HP: 80', 1).state;
  return c;
}
test('RP + 版本：请求与只有选中版本时逐字节一致（含切换后、用户消息分支的冻结原文）', async () => {
  const base = () => [{ id: 'u1', role: 'user', content: '推门', rpSent: '【搜索结果】推门' }, { id: 'a1', role: 'assistant', content: '回复 A' },
    { id: 'u2', role: 'user', content: '拔剑', rpSent: '拔剑' }, { id: 'a2', role: 'assistant', content: '回复 X' }, { id: 'u3', role: 'user', content: '继续' }];
  // 带版本：a1 有 A / B 两个版本，选中 B；a2 有 X / Y，选中 Y
  let msgs = base();
  msgs = V.addVersion(msgs, 3, { content: '回复 Y', usage: { prompt: 1 } }); msgs.push({ id: 'u3', role: 'user', content: '继续' });
  const withVer = await bodyOf(rpConvWith(msgs.slice(), 'cv1'));
  const plain = base(); plain[3].content = '回复 Y';
  assert.strictEqual(withVer, await bodyOf(rpConvWith(plain, 'cv2')));
  assert.ok(!withVer.includes('回复 X') && !withVer.includes('versions'));
  // 较早回复分支：a1 选 B（其后对话不同）
  let m2 = V.addVersion(base(), 1, { content: '回复 B' }); m2.push({ id: 'u7', role: 'user', content: 'B 线的问题' });
  const b1 = await bodyOf(rpConvWith(m2, 'cv3'));
  assert.strictEqual(b1, await bodyOf(rpConvWith([{ id: 'u1', role: 'user', content: '推门', rpSent: '【搜索结果】推门' }, { id: 'a1', role: 'assistant', content: '回复 B' }, { id: 'u7', role: 'user', content: 'B 线的问题' }], 'cv4')));
  // 切回 A：恢复原分支（含冻结原文）
  m2 = V.select(m2, 1, 0);
  assert.strictEqual(await bodyOf(rpConvWith(m2, 'cv5')), await bodyOf(rpConvWith(base(), 'cv6')));
});

test('RP + 版本：切换较早回复 → 下一轮 History CHANGED，原因写明「切换了较早回复的版本」', async () => {
  const settings = {}; const conv = { id: 'c-ver', systemPrompt: 'S', messages: [] };
  reg.setForConversation(conv, 'rpcache', true);
  const host = mkHost(conv, settings, '');
  await send(conv, settings, host, '一'); await send(conv, settings, host, '二');
  // 在第一条回复上新增版本并选中（模拟重新生成后切换），保留后续消息为另一分支
  let msgs = V.addVersion(conv.messages, 1, { content: '回复：一（第二版）' });
  msgs = V.select(msgs, 1, 0); // 回到原版本：历史不变
  conv.messages = msgs;
  await send(conv, settings, host, '三');
  let logs = JSON.parse(host.raw['rplog_c-ver.json']);
  assert.strictEqual(logs[2].diag.history, 'APPEND', '切回原版本 = 历史不变');
  conv.messages = V.select(conv.messages, 1, 1);
  const d = reg.convData(conv, 'rpcache'); d.state = R.markHistoryCause(d.state, { kind: 'version' }, 9);
  assert.deepStrictEqual(conv.messages.map(m => m.content), ['一', '回复：一（第二版）']);
  await send(conv, settings, host, '四');
  logs = JSON.parse(host.raw['rplog_c-ver.json']);
  assert.strictEqual(logs[3].diag.history, 'CHANGED');
  assert.strictEqual(logs[3].reason, '切换了较早回复的版本，对话历史改变');
  assert.strictEqual(logs[3].history_cause.kind, 'version');
  assert.strictEqual(reg.convData(conv, 'rpcache').state.pendingHistoryCause, null, '成功后清除');
});

// v0.7.4：首条消息自动提取设定
const LONG_RP = '我们来角色扮演。世界观：赛博朋克都市新港，霓虹灯下的雨夜永不停歇，巨型企业控制着一切。你扮演艾琳，一名冷静而寡言的黑客，曾经在企业里工作，后来叛逃。我扮演一名刚到新港的雇佣兵，我们在酒吧第一次见面。';
test('v0.7.4 首条消息自动提取：只填空白块，失败不影响', async () => {
  const conv = { id: 'cx', model: 'deepseek-flash', systemPrompt: '', messages: [] };
  const settings = {};
  reg.setForConversation(conv, 'rpcache', true);
  const reply = JSON.stringify({ world: '赛博朋克都市 新港', character: '- 名字：艾琳\n- 性格：冷静', rules: '', memory: '无', state: '雨夜，酒吧' });
  const host = mkHost(conv, settings, reply);
  const R0 = R.normalizeState(null);
  conv.plugins.rpcache.state = R.setBlock(R0, 'character', '用户已写的角色卡', 1).state;
  await send(conv, settings, host, LONG_RP);
  const pl = reg.get ? reg.get('rpcache') : reg.all().find(p => p.id === 'rpcache');
  await pl._lastExtract;
  const st = conv.plugins.rpcache.state;
  assert.strictEqual(R.getBlock(st, 'character').content, '用户已写的角色卡');
  assert.strictEqual(R.getBlock(st, 'world').content, '赛博朋克都市 新港');
  assert.strictEqual(R.getBlock(st, 'state').content, '雨夜，酒吧');
  assert.strictEqual(R.getBlock(st, 'memory').content, '');
  assert.ok(host.toasts.some(t => t.includes('已根据首条消息填充 RP 设定')));
  const n = host.calls.length;
  await send(conv, settings, host, '继续');
  assert.strictEqual(host.calls.length, n, '第二轮不再提取');
});
test('v0.7.4 parseExtract 容错 / 可关闭', () => {
  assert.strictEqual(R.parseExtract('not json'), null);
  assert.deepStrictEqual(R.parseExtract('```json\n{"world":["a","b"],"rules":"无"}\n```'), { world: '- a\n- b' });
});

// v0.7.5
const getPl = () => (reg.get ? reg.get('rpcache') : reg.all().find(p => p.id === 'rpcache'));
const EX = JSON.stringify({ world: '新港', character: '艾琳', state: '雨夜' });
function mkConv(id) { const c = { id, model: 'deepseek-flash', systemPrompt: '', messages: [] }; reg.setForConversation(c, 'rpcache', true); return c; }
test('v0.7.5 自动触发门槛：短消息 / 不像设定不提取，手动可提取', async () => {
  assert.strictEqual(R.shouldAutoExtract('你好，今天天气怎么样？'), false);
  assert.strictEqual(R.shouldAutoExtract('x'.repeat(100)), false, '够长但没有设定关键词');
  assert.strictEqual(R.shouldAutoExtract(LONG_RP), true);
  const conv = mkConv('c75a'); const host = mkHost(conv, {}, EX);
  getPl()._lastExtract = null;
  await send(conv, {}, host, '扮演一个骑士，背景是中世纪。');
  assert.strictEqual(getPl()._lastExtract, null); assert.strictEqual(host.calls.length, 0);
  const filled = await getPl()._internals.autoExtract(host, conv, '扮演一个骑士，背景是中世纪。', true);
  assert.deepStrictEqual(filled.sort(), ['character', 'state', 'world']);
});
test('v0.7.5 与首条回复并行、JSON 模式 + 60 秒超时、固定对话，撤销恢复整批', async () => {
  const conv = mkConv('c75b'); const host = mkHost(conv, {}, EX);
  const r = await send(conv, {}, host, LONG_RP);
  assert.ok(getPl()._lastExtract, '在请求发出前就已开始');
  await getPl()._lastExtract;
  const o = host.calls[host.calls.length - 1].o;
  assert.strictEqual(o.jsonMode, true); assert.strictEqual(o.timeoutMs, 60000); assert.strictEqual(o.conv, conv);
  let st = conv.plugins.rpcache.state;
  assert.strictEqual(R.getBlock(st, 'world').content, '新港');
  assert.deepStrictEqual(host.toasts.actions.map(a => a.label), ['查看', '撤销']);
  // 用户改了 character 后撤销：character 保留，其余恢复为空
  conv.plugins.rpcache.state = R.setBlock(st, 'character', '我改过的', 5).state;
  host.toasts.actions[1].onClick();
  st = conv.plugins.rpcache.state;
  assert.strictEqual(R.getBlock(st, 'world').content, ''); assert.strictEqual(R.getBlock(st, 'state').content, '');
  assert.strictEqual(R.getBlock(st, 'character').content, '我改过的');
  assert.strictEqual(st.autoExtract.status, 'undone');
  const n = host.calls.length; await send(conv, {}, host, '继续'); assert.strictEqual(host.calls.length, n, '撤销后不会再次自动提取');
});
test('v0.7.5 解析失败重试一次；两次失败给出明确状态；跳过正在编辑的块', async () => {
  const conv = mkConv('c75c'); let k = 0;
  const host = mkHost(conv, {}, () => (++k === 1 ? '抱歉我不会' : EX));
  getPl()._editing = { conv, id: 'world' };
  const filled = await getPl()._internals.autoExtract(host, conv, LONG_RP, false);
  getPl()._editing = null;
  assert.strictEqual(host.calls.length, 2, '重试一次');
  assert.ok(!filled.includes('world'), '正在编辑的块不填'); assert.deepStrictEqual(conv.plugins.rpcache.state.autoExtract.skipped, ['world']);
  const conv2 = mkConv('c75d'); const h2 = mkHost(conv2, {}, 'nope');
  assert.strictEqual(await getPl()._internals.autoExtract(h2, conv2, LONG_RP, false), null);
  assert.strictEqual(h2.calls.length, 2);
  assert.match(conv2.plugins.rpcache.state.autoExtract.error, /两次/);
  const conv3 = mkConv('c75e'); const h3 = mkHost(conv3, {}, () => { throw new Error('请求超时'); });
  await getPl()._internals.autoExtract(h3, conv3, LONG_RP, false);
  assert.match(conv3.plugins.rpcache.state.autoExtract.error, /60 秒/);
});
test('v0.7.5 切换对话：提取结果写回发起的对话', async () => {
  const a = mkConv('c75f'), b = mkConv('c75g'); let cur = a; let release;
  const host = mkHost(a, {}, () => new Promise(r => { release = () => r(EX); }));
  host.conv = () => cur;
  const pr = getPl()._internals.autoExtract(host, a, LONG_RP, false);
  cur = b; release(); await pr;
  assert.strictEqual(R.getBlock(a.plugins.rpcache.state, 'world').content, '新港');
  assert.ok(!b.plugins.rpcache.state || !b.plugins.rpcache.state.autoExtract);
});
test('v0.7.5 全局 / 本对话开关关闭时不自动提取', async () => {
  const conv = mkConv('c75h'); const settings = {}; const host = mkHost(conv, settings, EX);
  const st0 = R.normalizeState(null); st0.settings.auto_extract = false; conv.plugins.rpcache.state = st0;
  getPl()._lastExtract = null; await send(conv, settings, host, LONG_RP);
  assert.strictEqual(getPl()._lastExtract, null);
  const c2 = mkConv('c75i'); const s2 = { plugins: { rpcache: { auto_extract: false } } };
  getPl()._lastExtract = null; await send(c2, s2, mkHost(c2, s2, EX), LONG_RP);
  assert.strictEqual(getPl()._lastExtract, null, '全局关闭');
});
test('v0.7.5 日志里的完整 prompt 只保留最近 20 条', () => {
  let logs = []; for (let i = 0; i < 30; i++) logs = R.appendLog(logs, { i, prompt: 'p' + i });
  assert.strictEqual(logs.filter(e => e.prompt).length, 20); assert.ok(!logs[0].prompt); assert.strictEqual(logs[29].prompt, 'p29');
});
test('v0.7.5 JSON 模式只对支持的服务商生效', () => {
  const body = JSON.parse(P.buildChatRequest(ds, 'deepseek-chat', [{ role: 'user', content: 'json' }], '', { stream: false, jsonMode: true }).body);
  assert.deepStrictEqual(body.response_format, { type: 'json_object' });
  const other = Object.assign({}, ds, { presetId: 'custom', baseUrl: 'https://example.com/v1' });
  assert.ok(!JSON.parse(P.buildChatRequest(other, 'm', [{ role: 'user', content: 'x' }], '', { stream: false, jsonMode: true }).body).response_format);
});

test('v0.7.6 从回复导入分段设定：只填空白块，可撤销', () => {
  const conv = mkConv('c76a'); const host = mkHost(conv, {}, '');
  conv.plugins.rpcache.state = R.setBlock(R.normalizeState(null), 'world', '已有世界观', 1).state;
  const filled = getPl()._internals.importSections(host, conv, '【世界观】新世界\n【角色卡】莉亚\n【写作风格】冷峻');
  assert.deepStrictEqual(filled.sort(), ['character', 'style']);
  assert.strictEqual(R.getBlock(conv.plugins.rpcache.state, 'world').content, '已有世界观');
  host.toasts.actions[0].onClick();
  assert.strictEqual(R.getBlock(conv.plugins.rpcache.state, 'character').content, '');
});
