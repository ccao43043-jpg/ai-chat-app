// DeepSeek RP 缓存优化器 V2 回归测试：多轮前缀稳定性模拟（不调用真实 API）、编辑、重新生成、状态 / 记忆增量、
// 只追加章节与合并、旧数据迁移、摘要最小间隔、服务商适用性（Claude cache_control）、Token 校准、价格 / 高峰配置、界面估算对齐
const test = require('node:test');
const assert = require('node:assert');
const Plugins = require('../app/src/main/assets/www/plugins.js');
const R = require('../app/src/main/assets/www/rpcache.js');
global.window = global.window || {};
Object.assign(global.window, { Plugins, RPCache: R });
if (!Plugins.registry.get('rpcache')) require('../app/src/main/assets/www/rp-plugin.js');
const P = require('../app/src/main/assets/www/providers.js');
const reg = Plugins.registry;
const preset = id => Object.assign({ apiKey: 'sk', id }, P.PRESETS.find(p => p.presetId === id));
const DS = preset('deepseek');
const SUMMARY = 'FACTS:\n- 摘要\n\nCHARACTER_KNOWLEDGE:\n- 无\n\nPLAYER_KNOWLEDGE:\n- 无\n\nSECRET:\n- 无\n\nUNRESOLVED:\n- 无';

function mkHost(conv, settings, provider, reply) {
  const store = {}; const calls = []; const toasts = [];
  return { calls, toasts, raw: store,
    settings: () => settings, saveSettings() {}, conv: () => conv, saveConv() {}, refresh() {}, toast: t => toasts.push(t), esc: s => s,
    provider: () => provider,
    store: { get: (k, d) => (k in store ? JSON.parse(store[k]) : d), set: (k, v) => { store[k] = JSON.stringify(v); } },
    openPanel() {}, dialog: async () => true,
    callModel: async (prompt, o) => { calls.push({ prompt, o }); return typeof reply === 'function' ? reply(prompt, calls.length) : (reply == null ? SUMMARY : reply); } };
}
/** 一个完整的模拟会话：发送 → 插件 → 构建请求体 → 模拟回复与 usage（按「与上一请求的公共前缀」估算命中） */
function session(o) {
  o = o || {};
  const provider = o.provider || DS;
  const settings = {}; const conv = { id: o.id || 'c' + Math.random().toString(36).slice(2), systemPrompt: o.system == null ? '你是RP助手' : o.system, model: o.model || 'deepseek-flash', messages: [] };
  if (o.rp !== false) reg.setForConversation(conv, 'rpcache', true);
  const host = mkHost(conv, settings, provider, o.reply);
  let prevBody = null; const turns = [];
  async function send(text, extra) {
    extra = extra || {};
    let user = extra.regen ? conv.messages.filter(m => m.role === 'user').pop() : { id: 'u' + conv.messages.length, role: 'user', content: text };
    if (extra.regen) { conv.messages.pop(); if (extra.fresh != null) user.content = extra.fresh; } else conv.messages.push(user);
    const ctx = { conv, provider, model: conv.model, systemPrompt: conv.systemPrompt, settings, lastUser: user, meta: {}, opts: { stream: true },
      messages: conv.messages.map(m => ({ role: m.role, content: m.content, _src: m })), setStatus() {}, setCancel() {} };
    const out = await reg.runBeforeRequest(ctx, host);
    const req = P.buildChatRequest(provider, out.model, out.messages, out.systemPrompt, out.opts);
    const body = req.body;
    let lcp = 0; if (prevBody) { const n = Math.min(prevBody.length, body.length); while (lcp < n && prevBody.charCodeAt(lcp) === body.charCodeAt(lcp)) lcp++; }
    const bot = { id: 'a' + conv.messages.length, role: 'assistant', content: (o.replyText || '回复：') + text + (o.longReply ? '描写'.repeat(o.longReply) : '') };
    conv.messages.push(bot);
    const prompt = Math.round(body.length * 0.6);
    const hit = Math.round(lcp * 0.6);
    reg.runAfterResponse(out, { ok: true, bot, usage: { prompt, hit, miss: prompt - hit, completion: 20, cacheSupported: true } }, host);
    const t = { body, json: JSON.parse(body), lcp, prevLen: prevBody ? prevBody.length : 0, ratio: prevBody ? lcp / prevBody.length : null, out, bot, req };
    turns.push(t); prevBody = body;
    return t;
  }
  return { conv, settings, host, send, turns, data: () => reg.convData(conv, 'rpcache') };
}
const st0 = s => s.data().state;

