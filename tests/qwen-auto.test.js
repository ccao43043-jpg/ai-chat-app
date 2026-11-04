// v0.5.0：千问（阿里云百炼）预设 / enable_thinking / cached_tokens / 显式缓存断点，以及 RP 优化器的自动策略（能力识别、预算推导、自适应摘要、自动启用）
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
const QW = preset('qwen'), QI = preset('qwen-intl'), DS = preset('deepseek'), OA = preset('openai');
const OR = preset('openrouter'), SF = preset('siliconflow');
const SUMMARY = "FACTS:\n- 摘要内容：调查继续推进\n\nCHARACTER_KNOWLEDGE:\n- 张燕：只知失踪案\n\nPLAYER_KNOWLEDGE:\n- 玩家已知密道线索\n\nSECRET:\n- 幕后组织未公开\n\nUNRESOLVED:\n- 幕后组织身份\n\nRELATIONSHIPS:\n- 无\n\nOBJECTS:\n- 无\n\nLOCATION:\n- 北境";

// ---------------- 预设与请求 ----------------
test('千问预设：中国 / 国际两个地址，默认模型，流式用量默认开启，识别业务空间专属域名', () => {
  assert.strictEqual(QW.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.strictEqual(QI.baseUrl, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
  ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash', 'qwen-plus', 'qwen-flash', 'qwen3-vl-plus'].forEach(m => { assert.ok(QW.models.includes(m), m); assert.ok(QI.models.includes(m), m); });
  assert.ok(QW.models.includes('qwen-plus-character'));
  assert.ok(QW.vision && QI.vision);
  assert.ok(P.streamUsageEnabled(QW) && P.streamUsageEnabled(QI));
  assert.ok(P.streamUsageEnabled({ type: 'openai', presetId: 'custom', baseUrl: 'https://ws-1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }));
  assert.ok(P.isQwenEndpoint({ baseUrl: 'https://ws-1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }));
  assert.ok(!P.isQwenEndpoint(DS));
  const body = JSON.parse(P.buildChatRequest(QW, 'qwen3.7-plus', [{ role: 'user', content: 'hi' }], '', { stream: true }).body);
  assert.deepStrictEqual(body.stream_options, { include_usage: true });
  assert.strictEqual(body.enable_thinking, undefined, '默认不发送 enable_thinking');
});

test('enable_thinking：服务商设置 / 调用覆盖；非千问服务商绝不发送', () => {
  const on = JSON.parse(P.buildChatRequest(Object.assign({}, QW, { thinking: 'on' }), 'qwen3.7-plus', [{ role: 'user', content: 'x' }], '', {}).body);
  assert.strictEqual(on.enable_thinking, true);
  const off = JSON.parse(P.buildChatRequest(Object.assign({}, QW, { thinking: 'on' }), 'qwen3.7-plus', [{ role: 'user', content: 'x' }], '', { thinking: false }).body);
  assert.strictEqual(off.enable_thinking, false, '摘要调用 thinking:false 覆盖');
  const ds = JSON.parse(P.buildChatRequest(DS, 'deepseek-flash', [{ role: 'user', content: 'x' }], '', { thinking: false }).body);
  assert.ok(!('enable_thinking' in ds));
  // 思考内容：reasoning_content 流式增量
  const d = P.extractDeltas('openai', { choices: [{ delta: { reasoning_content: '想一想' } }] });
  assert.deepStrictEqual(d, [{ kind: 'reasoning', text: '想一想' }]);
});

test('usage：千问 prompt_tokens_details.cached_tokens / cache_creation_input_tokens', () => {
  const u = P.normalizeUsage('openai', { prompt_tokens: 5000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 3000 } });
  assert.deepStrictEqual([u.prompt, u.hit, u.miss, u.cacheSupported], [5000, 3000, 2000, true]);
  const w = P.normalizeUsage('openai', { prompt_tokens: 5000, completion_tokens: 100, prompt_tokens_details: { cache_creation_input_tokens: 4000 } });
  assert.deepStrictEqual([w.hit, w.miss, w.cacheWrite, w.cacheSupported], [0, 5000, 4000, true]);
  const both = P.normalizeUsage('openai', { prompt_tokens: 6000, prompt_tokens_details: { cached_tokens: 4000, cache_creation_input_tokens: 1500 } });
  assert.deepStrictEqual([both.hit, both.cacheWrite], [4000, 1500]);
});

test('显式缓存标记（OpenAI 兼容）：system 与被标记消息改为数组并带 cache_control，图片消息标在最后一段', () => {
  const msgs = [{ role: 'user', content: 'a', _cache: true }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c', images: ['data:image/png;base64,AA'], _cache: true }];
  const body = JSON.parse(P.buildChatRequest(QW, 'qwen3.7-plus', msgs, 'SYS', { cacheControl: true }).body);
  assert.deepStrictEqual(body.messages[0], { role: 'system', content: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }] });
  assert.deepStrictEqual(body.messages[1].content, [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }]);
  assert.strictEqual(body.messages[2].content, 'b');
  assert.deepStrictEqual(body.messages[3].content[1].cache_control, { type: 'ephemeral' });
  assert.ok(!body.messages[3].content[0].cache_control);
  const noSys = JSON.parse(P.buildChatRequest(QW, 'qwen3.7-plus', msgs, 'SYS', { cacheControl: true, cacheSystem: false }).body);
  assert.strictEqual(noSys.messages[0].content, 'SYS');
  const plain = JSON.parse(P.buildChatRequest(QW, 'qwen3.7-plus', msgs, 'SYS', {}).body);
  assert.ok(!JSON.stringify(plain).includes('cache_control'), '未开启时不加标记');
});

test('模型列表元数据：context_length / max_input_tokens / inputTokenLimit', () => {
  const m = P.parseModelsMeta('openai', JSON.stringify({ data: [{ id: 'qwen/qwen3.7-plus', context_length: 1000000, top_provider: { max_completion_tokens: 65536 } }, { id: 'x' }] }));
  assert.deepStrictEqual(m, { 'qwen/qwen3.7-plus': { context: 1000000, maxOutput: 65536 } });
  assert.deepStrictEqual(P.parseModelsMeta('gemini', JSON.stringify({ models: [{ name: 'models/gemini-x', inputTokenLimit: 1048576, outputTokenLimit: 65536 }] })), { 'gemini-x': { context: 1048576, maxOutput: 65536 } });
  assert.deepStrictEqual(P.parseModelsMeta('openai', 'not json'), {});
});

// ---------------- 能力识别 / 预算 / 策略 / 价格 ----------------
test('缓存能力识别：DeepSeek 隐式；千问显式（支持的模型）/ 隐式；OpenRouter / 硅基流动上的千问模型名；其他服务商默认不启用', () => {
  const c = (p, m) => R.capability(p, m);
  assert.deepStrictEqual([c(DS, 'deepseek-flash').vendor, c(DS, 'deepseek-flash').kind, c(DS, 'deepseek-flash').auto], ['deepseek', 'implicit', true]);
  ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus', 'qwen-plus', 'qwen3.8-flash', 'qwen3.7-flash', 'qwen-flash', 'qwen3-coder-flash', 'qwen3-vl-plus', 'qwen-plus-character']
    .forEach(m => assert.strictEqual(c(QW, m).kind, 'explicit', m));
  ['qwen-max', 'qwen-long', 'qwq-plus', 'qwen-flash-character', 'qwen3.8-omni-flash'].forEach(m => assert.strictEqual(c(QW, m).kind, 'implicit', m));
  assert.strictEqual(c(QI, 'qwen3.7-plus').kind, 'explicit');
  const orq = c(OR, 'qwen/qwen3.7-plus'); assert.deepStrictEqual([orq.vendor, orq.kind, orq.auto], ['qwen', 'implicit', true]);
  assert.strictEqual(c(SF, 'Qwen/Qwen3-32B').vendor, 'qwen');
  assert.strictEqual(c(OA, 'gpt-6-astra').auto, false);
  assert.strictEqual(c(preset('anthropic'), 'claude-opus-5-5').auto, false);
  assert.strictEqual(c(preset('moonshot'), 'kimi-k3').kind, 'none');
  assert.ok(R.isApplicable(QW, 'qwen3.7-plus') && R.isApplicable(DS, 'x') && !R.isApplicable(OA, 'gpt-6-astra'));
});

test('预算推导：DeepSeek 保持 v0.4 默认；千问按窗口与价格第一档；模型列表元数据优先', () => {
  const d = R.DEFAULT_SETTINGS;
  const b0 = R.autoBudget(R.capability(DS, 'deepseek-flash'), 'deepseek-flash');
  assert.deepStrictEqual([b0.max_context, b0.output_reserve, b0.safety_margin, b0.trigger_tokens, b0.chapter_cap_tokens], [d.max_context, d.output_reserve, d.safety_margin, d.summary.trigger_tokens, d.summary.chapter_cap_tokens]);
  const b1 = R.autoBudget(R.capability(QW, 'qwen3.7-plus'), 'qwen3.7-plus');
  assert.deepStrictEqual([b1.window, b1.tier, b1.max_context, b1.output_reserve, b1.trigger_tokens], [1000000, 256000, 160000, 16000, 48000]);
  const b2 = R.autoBudget(R.capability(QW, 'qwen-plus'), 'qwen-plus');
  assert.strictEqual(b2.max_context, 102000, '128K 价格档 × 0.8');
  const b3 = R.autoBudget(R.capability(QW, 'qwen-plus-character'), 'qwen-plus-character');
  assert.deepStrictEqual([b3.window, b3.max_context, b3.output_reserve, b3.safety_margin], [32000, 26000, 4000, 1000]);
  const b4 = R.autoBudget(R.capability(OR, 'foo/bar'), 'foo/bar', { context: 50000 });
  assert.deepStrictEqual([b4.source, b4.max_context], ['meta', 40000]);
  assert.ok(b3.max_context - b3.output_reserve - b3.safety_margin > 8000);
});

test('缓存策略：千问显式模型默认显式；请求间隔中位数 > 4 分钟改隐式；可手动指定', () => {
  const cap = R.capability(QW, 'qwen3.7-plus');
  assert.strictEqual(R.chooseStrategy(cap, 'auto', null).strategy, 'explicit');
  assert.strictEqual(R.chooseStrategy(cap, 'auto', 60).strategy, 'explicit');
  assert.strictEqual(R.chooseStrategy(cap, 'auto', 600).strategy, 'implicit');
  assert.strictEqual(R.chooseStrategy(cap, 'explicit', 600).strategy, 'explicit');
  assert.strictEqual(R.chooseStrategy(cap, 'implicit', 10).strategy, 'implicit');
  assert.strictEqual(R.chooseStrategy(R.capability(DS, 'deepseek-flash'), 'explicit', 10).strategy, 'implicit', 'DeepSeek 不受影响');
  assert.strictEqual(R.chooseStrategy(R.capability(preset('moonshot'), 'kimi-k3'), 'auto').strategy, 'none');
});

test('运行时：近期命中率、空闲时长 → 缓存冷却、请求间隔中位数', () => {
  const t0 = 1e12; const logs = [0, 60, 120, 180, 240].map((s, i) => ({ timestamp: t0 + s * 1000, supported: true, hit_rate: 0.5 + i * 0.1 }));
  const cap = R.capability(QW, 'qwen3.7-plus');
  const warm = R.runtimeEnv(logs, t0 + 300e3, cap);
  assert.strictEqual(warm.gapMedian, 60); assert.strictEqual(warm.cold, false); assert.ok(Math.abs(warm.hitRate - 0.7) < 1e-9);
  const cold = R.runtimeEnv(logs, t0 + 240e3 + 301e3, cap);
  assert.strictEqual(cold.cold, true); assert.strictEqual(cold.warm, 0);
  assert.strictEqual(R.runtimeEnv(logs, t0 + 240e3 + 3600e3, R.capability(DS, 'deepseek-flash')).cold, false, 'DeepSeek 缓存数小时');
  assert.strictEqual(R.runtimeEnv([], 0, cap).idleSec, null);
});

test('价格：用户规则优先；未匹配时自动使用内置价格表（千问不分高峰）；显式缓存命中 10% 与创建 125% 计入花费', () => {
  assert.strictEqual(R.priceFor('deepseek-flash', R.DEFAULT_PRICES).miss, 0.3);
  const q = R.priceFor('qwen3.7-plus', R.DEFAULT_PRICES);
  assert.ok(q.builtin && q.peak === false);
  assert.ok(Math.abs(q.miss - 2 / 7.2) < 1e-4 && Math.abs(q.hit - q.miss * 0.2) < 1e-4 && Math.abs(q.hit_explicit - q.miss * 0.1) < 1e-4 && Math.abs(q.write - q.miss * 1.25) < 1e-4);
  assert.strictEqual(R.priceFor('qwen-some-new-model', R.DEFAULT_PRICES).match.split(',')[0], 'qwen-plus', '未知千问模型兜底');
  assert.strictEqual(R.priceFor('qwen/qwen3.8-max', {}).match.split(',')[0], 'qwen3.8-max', 'OpenRouter 前缀');
  const user = { mine: { hit: 0.01, miss: 0.1, out: 0.2, match: 'qwen3.7-plus' } };
  assert.strictEqual(R.priceFor('qwen3.7-plus', user).miss, 0.1);
  assert.strictEqual(R.priceFor('totally-unknown', R.DEFAULT_PRICES), null);
  const peakSat = Date.UTC(2026, 9, 19, 2, 0); // 周一 10:00 北京时间（高峰）
  const e = { model: 'qwen3.7-plus', supported: true, timestamp: peakSat, prompt_tokens: 10000, cache_hit_tokens: 8000, cache_miss_tokens: 2000, completion_tokens: 0 };
  const imp = R.costOf(e, R.DEFAULT_PRICES, 'offpeak');
  assert.ok(Math.abs(imp.actual - (8000 * q.hit + 2000 * q.miss) / 1e6) < 1e-9, '千问不打非高峰折扣');
  const exp = R.costOf(Object.assign({}, e, { cache_mode: 'explicit', cache_write_tokens: 2000 }), R.DEFAULT_PRICES, 'auto');
  assert.ok(Math.abs(exp.actual - (8000 * q.hit_explicit + 2000 * q.miss + 2000 * (q.write - q.miss)) / 1e6) < 1e-9);
});

test('自动预算覆盖：仍为默认值的字段用推导值，单独改过的字段保留；关闭 auto_budget 全部用手动值；不传 env 与 v0.4 一致', () => {
  const st = R.normalizeState(null);
  const env = { budget: R.autoBudget(R.capability(QW, 'qwen3.7-plus'), 'qwen3.7-plus') };
  assert.strictEqual(R.effectiveSettings(st.settings, env).max_context, 160000);
  st.settings.summary = Object.assign({}, st.settings.summary, { trigger_tokens: 5000 });
  const e2 = R.effectiveSettings(st.settings, env);
  assert.deepStrictEqual([e2.max_context, e2.summary.trigger_tokens], [160000, 5000]);
  assert.strictEqual(R.effectiveSettings(Object.assign({}, st.settings, { auto_budget: false }), env).max_context, 100000);
  assert.strictEqual(R.effectiveSettings(st.settings, null), st.settings);
  // 旧版保存的设置：默认值 → 自动；改过 → 手动
  assert.strictEqual(R.normalizeState({ settings: { max_context: 100000, output_reserve: 12000, safety_margin: 2000, summary: { trigger_tokens: 30000, chapter_cap_tokens: 12000 } } }).settings.auto_budget, true);
  assert.strictEqual(R.normalizeState({ settings: { max_context: 64000, output_reserve: 12000, safety_margin: 2000, summary: {} } }).settings.auto_budget, false);
});

function longItems(rounds, len) {
  const items = [];
  for (let i = 0; i < rounds; i++) { items.push({ id: 'u' + i, role: 'user', content: '行动' + i + '剧情'.repeat(len) }); items.push({ id: 'a' + i, role: 'assistant', content: '回复' + i + '描写'.repeat(len) }); }
  items.push({ id: 'in', role: 'user', content: '本轮' });
  return items;
}
test('自适应摘要：缓存冷却时阈值 50% 即摘要；成本回本时 70% 摘要；不传 env 只按固定阈值', () => {
  const st = R.normalizeState(null);
  st.settings.summary = Object.assign({}, st.settings.summary, { trigger_tokens: 10000, min_new_turns: 6, keep_recent_turns: 4, min_interval_turns: 4 });
  const items = longItems(30, 120); // ≈ 30 轮 × 2 × 145 Token ≈ 8.7K
  const base = R.plan(st, '', items);
  assert.ok(!base.needSummary && base.summaryReason === null, '未到固定阈值');
  const cost = { model: 'qwen3.7-plus', prices: R.DEFAULT_PRICES, at: 0 };
  const cold = R.plan(st, '', items, { cold: true, idleSec: 900, warm: 0, cost });
  assert.strictEqual(cold.summaryReason, 'cold');
  const warm = R.plan(st, '', items, { cold: false, warm: 1, hitRate: 0.9, hitSamples: 8, strategy: 'explicit', cost });
  assert.ok(warm.auto && warm.auto.breakEven > 0, '给出回本轮数');
  assert.strictEqual(warm.summaryReason, warm.auto.breakEven <= 12 ? 'adaptive' : null);
  // 命中率很低（缓存经常失效）→ 每轮多发历史更贵 → 更快回本
  const low = R.plan(st, '', items, { cold: false, warm: 1, hitRate: 0.1, hitSamples: 8, strategy: 'implicit', cost });
  assert.ok(low.auto.breakEven < warm.auto.breakEven);
  const off = R.plan(Object.assign({}, st, { settings: Object.assign({}, st.settings, { auto_summary: false }) }), '', items, { cold: true, warm: 0, cost });
  assert.strictEqual(off.summaryReason, null, '关闭自适应');
  const few = R.plan(st, '', longItems(5, 900), { cold: true, warm: 0, cost });
  assert.notStrictEqual(few.summaryReason, 'cold', '可摘要轮数不足时不提前');
  // 冷却时的摘要成本：重建不额外花钱
  const sc = R.summaryCost(cold, Object.assign({}, cost, { warm: 0 })), sw = R.summaryCost(cold, Object.assign({}, cost, { warm: 1 }));
  assert.ok(sc.usd < sw.usd);
});

test('章节合并时机：缓存已冷且章节达到上限 60% 时随摘要一起合并', () => {
  let st = R.normalizeState(null);
  st.settings.summary = Object.assign({}, st.settings.summary, { trigger_tokens: 2000, min_new_turns: 3, keep_recent_turns: 2, min_interval_turns: 0, chapter_cap_tokens: 1000 });
  st = R.addChapter(st, { content: '章'.repeat(500), coveredIds: [], at: 1 });
  st = R.addChapter(st, { content: '节'.repeat(500), coveredIds: [], at: 2 });
  const items = longItems(12, 200);
  const p0 = R.plan(st, '', items);
  assert.ok(p0.needSummary && p0.chapterTokens < 1000 && !p0.needConsolidate);
  const p1 = R.plan(st, '', items, { cold: true, warm: 0 });
  assert.ok(p1.needConsolidate, '缓存已冷 → 趁重建合并');
});

// ---------------- 插件集成（自动启用 / 显式断点 / DeepSeek 不变） ----------------
function mkHost(conv, settings, provider) {
  const store = {}; const calls = [];
  return { calls, raw: store, settings: () => settings, saveSettings() {}, conv: () => conv, saveConv() {}, refresh() {}, toast() {}, esc: s => s,
    provider: () => provider, store: { get: (k, d) => (k in store ? JSON.parse(store[k]) : d), set: (k, v) => { store[k] = JSON.stringify(v); } },
    openPanel() {}, dialog: async () => true, callModel: async (prompt, o) => { calls.push({ prompt, o }); return SUMMARY; } };
}
function session(provider, model, system, o) {
  o = o || {};
  const settings = o.settings || {}; const conv = { id: 'q' + Math.random().toString(36).slice(2), systemPrompt: system, model, providerId: provider.id, messages: [] };
  if (o.rp === true) reg.setForConversation(conv, 'rpcache', true);
  if (o.rp === false) reg.setForConversation(conv, 'rpcache', false);
  const host = mkHost(conv, settings, provider);
  let clock = o.t0 || Date.UTC(2026, 9, 18, 4, 0);
  async function send(text, gapSec) {
    clock += (gapSec || 30) * 1000;
    const realNow = Date.now; Date.now = () => clock;
    try {
      const user = { id: 'u' + conv.messages.length, role: 'user', content: text }; conv.messages.push(user);
      const ctx = { conv, provider, model, systemPrompt: conv.systemPrompt, settings, lastUser: user, meta: {}, opts: { stream: true },
        messages: conv.messages.map(m => ({ role: m.role, content: m.content, _src: m })), setStatus() {}, setCancel() {} };
      const out = await reg.runBeforeRequest(ctx, host);
      const req = P.buildChatRequest(provider, out.model, out.messages, out.systemPrompt, out.opts);
      const bot = { id: 'a' + conv.messages.length, role: 'assistant', content: '回复' + text }; conv.messages.push(bot);
      const json = JSON.parse(req.body);
      reg.runAfterResponse(out, { ok: true, bot, usage: { prompt: 3000, hit: 2000, miss: 1000, cacheWrite: 500, completion: 10, cacheSupported: true } }, host);
      return { out, json, body: req.body, bot };
    } finally { Date.now = realNow; }
  }
  return { conv, settings, host, send };
}
const RP_SYS = '你将扮演角色「艾琳」，一位骑士。世界观：' + '大陆设定'.repeat(600);
const marks = json => json.messages.map((m, i) => (Array.isArray(m.content) && m.content.some(p => p.cache_control) ? i : -1)).filter(i => i >= 0);

test('千问 + RP 对话：自动启用，system 末尾与稳定历史末尾自动加 cache_control（≤ 4 个），日志记录显式缓存', async () => {
  const s = session(QW, 'qwen3.7-plus', RP_SYS);
  assert.ok(reg.isActive('rpcache', s.settings, s.conv, s.host), '未手动开启也自动启用');
  assert.ok(reg.isAutoActive('rpcache', s.settings, s.conv, s.host));
  const r1 = await s.send('推门');
  assert.deepStrictEqual(marks(r1.json), [0], '第一轮：只有 system（历史为空）');
  const r2 = await s.send('拔剑');
  assert.deepStrictEqual(marks(r2.json), [0, 2], 'system + 上一轮回复（稳定历史末尾）');
  const r3 = await s.send('前进');
  assert.deepStrictEqual(marks(r3.json), [0, 4]);
  assert.ok(marks(r3.json).length <= 4);
  assert.strictEqual(r3.json.messages[r3.json.messages.length - 1].content, '前进', '本轮输入不加标记');
  const logs = JSON.parse(s.host.raw['rplog_' + s.conv.id + '.json']);
  assert.strictEqual(logs[2].cache_mode, 'explicit');
  assert.strictEqual(logs[2].cache_write_tokens, 500);
  assert.strictEqual(logs[2].auto_info.vendor, 'qwen');
  assert.strictEqual(logs[2].auto_info.max_context, 160000, '自动预算');
});

test('千问：system 不足 1024 Token 时不标 system；隐式模型 / 手动隐式不加任何标记', async () => {
  const s = session(QW, 'qwen3.7-plus', '你在角色扮演中扮演猫。');
  await s.send('喵' + '。'.repeat(10));
  const r = await s.send('再来' + '剧情'.repeat(800));
  const r2 = await s.send('继续');
  assert.ok(!marks(r.json).includes(0) && !marks(r2.json).includes(0));
  assert.ok(marks(r2.json).length === 1, '历史累计超过 1024 后标历史末尾');
  const imp = session(QW, 'qwen-max', RP_SYS);
  await imp.send('a'); const ri = await imp.send('b');
  assert.ok(!ri.body.includes('cache_control'));
  const man = session(QW, 'qwen3.7-plus', RP_SYS);
  await man.send('a');
  reg.convData(man.conv, 'rpcache').state.settings.cache_mode = 'implicit';
  const rm = await man.send('b');
  assert.ok(!rm.body.includes('cache_control'));
});

test('千问：用户平均每 10 分钟发一条 → 自动改用隐式缓存（不再每轮付 125% 创建费）', async () => {
  const s = session(QW, 'qwen3.7-plus', RP_SYS);
  let r; for (let i = 0; i < 6; i++) r = await s.send('第' + i + '轮', 600);
  assert.ok(!r.body.includes('cache_control'));
  const logs = JSON.parse(s.host.raw['rplog_' + s.conv.id + '.json']);
  assert.strictEqual(logs[logs.length - 1].cache_mode, 'implicit');
});

test('自动启用的边界：非 RP 对话不启用；手动关闭优先；auto_mode=cache 时全部启用；不支持缓存的服务商即使是 RP 也不改写', async () => {
  const plain = session(QW, 'qwen3.7-plus', '你是一个乐于助人的助手。');
  assert.ok(!reg.isActive('rpcache', plain.settings, plain.conv, plain.host));
  const r = await plain.send('你好');
  assert.deepStrictEqual(r.json.messages, [{ role: 'system', content: '你是一个乐于助人的助手。' }, { role: 'user', content: '你好' }]);
  const off = session(QW, 'qwen3.7-plus', RP_SYS, { rp: false });
  assert.ok(!reg.isActive('rpcache', off.settings, off.conv, off.host), '手动关闭');
  const all = session(QW, 'qwen3.7-plus', '你是助手', { settings: { plugins: { rpcache: { auto_mode: 'cache' } } } });
  assert.ok(reg.isActive('rpcache', all.settings, all.conv, all.host));
  const none = session(QW, 'qwen3.7-plus', RP_SYS, { settings: { plugins: { rpcache: { auto_mode: 'off' } } } });
  assert.ok(!reg.isActive('rpcache', none.settings, none.conv, none.host));
  const oa = session(OA, 'gpt-6-astra', RP_SYS);
  assert.ok(!reg.isActive('rpcache', oa.settings, oa.conv, oa.host));
  const ro = await oa.send('推门');
  assert.strictEqual(ro.json.messages[0].content, RP_SYS, 'OpenAI：请求逐字节不变');
  const km = session(preset('moonshot'), 'kimi-k3', RP_SYS);
  assert.ok(!reg.isActive('rpcache', km.settings, km.conv, km.host));
  const ch = session(QW, 'qwen-plus-character', '你好');
  assert.ok(reg.isActive('rpcache', ch.settings, ch.conv, ch.host), 'character 模型视为 RP');
  assert.ok(!reg.isActive('rpcache', {}, plain.conv, null), '没有宿主时不自动启用');
});

test('DeepSeek 不变：请求不含 cache_control / enable_thinking，预算仍为 v0.4 默认', async () => {
  const s = session(DS, 'deepseek-flash', RP_SYS, { rp: true });
  await s.send('a'); const r = await s.send('b');
  assert.ok(!r.body.includes('cache_control') && !r.body.includes('enable_thinking'));
  assert.strictEqual(typeof r.json.messages[0].content, 'string');
  const logs = JSON.parse(s.host.raw['rplog_' + s.conv.id + '.json']);
  assert.strictEqual(logs[1].auto_info.max_context, 100000);
  assert.strictEqual(logs[1].cache_mode, 'implicit');
  // 与不传 env 的 v0.4 规划结果逐字节一致（system + 消息）
  const items = s.conv.messages.map(m => ({ id: m.id, role: m.role, content: m.rpSent != null ? m.rpSent : m.content }));
  const st = reg.convData(s.conv, 'rpcache').state;
  const a1 = R.assemble(R.plan(st, RP_SYS, items)), a2 = R.assemble(R.plan(st, RP_SYS, items, { budget: R.autoBudget(R.capability(DS, 'deepseek-flash'), 'deepseek-flash') }));
  assert.deepStrictEqual(a1, a2);
});

test('OpenRouter 上的千问模型：识别为千问、自动启用（隐式缓存，不加标记）', async () => {
  const s = session(OR, 'qwen/qwen3.7-plus', RP_SYS);
  assert.ok(reg.isActive('rpcache', s.settings, s.conv, s.host));
  await s.send('a'); const r = await s.send('b');
  assert.ok(!r.body.includes('cache_control'));
});
