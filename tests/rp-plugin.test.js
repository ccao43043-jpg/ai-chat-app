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
    settings: () => settings, saveSettings() {}, conv: () => conv, saveConv() {}, refresh() {}, toast: t => toasts.push(t), esc: s => s, provider: () => ds,
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