test('多轮模拟：状态每轮变化时，公共前缀覆盖上一轮请求的「上一条输入」之前的全部内容（V2 输入在前）', async () => {
  const s = session();
  s.data().state = R.setBlock(R.setBlock(R.normalizeState(null), 'character', '角色卡'.repeat(100), 1).state, 'state', 'HP: 100', 1).state;
  for (let i = 1; i <= 12; i++) {
    s.data().state = R.setBlock(s.data().state, 'state', 'HP: ' + (100 - i) + '\nTime: 21:' + (10 + i), i).state;
    const t = await s.send('第' + i + '轮行动 ' + '推门'.repeat(40));
    if (i > 1) {
      const prevInput = '第' + (i - 1) + '轮行动 ' + '推门'.repeat(40);
      const prevJsonEnd = t.prevLen;
      // 公共前缀至少延伸到上一轮输入文本的末尾
      const prevBody = s.turns[i - 2].body;
      const endOfPrevInput = prevBody.lastIndexOf(prevInput) + prevInput.length;
      assert.ok(t.lcp >= endOfPrevInput, '第 ' + i + ' 轮：lcp ' + t.lcp + ' ≥ ' + endOfPrevInput);
      assert.ok(t.ratio > 0.9 || i < 4, '前缀占比 ' + t.ratio.toFixed(2));
      assert.ok(prevJsonEnd - t.lcp < 120, '只损失上一轮的状态尾巴（约 40 字符的状态 + JSON 收尾）：' + (prevJsonEnd - t.lcp));
      // 历史里不残留旧状态
      t.json.messages.slice(1, -1).forEach(m => assert.ok(!String(m.content).includes('[CURRENT_STATE]')));
    }
  }
});

test('编辑较早的消息：前缀在被编辑处断开，之后重新稳定；rpSent 作废', async () => {
  const s = session();
  for (let i = 1; i <= 4; i++) await s.send('第' + i + '轮');
  const u1 = s.conv.messages[2];
  assert.strictEqual(u1.rpSent, '第2轮');
  u1.content = '第2轮（改）'; delete u1.rpSent; // app.js editMsg 的行为
  const t = await s.send('第5轮');
  assert.ok(t.json.messages.some(m => m.content === '第2轮（改）'));
  assert.ok(t.lcp <= s.turns[3].body.indexOf('第2轮') + '第2轮'.length, '在被编辑处断开');
  const t2 = await s.send('第6轮');
  assert.ok(t2.ratio > 0.8, '下一轮恢复稳定');
  assert.strictEqual(t2.out.meta.rp.diag.history, 'APPEND');
});

test('重新生成：默认沿用冻结的原文（即使宿主重新联网搜索），开启刷新才更新', async () => {
  const s = session();
  await s.send('【搜索 A】推门');
  const before = s.turns[0].body;
  const r = await s.send(null, { regen: true, fresh: '【搜索 B】推门' });
  assert.strictEqual(r.body, before, '重新生成：请求逐字节相同');
  assert.ok(s.host.toasts.some(t => t.includes('沿用这条消息首次发送的原文')));
  s.data().state.settings.refresh_on_regen = true;
  const r2 = await s.send(null, { regen: true, fresh: '【搜索 C】推门' });
  assert.ok(r2.body.includes('【搜索 C】推门'));
  assert.strictEqual(s.conv.messages[0].rpSent, '【搜索 C】推门');
});

