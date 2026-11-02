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
