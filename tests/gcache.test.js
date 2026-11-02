const test = require('node:test');
const assert = require('node:assert');
const G = require('../app/src/main/assets/www/gcache.js');
const P = require('../app/src/main/assets/www/providers.js');
const OR = { type: 'openai', presetId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-x' };

test('识别 OpenRouter Gemini', () => {
  assert.ok(G.isOpenRouterGemini(OR, 'google/gemini-2.5-flash'));
  assert.ok(G.isOpenRouterGemini({ type: 'openai', baseUrl: 'https://x.com', apiKey: 'sk-or-1' }, '~google/gemini-pro'));
  assert.ok(!G.isOpenRouterGemini(OR, 'anthropic/claude-sonnet-4'));
  assert.ok(!G.isOpenRouterGemini({ type: 'openai', presetId: 'deepseek', baseUrl: 'https://api.deepseek.com' }, 'gemini-2.5'));
  assert.ok(!G.isOpenRouterGemini({ type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' }, 'gemini-2.5-flash'));
});

const msgs = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '嗨' }, { role: 'user', content: '继续' }];
test('系统前缀断点 + TTL + 响应缓存头', () => {
  const req = P.buildChatRequest(OR, 'google/gemini-2.5-flash', msgs, '角色卡', {});
  const r = G.applyToRequest(req, { mode: 'prefix', ttl: '1h', responseCache: true });
  const b = JSON.parse(r.req.body);
  assert.deepStrictEqual(b.messages[0].content, [{ type: 'text', text: '角色卡', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
  assert.strictEqual(r.req.headers['X-OpenRouter-Cache'], 'true');
  assert.strictEqual(r.prefix, '角色卡');
  assert.deepStrictEqual(r.applied, { index: 0, mode: 'prefix' });
});
test('前缀+历史：断点在最后一条用户消息之前，且只有一个断点', () => {
  const req = P.buildChatRequest(OR, 'google/gemini-2.5-flash', msgs.map((m, i) => Object.assign({ _cache: i === 0 }, m)), 'S', { cacheControl: true });
  const b = JSON.parse(G.applyToRequest(req, { mode: 'history' }).req.body);
  assert.strictEqual(JSON.stringify(b).split('cache_control').length - 1, 1);
  assert.ok(Array.isArray(b.messages[2].content) && b.messages[2].content[0].cache_control);
  assert.strictEqual(b.messages[0].content, 'S');
});
test('关闭模式：不加断点、不加头', () => {
  const req = P.buildChatRequest(OR, 'google/gemini-2.5-flash', msgs, 'S', {});
  const r = G.applyToRequest(req, { mode: 'off' });
  assert.strictEqual(r.req.body, req.body);
  assert.ok(!r.req.headers['X-OpenRouter-Cache']);
});
test('合并开头多条 system', () => {
  const req = { url: 'u', headers: {}, body: JSON.stringify({ messages: [{ role: 'system', content: 'A' }, { role: 'system', content: 'B' }, { role: 'user', content: 'x' }] }) };
  const b = JSON.parse(G.applyToRequest(req, { mode: 'prefix' }).req.body);
  assert.strictEqual(b.messages.length, 2);
  assert.strictEqual(b.messages[0].content[0].text, 'A\n\nB');
});
test('OpenRouter usage 缓存读写', () => {
  const u = P.normalizeUsage('openai', { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 } });
  assert.deepStrictEqual(G.usageInfo(u), { prompt: 1000, hit: 800, write: 0, pct: 80 });
  const w = P.normalizeUsage('openai', { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 900 } });
  assert.strictEqual(w.cacheWrite, 900);
});

// ── v1.1.0 算法规格 v1.0 ──
const longWorld = '【世界观】\n' + '这是一个漫长而稳定的奇幻大陆设定，'.repeat(120) + '\n【角色卡】\n艾琳：冷静、守信的女骑士。\n【RP规则】\n每次回复不超过 300 字。';
test('默认 auto：短前缀走隐式缓存，不加断点', () => {
  assert.strictEqual(G.DEFAULTS.mode, 'auto');
  const req = P.buildChatRequest(OR, 'google/gemini-2.5-flash', msgs, '短设定', {});
  const r = G.applyToRequest(req, {});
  assert.strictEqual(r.req.body, req.body);
  assert.strictEqual(r.applied, null);
  assert.match(r.decision.reason, /隐式/);
});
test('auto：长且稳定的固定层第二轮才打断点；动态层拆出、不影响 static_hash', () => {
  const sys1 = longWorld + '\n【当前状态】\n第 1 天，雨。', sys2 = longWorld + '\n【当前状态】\n第 2 天，晴。';
  const r1 = G.applyToRequest(P.buildChatRequest(OR, 'google/gemini-2.5-flash', msgs, sys1, {}), {});
  assert.strictEqual(r1.applied, null);
  const r2 = G.applyToRequest(P.buildChatRequest(OR, 'google/gemini-2.5-flash', msgs, sys2, {}), {}, { prevStaticHash: r1.layers.static_hash });
  assert.strictEqual(r1.layers.static_hash, r2.layers.static_hash);
  assert.notStrictEqual(r1.layers.dynamic_hash, r2.layers.dynamic_hash);
  assert.ok(r2.applied && r2.applied.split);
  const c = JSON.parse(r2.req.body).messages[0].content;
  assert.ok(c[0].cache_control && !c[1].cache_control);
  assert.ok(c[1].text.startsWith('【当前状态】'));
  assert.strictEqual(c[0].text + c[1].text, sys2);
});
test('分层识别与固定层变化', () => {
  const a = G.PromptBuilder.analyzeLayers(longWorld);
  assert.ok(a.layered && a.ordered);
  assert.deepStrictEqual(a.blocks.map(b => b.layer), ['B', 'C', 'D']);
  assert.notStrictEqual(G.PromptBuilder.analyzeLayers(longWorld + '改').static_hash, a.static_hash);
});
test('稳定 session_id：同对话相同、换对话不同；写入 body 顶层且不改 model/provider', () => {
  const s1 = G.OpenRouterAdapter.sessionIdFor('c1');
  assert.strictEqual(s1, G.OpenRouterAdapter.sessionIdFor('c1'));
  assert.notStrictEqual(s1, G.OpenRouterAdapter.sessionIdFor('c2'));
  assert.ok(s1.length <= 256);
  const req = P.buildChatRequest(OR, 'google/gemini-2.5-flash', msgs, 'S', {});
  const b0 = JSON.parse(req.body);
  const b = JSON.parse(G.applyToRequest(req, { mode: 'off' }, { sessionId: s1 }).req.body);
  assert.strictEqual(b.session_id, s1);
  assert.strictEqual(b.model, b0.model);
  assert.deepStrictEqual(b.provider, b0.provider);
});
test('RP 协议锚点：仅 RP 对话注入，普通对话不注入', () => {
  const req = P.buildChatRequest(OR, 'google/gemini-2.5-flash', msgs, 'S', {});
  assert.ok(JSON.parse(G.applyToRequest(req, { mode: 'off' }, { rp: true }).req.body).messages[0].content.startsWith('【RP 协议】'));
  assert.strictEqual(G.applyToRequest(req, { mode: 'off' }, { rp: false }).req.body, req.body);
  assert.strictEqual(G.applyToRequest(req, { mode: 'off', rpGuardrails: 'off' }, { rp: true }).req.body, req.body);
  assert.ok(G.isRpConv({ systemPrompt: longWorld }));
  assert.ok(!G.isRpConv({ systemPrompt: '你是助手' }));
});
test('usage 未知不冒充 0%；成本按价目表估算', () => {
  const u = P.normalizeUsage('openai', { prompt_tokens: 1000, completion_tokens: 5 });
  const i = G.usageInfo(u);
  assert.strictEqual(i.known, false); assert.strictEqual(i.pct, null);
  assert.match(G.usageText(i), /未知/);
  assert.strictEqual(G.estimateCost(i), null);
  assert.deepStrictEqual(G.estimateCost({ prompt: 1000, hit: 800, write: 0 }), { equiv: 400, saved: 600, pctSaved: 60 });
});
test('诊断：<40% 给出原因，≥70% 良好，无样本未知', () => {
  assert.strictEqual(G.diagnose({ roll: [] }).level, 'unknown');
  assert.strictEqual(G.diagnose({ roll: [{ prompt: 100, hit: 80, known: true }] }).level, 'good');
  const d = G.diagnose({ roll: [{ prompt: 100, hit: 10, known: true }], hist: [
    { t: 0, static_hash: 'a', prefix_hash: 'x', model: 'm', provider: '', session_id: 's', tokens: 2000 },
    { t: 600000, static_hash: 'b', prefix_hash: 'y', model: 'm2', provider: '', session_id: 's', tokens: 2000 }] });
  assert.strictEqual(d.level, 'low');
  assert.ok(d.issues.some(x => /static_hash/.test(x)) && d.issues.some(x => /模型/.test(x)) && d.issues.some(x => /5 分钟/.test(x)));
});
test('MemoryManager：L0 抽取、检索评分、误压缩检测', () => {
  const l0 = G.MemoryManager.extractL0(G.PromptBuilder.analyzeLayers(longWorld));
  assert.ok(l0.some(x => x.layer === 'C' && /艾琳/.test(x.text)));
  const hits = G.MemoryManager.search(l0, '艾琳是什么性格', 1);
  assert.ok(/艾琳/.test(hits[0].text) && hits[0].score > 0);
  assert.strictEqual(G.MemoryManager.missingL0(l0, longWorld).length, 0);
  assert.ok(G.MemoryManager.missingL0(l0, '【世界观】已压缩').length > 0);
  assert.strictEqual(G.MemoryManager.backupPointer([{ role: 'user', content: 'a' }]).count, 1);
});
test('非 OpenRouter Gemini 不识别（请求不经过 transform）', () => {
  assert.ok(!G.isOpenRouterGemini({ type: 'openai', presetId: 'deepseek', baseUrl: 'https://api.deepseek.com' }, 'deepseek-chat'));
});

// ── v1.2.0 Hybrid-5 ──
const H = G.HybridWindow;
const mkHist = n => { const a = []; for (let i = 1; i <= n; i++) a.push({ role: 'user', content: '第' + i + '句' }, { role: 'assistant', content: '回' + i }); return a; };
test('Hybrid-5：20/39 轮不摘要，40 轮压一次，41–59 不再生成，60 轮再压一批', () => {
  let st = H.empty();
  assert.strictEqual(H.apply(mkHist(20), st).summaryCreated, false);
  assert.strictEqual(H.apply(mkHist(39), st).summaryCreated, false);
  const r40 = H.apply(mkHist(40), st);
  assert.ok(r40.summaryCreated && r40.prefixChanged);
  assert.strictEqual(st.summaries.length, 1); assert.strictEqual(st.cut, 20); assert.strictEqual(r40.rawTurns, 20);
  assert.strictEqual(r40.messagesForRequest[0].role, 'system'); assert.ok(r40.messagesForRequest[0].content.startsWith(H.SUM_HEAD));
  assert.strictEqual(r40.messagesForRequest.length, 1 + 40);
  st = JSON.parse(JSON.stringify(st)); // 持久化往返
  const frozen = st.summaries[0].text;
  for (let n = 41; n < 60; n++) { const r = H.apply(mkHist(n), st); assert.strictEqual(r.summaryCreated, false); assert.strictEqual(r.prefixChanged, false); assert.strictEqual(r.untilNext, 60 - n); }
  const r60 = H.apply(mkHist(60), st);
  assert.ok(r60.summaryCreated); assert.strictEqual(st.summaries.length, 2); assert.strictEqual(st.cut, 40);
  assert.strictEqual(st.summaries[0].text, frozen);
  assert.strictEqual(H.apply(mkHist(60), st).messagesForRequest[0].content, r60.messagesForRequest[0].content);
});
test('Hybrid-5：前缀（摘要+窗口头）在 41–59 轮之间稳定', () => {
  const st = H.empty(); H.apply(mkHist(40), st);
  const a = JSON.stringify(H.apply(mkHist(45), st).messagesForRequest.slice(0, 30)), b = JSON.stringify(H.apply(mkHist(50), st).messagesForRequest.slice(0, 30));
  assert.strictEqual(a, b);
});
test('Hybrid-5：动态层移到本轮 user 尾部、固定层 hash 不变、日期只到天、session_id 保留', () => {
  const st = H.empty();
  const sys = d => longWorld + '\n【当前状态】\n' + d;
  const r1 = G.applyToRequest(P.buildChatRequest(OR, 'google/gemini-2.5-flash', msgs, sys('2026-11-02 13:45 雨'), {}), {}, { hybrid: st, sessionId: 'sid1' });
  const b1 = JSON.parse(r1.req.body);
  assert.ok(!/当前状态/.test(b1.messages[0].content));
  const last = b1.messages[b1.messages.length - 1];
  assert.ok(last.content.startsWith('【当前状态】\n2026-11-02 雨') && last.content.endsWith('继续'));
  assert.strictEqual(b1.session_id, 'sid1'); assert.ok(!b1.provider);
  const msgs2 = msgs.concat([{ role: 'assistant', content: '好' }, { role: 'user', content: '再来' }]);
  const r2 = G.applyToRequest(P.buildChatRequest(OR, 'google/gemini-2.5-flash', msgs2, sys('2026-11-03 08:00 晴'), {}), {}, { hybrid: st, prevStaticHash: r1.layers.static_hash });
  assert.strictEqual(r1.layers.static_hash, r2.layers.static_hash);
  const b2 = JSON.parse(r2.req.body);
  // 上一轮完整请求 == 本轮前缀（system + 历史，其中上一轮 user 为实际送出的完整文本）
  assert.deepStrictEqual(b2.messages.slice(0, b1.messages.length).map(m => typeof m.content === 'string' ? m.content : m.content.map(x => x.text).join('')), b1.messages.map(m => m.content));
  assert.ok(r2.applied); // 固定层稳定且够长 → auto 断点
});
test('Hybrid-5：未传 hybrid 状态时行为与 1.1.0 完全一致；日期归一', () => {
  const req = P.buildChatRequest(OR, 'google/gemini-2.5-flash', msgs, '短设定 2026-11-02 13:45', {});
  assert.strictEqual(G.applyToRequest(req, {}).req.body, req.body);
  assert.strictEqual(G.normalizeDates('2026年11月2日 13:45:10 / 2026-11-02T13:45Z'), '2026年11月2日 / 2026-11-02');
});
test('Hybrid-5：非 OpenRouter+Gemini 不识别（插件不改请求）；冲突策略 A：rpcache 同开不启用 Zip', () => {
  assert.ok(!G.isOpenRouterGemini({ type: 'openai', presetId: 'openai', baseUrl: 'https://api.openai.com/v1' }, 'gpt-4o'));
  assert.ok(!G.isOpenRouterGemini(OR, 'openai/gpt-4o'));
  const src = require('fs').readFileSync(require.resolve('../app/src/main/assets/www/gcache.js'), 'utf8');
  assert.match(src, /hyOn = o\.hybrid !== false && !\(ctx\.meta && ctx\.meta\.gcacheRpcache\)/);
  assert.strictEqual(G.DEFAULTS.hybrid, true);
});
test('Hybrid-5：编辑已冻结批次 → 作废并重建，历史删短 → 重置', () => {
  const st = H.empty(); H.apply(mkHist(40), st);
  const h = mkHist(40); h[0].content = '改过';
  const r = H.apply(h, st); assert.ok(r.summaryCreated); assert.ok(/改过/.test(st.summaries[0].text));
  const r2 = H.apply(mkHist(10), st); assert.strictEqual(st.summaries.length, 0); assert.strictEqual(r2.rawTurns, 10);
});

// ── v0.8.8：auto+Hybrid 断点放到本轮 user 之前 / 保活分析 / 写入价 ──
test('auto+Hybrid：断点在本轮 user 之前，历史进缓存；autoTarget=prefix 可切回', () => {
  const G = require('../app/src/main/assets/www/gcache.js');
  const sys = '【世界观】\n' + '世界'.repeat(700);
  const msgs = [{ role: 'system', content: sys }, { role: 'user', content: '你好' }, { role: 'assistant', content: '嗨' }, { role: 'user', content: '继续' }];
  const req = { url: 'x', headers: {}, body: JSON.stringify({ model: 'google/gemini-2.5-flash', messages: msgs }) };
  const first = G.applyToRequest(req, { mode: 'auto' }, { hybrid: G.HybridWindow.empty() });
  const r = G.applyToRequest(req, { mode: 'auto' }, { hybrid: G.HybridWindow.empty(), prevStaticHash: first.layers.static_hash });
  const b = JSON.parse(r.req.body).messages;
  assert.ok(r.decision.history && r.applied.history);
  assert.equal(b[2].role, 'assistant'); assert.ok(b[2].content[0].cache_control);
  assert.equal(typeof b[3].content, 'string');
  const p = G.applyToRequest(req, { mode: 'auto', autoTarget: 'prefix' }, { hybrid: G.HybridWindow.empty(), prevStaticHash: first.layers.static_hash });
  const pb = JSON.parse(p.req.body).messages;
  assert.ok(pb[0].content[0].cache_control); assert.equal(typeof pb[2].content, 'string');
  // 不带 hybrid 时行为不变（只盖固定前缀）
  const n = G.applyToRequest(req, { mode: 'auto' }, { prevStaticHash: first.layers.static_hash });
  assert.ok(!n.decision.history);
});
test('保活分析与写入价', () => {
  const G = require('../app/src/main/assets/www/gcache.js'), K = G.KeepAlive;
  assert.equal(K.pingsForGap(100, 270, 3), 0);
  assert.equal(K.pingsForGap(600, 270, 3), 2);
  assert.ok(K.recommend([600, 700, 500], 300, 270, 3).enable);
  assert.ok(!K.recommend([30, 40, 60], 300, 270, 3).enable);
  assert.ok(!K.recommend([5000, 6000], 300, 270, 3).enable);
  assert.equal(K.recommend([], 300, 270, 3).samples, 0);
  const c1 = G.estimateCost({ prompt: 1000, hit: 0, write: 1000 }), c2 = G.estimateCost({ prompt: 1000, hit: 0, write: 1000 }, { write: 1.5 });
  assert.equal(c1.equiv, 1000); assert.equal(c2.equiv, 1500);
  assert.ok(G.expectedHit({ explicit: true, prefix_hash: 'a', t: 0 }, { prefix_hash: 'a', t: 1000 }, 300));
  assert.ok(!G.expectedHit({ explicit: true, prefix_hash: 'a', t: 0 }, { prefix_hash: 'b', t: 1000 }, 300));
});