test('只追加章节：生成章节那一轮仍命中 固定设定 + 长期记忆 + 之前全部章节；合并只在超过上限时发生', async () => {
  const s = session({ longReply: 30 });
  let st = R.setBlock(R.normalizeState(null), 'character', '角色卡'.repeat(150), 1).state;
  st = R.setBlock(st, 'memory', '记忆'.repeat(50), 1).state;
  st.settings.summary = Object.assign({}, st.settings.summary, { trigger_tokens: 600, min_new_turns: 3, keep_recent_turns: 3, min_interval_turns: 0, chapter_cap_tokens: 1000000 });
  st.settings.auto_extract = false; // 本用例只统计摘要调用
  s.data().state = st;
  let chapterTurns = [];
  for (let i = 1; i <= 30; i++) {
    const n = R.chaptersOf(st0(s)).length;
    const t = await s.send('第' + i + '轮 ' + '剧情'.repeat(30));
    if (R.chaptersOf(st0(s)).length > n) chapterTurns.push({ i, t, before: n });
  }
  assert.ok(chapterTurns.length >= 3, '生成了多个章节：' + chapterTurns.length);
  assert.strictEqual(s.host.calls.length, chapterTurns.length);
  chapterTurns.forEach(({ i, t, before }) => {
    const prev = s.turns[i - 2].json.messages[0].content; // 上一轮 system
    const cur = t.json.messages[0].content;
    assert.ok(cur.startsWith(prev), '第 ' + i + ' 轮：新 system 以旧 system 为前缀（之前 ' + before + ' 章逐字保留）');
    assert.ok(t.lcp >= s.turns[i - 2].body.indexOf(prev) + prev.length, '公共前缀覆盖旧 system');
    if (before) assert.ok(s.host.calls[s.host.calls.indexOf(s.host.calls.find(c => c.prompt.includes('#00' + before)))], '提示词带之前章节作为只读参考');
  });
  // 章节合计超过上限 → 下一次摘要改为合并
  const st2 = st0(s); st2.settings.summary.chapter_cap_tokens = 1000; // 允许的最小值
  const big = R.chaptersOf(st2).length;
  st2.chapters = st2.chapters.map(c => Object.assign({}, c, { content: c.content + '\n- ' + '补充'.repeat(400) }));
  for (let i = 0; i < 12 && R.chaptersOf(st0(s)).length !== 1; i++) await s.send('继续 ' + '剧情'.repeat(30));
  const fin = st0(s);
  assert.strictEqual(R.chaptersOf(fin).length, 1, '合并为一章');
  assert.deepStrictEqual(fin.chapters[0].mergedFrom.length, big);
  assert.ok(fin.archive.length >= big);
  assert.ok(s.host.calls.some(c => c.prompt.includes('合并压缩')));
  const logs = JSON.parse(s.host.raw['rplog_' + s.conv.id + '.json']);
  assert.ok(logs.some(e => e.summary_merged && e.reason.includes('合并')));
  assert.ok(logs.some(e => e.summary_cost && e.summary_cost.callIn > 0), '记录了额外花费估算');
  // 撤销合并章：恢复原章节
  const r = R.removeLastChapter(fin, 1);
  assert.strictEqual(R.chaptersOf(r.state).length, big);
});

test('摘要诊断：追加章节为 APPEND（之前章节不变），编辑章节为 CHANGED', () => {
  let st = R.normalizeState(null);
  st = R.addChapter(st, { content: 'FACTS:\n- 一', coveredIds: ['u1'] });
  const items = [{ id: 'u1', role: 'user', content: 'a' }, { id: 'a1', role: 'assistant', content: 'b' }, { id: 'u2', role: 'user', content: 'c' }, { id: 'a2', role: 'assistant', content: 'd' }, { id: 'u3', role: 'user', content: 'e' }];
  const p1 = R.plan(st, '', items); const e1 = R.makeLogEntry({ fp: R.fingerprints(p1, ''), at: 1 });
  const st2 = R.addChapter(st, { content: 'FACTS:\n- 二', coveredIds: ['a1', 'u2'] });
  const p2 = R.plan(st2, '', items);
  assert.strictEqual(R.diagnose(e1, R.fingerprints(p2, ''), p2.hist).summary, 'APPEND');
  const st3 = R.editChapter(st, 1, 'FACTS:\n- 一（改）', 2).state;
  const p3 = R.plan(st3, '', items);
  assert.strictEqual(R.diagnose(e1, R.fingerprints(p3, ''), p3.hist).summary, 'CHANGED');
});

