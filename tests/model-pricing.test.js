const test = require('node:test');
const assert = require('node:assert');
const P = require('../app/src/main/assets/www/providers.js');

test('parseModelsMeta keeps OpenRouter pricing as $/M tokens and $/image', () => {
  const text = JSON.stringify({ data: [
    { id: 'a/text', context_length: 128000, pricing: { prompt: '0.0000005', completion: '0.000003', input_cache_read: '0.00000005' } },
    { id: 'a/img', pricing: { prompt: '0', completion: '0', image: '0.01' } },
    { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
  ] });
  const m = P.parseModelsMeta('openai', text);
  assert.deepStrictEqual(m['a/text'].price, { prompt: 0.5, completion: 3, cacheRead: 0.05 });
  assert.deepStrictEqual(m['a/img'].price, { image: 0.01 });
  assert.strictEqual(m['openrouter/auto'], undefined);
});

test('formatModelPrice', () => {
  assert.strictEqual(P.formatModelPrice({ price: { prompt: 0.5, completion: 3 } }), '输入 $0.50 / 输出 $3.00 · 百万Token');
  assert.strictEqual(P.formatModelPrice({ price: { image: 0.01 } }), '约 $0.01/张');
  assert.strictEqual(P.formatModelPrice({}), '—');
  assert.strictEqual(P.formatModelPrice(null), '—');
  assert.strictEqual(P.formatContext(128000), '128K');
});
