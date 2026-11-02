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
  const b = JSON.parse(G.applyToRequest(req, {}).req.body);
  assert.strictEqual(b.messages.length, 2);
  assert.strictEqual(b.messages[0].content[0].text, 'A\n\nB');
});
test('OpenRouter usage 缓存读写', () => {
  const u = P.normalizeUsage('openai', { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 } });
  assert.deepStrictEqual(G.usageInfo(u), { prompt: 1000, hit: 800, write: 0, pct: 80 });
  const w = P.normalizeUsage('openai', { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 900 } });
  assert.strictEqual(w.cacheWrite, 900);
});