test('旧版数据迁移：v0.3.x 的单份合并摘要 → 章节 #001，内容 / 覆盖范围不变，下一章为 #002', () => {
  const old = { blocks: [{ id: 'memory', version: 1, content: 'M', history: [] }], summaries: [
    { no: 1, content: 'FACTS:\n- 旧一', coveredIds: ['u1', 'a1'], at: 1 },
    { no: 2, content: 'FACTS:\n- 旧一\n- 旧二', coveredIds: ['u1', 'a1', 'u2', 'a2'], at: 2, source: 'auto' }] };
  const st = R.normalizeState(old);
  assert.strictEqual(st.chapters.length, 1);
  assert.strictEqual(st.chapters[0].no, 1); assert.strictEqual(st.chapters[0].source, 'migrated'); assert.strictEqual(st.chapters[0].migratedFrom, 2);
  assert.strictEqual(st.chapters[0].content, 'FACTS:\n- 旧一\n- 旧二');
  assert.deepStrictEqual(R.coveredIds(st), ['u1', 'a1', 'u2', 'a2']);
  assert.strictEqual(R.summaryText(st), '[CHAPTER_SUMMARY #001]\nFACTS:\n- 旧一\n- 旧二');
  assert.strictEqual(st.summaries.length, 2, '旧快照原样保留');
  assert.strictEqual(R.addChapter(st, { content: 'x' }).chapters[1].no, 2);
  // 已迁移的数据再次规范化不会重复迁移
  const again = R.normalizeState(JSON.parse(JSON.stringify(Object.assign({}, st, { chapters: [] }))));
  assert.strictEqual(again.chapters.length, 0, 'chapters 字段存在（即使为空）就不再迁移');
  assert.strictEqual(R.getBlock(st, 'delta').content, '', '新增的记忆增量块默认为空');
});

test('记忆增量：放在历史之后，修改不破坏前缀；合并进长期记忆会重建（并给出代价估算）', async () => {
  const s = session();
  s.data().state = R.setBlock(R.setBlock(R.normalizeState(null), 'memory', '稳定事实', 1).state, 'state', 'HP 1', 1).state;
  await s.send('一'); await s.send('二');
  s.data().state = R.setBlock(s.data().state, 'delta', '新事实：张燕知道了秘密', 3).state;
  const t = await s.send('三');
  const last = t.json.messages[t.json.messages.length - 1].content;
  assert.strictEqual(last, '三\n\n[MEMORY_UPDATE]\n新事实：张燕知道了秘密\n\n[CURRENT_STATE]\nHP 1', '顺序：输入 → 增量 → 状态');
  assert.ok(!t.json.messages[0].content.includes('新事实'), '增量不在 system 里');
  const pb = s.turns[1].body; assert.ok(t.lcp >= pb.lastIndexOf('二') + 1, '修改增量后，公共前缀仍覆盖到上一轮输入末尾');
  assert.strictEqual(t.out.meta.rp.diag.delta, 'CHANGED'); assert.strictEqual(t.out.meta.rp.diag.memory, 'SAME');
  const p = R.plan(s.data().state, '你是RP助手', s.conv.messages.map(m => ({ id: m.id, role: m.role, content: m.rpSent || m.content })));
  const c = R.mergeDeltaCost(p, { model: 'deepseek-flash', mode: 'peak' });
  assert.ok(c.rebuild > 0 && c.usd > 0);
  const r = R.mergeDelta(s.data().state, 9);
  assert.ok(r.changed);
  assert.strictEqual(R.getBlock(r.state, 'memory').content, '稳定事实\n新事实：张燕知道了秘密');
  assert.strictEqual(R.getBlock(r.state, 'delta').content, '');
  s.data().state = r.state;
  const t2 = await s.send('四');
  assert.strictEqual(t2.out.meta.rp.diag.memory, 'CHANGED');
  assert.ok(t2.json.messages[0].content.includes('新事实'));
});

