// 缓存显示：OpenRouter usage（cached_tokens / cost / cache_discount）解析与展示数据
const test = require('node:test');
const assert = require('node:assert');
const P = require('../app/src/main/assets/www/providers.js');

test('OpenRouter MiniMax：cached_tokens + cost + cache_discount', () => {
  const u = P.normalizeUsage('openai', { prompt_tokens: 10000, completion_tokens: 200, cost: 0.0012,
    prompt_tokens_details: { cached_tokens: 8000 }, cache_discount: 0.0009 });
  assert.strictEqual(u.hit, 8000); assert.strictEqual(u.miss, 2000); assert.strictEqual(u.cost, 0.0012); assert.strictEqual(u.cacheSaved, 0.0009);
  const v = P.cacheView(u);
  assert.strictEqual(v.rate, 80); assert.strictEqual(v.saved, 0.0009); assert.strictEqual(v.savedEstimated, false);
  const t = P.cacheViewText(v);
  assert.match(t.text, /缓存命中 8,000 \/ 10,000 Token · 命中率 80% · 节省 \$0\.0009/);
  assert.match(t.title, /实际费用 \$0\.0012/);
});

test('cost_cache 负值表示节省', () => {
  const u = P.normalizeUsage('openai', { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 50 }, cost_cache: -0.002 });
  assert.strictEqual(u.cacheSaved, 0.002);
});

test('Gemini via OpenRouter：缓存写入 + 无节省字段时按模型价估算', () => {
  const u = P.normalizeUsage('openai', { prompt_tokens: 4000, prompt_tokens_details: { cached_tokens: 3000, cache_write_tokens: 500 } });
  const v = P.cacheView(u, { prompt: 0.1, cacheRead: 0.025 });
  assert.ok(Math.abs(v.saved - 3000 * 0.075 / 1e6) < 1e-12); assert.strictEqual(v.savedEstimated, true); assert.strictEqual(v.write, 500);
  assert.match(P.cacheViewText(v).text, /约省 .*写入 500/);
});

test('无缓存字段：不显示；cached_tokens=0：显示未命中而非假命中', () => {
  assert.strictEqual(P.cacheView(P.normalizeUsage('openai', { prompt_tokens: 100, completion_tokens: 5, cost: 0.001 })), null);
  assert.strictEqual(P.cacheViewText(null), null);
  const v = P.cacheView(P.normalizeUsage('openai', { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } }));
  assert.strictEqual(P.cacheViewText(v).text, '缓存未命中');
});

test('顶层 cache_read_input_tokens（MiniMax 原生等）', () => {
  const u = P.normalizeUsage('openai', { prompt_tokens: 1000, cache_read_input_tokens: 600 });
  assert.strictEqual(u.hit, 600); assert.strictEqual(P.cacheView(u).rate, 60);
});

test('Gemini 原生 cachedContentTokenCount 同样可显示', () => {
  const v = P.cacheView(P.normalizeUsage('gemini', { promptTokenCount: 2000, candidatesTokenCount: 10, cachedContentTokenCount: 1500 }));
  assert.strictEqual(v.rate, 75);
});

test('流式：最后一块 usage 合并后保留 cost / 缓存', () => {
  const a = P.mergeUsage(null, P.normalizeUsage('openai', { prompt_tokens: 10 }));
  const b = P.mergeUsage(a, P.normalizeUsage('openai', { prompt_tokens: 10, completion_tokens: 3, cost: 0.5, prompt_tokens_details: { cached_tokens: 4 } }));
  assert.strictEqual(b.hit, 4); assert.strictEqual(b.cost, 0.5); assert.strictEqual(P.cacheView(b).rate, 40);
});