test('摘要最小间隔：达到阈值但距上一章不足 N 轮时不摘要；超预算仍立即摘要', () => {
  let st = R.normalizeState(null);
  st.settings.summary = Object.assign({}, st.settings.summary, { trigger_tokens: 50, min_new_turns: 1, keep_recent_turns: 2, min_interval_turns: 5 });
  const conv = n => { const o = []; for (let i = 1; i <= n; i++) { o.push({ id: 'u' + i, role: 'user', content: '内容'.repeat(30) + i }); if (i < n) o.push({ id: 'a' + i, role: 'assistant', content: '回复'.repeat(30) + i }); } return o; };
  let p = R.plan(st, '', conv(6));
  assert.ok(p.needSummary, '没有章节时不受间隔限制');
  st = R.addChapter(st, { content: 'x', coveredIds: p.batch.map(m => m.id), atRound: 6 });
  p = R.plan(st, '', conv(9));
  assert.ok(!p.needSummary); assert.strictEqual(p.summaryBlocked, 'interval'); assert.strictEqual(p.sinceLast, 3);
  p = R.plan(st, '', conv(11));
  assert.ok(p.needSummary, '间隔达到后恢复');
  const st2 = Object.assign({}, st, { settings: Object.assign({}, st.settings, { max_context: 1000, output_reserve: 0, safety_margin: 0 }) });
  const big = conv(9).map(m => Object.assign({}, m, { content: m.content + '很长'.repeat(200) }));
  p = R.plan(st2, '', big);
  assert.ok(p.needSummary); assert.strictEqual(p.summaryReason, 'budget');
});

test('服务商适用性：非 DeepSeek 对话默认逐字节不变（即使在对话里开启了插件）', async () => {
  for (const id of ['openai', 'anthropic', 'gemini']) {
    const prov = preset(id);
    const model = prov.models[0];
    const on = session({ provider: prov, model }); const off = session({ provider: prov, model, rp: false });
    on.data().state = R.setBlock(R.normalizeState(null), 'state', 'HP 1', 1).state;
    for (const t of ['一', '二', '三']) { await on.send(t); await off.send(t); }
    assert.strictEqual(on.turns[2].body, off.turns[2].body, id + '：请求与未开启插件时逐字节相同');
    assert.strictEqual(on.turns[2].out.meta.rp.skipped, true);
    assert.strictEqual(on.conv.messages[0].rpSent, undefined, id + '：不冻结用户消息');
    assert.strictEqual(on.host.raw['rplog_' + on.conv.id + '.json'], undefined, '不记录日志');
    const hb = reg.headerBadges(on.settings, on.conv, on.host);
    assert.deepStrictEqual(hb, [], id + '：不适用时顶栏不显示 RP 徽章');
    assert.strictEqual(reg.messageState(on.conv.messages[0], on.settings, on.conv, on.host), null);
  }
  // 自定义 OpenAI 兼容服务商：地址或模型名含 deepseek 即适用
  assert.ok(R.isApplicable({ type: 'openai', baseUrl: 'https://api.deepseek.com/v1' }, 'x'));
  assert.ok(R.isApplicable({ type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }, 'deepseek/deepseek-chat'));
  assert.ok(R.isApplicable({ presetId: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1' }, 'deepseek-ai/DeepSeek-V3'));
  assert.ok(!R.isApplicable({ presetId: 'openai', baseUrl: 'https://api.openai.com/v1' }, 'gpt-4o'));
});

test('强制启用于 Claude：system 与稳定历史末尾带 cache_control；DeepSeek 请求不带', async () => {
  const prov = preset('anthropic');
  const s = session({ provider: prov, model: prov.models[0] });
  s.data().state = R.setBlock(R.normalizeState(null), 'state', 'HP 1', 1).state;
  s.data().state.settings.force_enable = true;
  await s.send('一'); const t = await s.send('二');
  const b = t.json;
  assert.ok(Array.isArray(b.system) && b.system[0].cache_control.type === 'ephemeral');
  const marked = b.messages.filter(m => Array.isArray(m.content) && m.content.some(p => p.cache_control));
  assert.strictEqual(marked.length, 1, '只有一个消息断点');
  assert.strictEqual(b.messages.indexOf(marked[0]), b.messages.length - 2, '断点在稳定历史末尾（最后一条用户消息之前）');
  assert.ok(!JSON.stringify(b.messages[b.messages.length - 1]).includes('cache_control'));
  // 顶栏只显示命中率，不再带「强制」字样（请求侧 cache_control 已在上方断言）
  const hbForce = reg.headerBadges(s.settings, s.conv, s.host);
  assert.ok(hbForce.length === 1 && hbForce[0].text.startsWith('命中 ') && !hbForce[0].text.includes('强制'), JSON.stringify(hbForce.map(b => b.text)));
  const d = session(); await d.send('一'); await d.send('二');
  assert.ok(!d.turns[1].body.includes('cache_control'));
  // 强制启用于 OpenAI：照常重排但不加 cache_control
  const o = session({ provider: preset('openai'), model: 'gpt-4o' }); o.data().state = R.normalizeState({ settings: { force_enable: true } });
  await o.send('一'); const ot = await o.send('二');
  assert.ok(!ot.body.includes('cache_control')); assert.ok(!ot.out.meta.rp.skipped);
});

test('Token 估算：中英文 / 数字 / 空白分别计价；按真实用量校准并作用于预算', async () => {
  assert.strictEqual(R.estimateTokens('你好世界'), 3); // 4 × 0.6 = 2.4 → 3
  assert.strictEqual(R.estimateTokens('hello world'), 4); // 10 × 0.3 + 0.1 = 3.1 → 4
  assert.strictEqual(R.estimateTokens('12345'), 3);
  assert.ok(R.estimateTokens('😀😀') >= 3, 'emoji 按码点计');
  let st = R.normalizeState(null);
  st = R.calibrate(st, 1000, 1500); assert.strictEqual(st.calib, 1.15);
  st = R.calibrate(st, 100, 9999); assert.strictEqual(st.calib, 1.15, '估算太小时不校准');
  for (let i = 0; i < 30; i++) st = R.calibrate(st, 1000, 9000);
  assert.ok(st.calib <= 2.5, '系数有上限');
  const items = [{ id: 'u1', role: 'user', content: '内容'.repeat(500) }];
  const a = R.plan(R.normalizeState(null), '', items).tokens.input;
  const b = R.plan(Object.assign(R.normalizeState(null), { calib: 2 }), '', items).tokens.input;
  assert.strictEqual(b, a * 2);
  // 插件：回复后自动校准
  const s = session();
  await s.send('内容'.repeat(400)); await s.send('内容'.repeat(400));
  assert.ok(st0(s).calibN >= 1); assert.notStrictEqual(st0(s).calib, 1);
});

test('价格与高峰时段可配置：关键词匹配（越长越优先）、旧配置兼容、自定义时段 / 时区 / 非高峰倍数', () => {
  const pr = R.DEFAULT_PRICES;
  assert.strictEqual(R.priceFor('deepseek-v4-pro', pr), pr['deepseek-v4-pro']);
  assert.strictEqual(R.priceFor('deepseek-flash', pr), pr['deepseek-flash']);
  assert.strictEqual(R.priceFor('deepseek-chat', pr), pr['deepseek-flash']);
  assert.strictEqual(R.priceFor('gpt-4o', pr), null);
  const custom = Object.assign({}, pr, { mine: { hit: 1, miss: 2, out: 3, match: 'kimi,moonshot' } });
  assert.strictEqual(R.priceFor('moonshot-v1', custom).miss, 2);
  const legacy = { 'deepseek-flash': { hit: 0.1, miss: 0.2, out: 0.3 }, 'deepseek-v4-pro': { hit: 1, miss: 2, out: 3 } };
  assert.strictEqual(R.priceFor('deepseek-reasoner-pro', legacy).miss, 2, '旧配置（无 match）沿用 V1 规则');
  // 2026-10-19 是周一；北京时间 10:00 = UTC 02:00
  const mon10 = Date.UTC(2026, 9, 19, 2, 0); const mon13 = Date.UTC(2026, 9, 19, 5, 0); const sat10 = Date.UTC(2026, 9, 24, 2, 0);
  assert.ok(R.isPeak(mon10)); assert.ok(!R.isPeak(mon13)); assert.ok(!R.isPeak(sat10));
  assert.ok(R.isPeak(sat10, { weekdays: false }));
  assert.ok(R.isPeak(mon13, { windows: '12:00-14:00' }));
  assert.ok(!R.isPeak(mon10, { tz: 0 }), '时区偏移生效');
  assert.strictEqual(R.peakFactor(mon13, 'auto', { off_factor: 0.25 }), 0.25);
  assert.deepStrictEqual(R.parseWindows('9:00-12:00, 14-18'), [[540, 720], [840, 1080]]);
  const e = { model: 'deepseek-flash', supported: true, timestamp: mon13, prompt_tokens: 1e6, cache_hit_tokens: 1e6, cache_miss_tokens: 0, completion_tokens: 0 };
  assert.ok(Math.abs(R.costOf(e, pr, 'auto', { off_factor: 0.5 }).actual - 0.003) < 1e-9);
});

test('摘要代价估算：调用输入 / 输出 / 重建 Token 与美元', () => {
  let st = R.normalizeState(null);
  st.settings.summary = Object.assign({}, st.settings.summary, { trigger_tokens: 50, min_new_turns: 1, keep_recent_turns: 1, min_interval_turns: 0 });
  const items = []; for (let i = 1; i <= 5; i++) { items.push({ id: 'u' + i, role: 'user', content: '内容'.repeat(100) }); items.push({ id: 'a' + i, role: 'assistant', content: '回复'.repeat(100) }); }
  items.push({ id: 'u6', role: 'user', content: '新' });
  const p = R.plan(st, '', items);
  assert.ok(p.needSummary);
  const c = R.summaryCost(p, { model: 'deepseek-flash', mode: 'peak' });
  assert.ok(c.callIn > R.estimateItems(p.batch)); assert.ok(c.callOut >= 300); assert.ok(c.rebuild > 0); assert.ok(c.usd > 0);
  assert.strictEqual(R.summaryCost(p).usd, null, '不知道模型价格时只给 Token');
});

test('界面估算与实际发送对齐：使用宿主 requestItems（文件内容展开、过滤失败 / 进行中的消息）', () => {
  const plugin = reg.get('rpcache');
  const conv = { id: 'cv-ui', model: 'deepseek-flash', systemPrompt: '', messages: [
    { id: 'u1', role: 'user', content: '看文件', rpSent: '【文件内容】看文件' }, { id: 'a1', role: 'assistant', content: '好' },
    { id: 'u2', role: 'user', content: '再看' }, { id: 'a2', role: 'assistant', content: '', error: '失败' }, { id: 'a3', role: 'assistant', content: '', pending: true }] };
  const host = { requestItems: c => c.messages.filter(m => !m.error && !m.imageGen && !m.pending).map(m => ({ role: m.role, content: m.role === 'user' && m.id === 'u2' ? '【文件 2】再看' : m.content, _src: m })) };
  const items = plugin._internals.convItems(conv, host);
  assert.deepStrictEqual(items.map(m => [m.id, m.content]), [['u1', '【文件内容】看文件'], ['a1', '好'], ['u2', '【文件 2】再看']]);
});
