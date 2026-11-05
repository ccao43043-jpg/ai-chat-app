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

test('effectiveTokenPricing ignores discount (prices already discounted) and drops non-positive', () => {
  assert.deepStrictEqual(
    P.effectiveTokenPricing({ prompt: '0.00000004', completion: '0.00000015', input_cache_read: '0.000000004', discount: 0.8 }),
    { prompt: 0.04, completion: 0.15, cacheRead: 0.004 }
  );
  assert.deepStrictEqual(
    P.effectiveTokenPricing({ prompt: '0.00000015', completion: '0.0000006', discount: 0 }),
    { prompt: 0.15, completion: 0.6 }
  );
  assert.deepStrictEqual(P.effectiveTokenPricing({ prompt: '0.000001', completion: '0.000002', discount: 1 }), { prompt: 1, completion: 2 });
  assert.strictEqual(P.effectiveTokenPricing({ prompt: '-1', completion: '-1', discount: 0.5 }), null);
  assert.deepStrictEqual(
    P.effectiveTokenPricing({ prompt: '0.000001', completion: '0.000002', discount: 2 }), // discount ignored
    { prompt: 1, completion: 2 }
  );
  // missing discount ≡ 0
  assert.deepStrictEqual(
    P.effectiveTokenPricing({ prompt: '0.000001', completion: '0.000002' }),
    { prompt: 1, completion: 2 }
  );
});

test('floorPricingFromEndpoints picks lowest effective endpoint', () => {
  const endpoints = [
    { provider_name: 'Top', pricing: { prompt: '0.000001', completion: '0.000003', discount: 0 } }, // $1 / $3
    { provider_name: 'Flex', pricing: { prompt: '0.0000004', completion: '0.0000015', discount: 0.5 } }, // already discounted: $0.4 / $1.5
    { provider_name: 'Mid', pricing: { prompt: '0.0000005', completion: '0.000002', discount: 0 } }, // $0.5 / $2
  ];
  assert.deepStrictEqual(P.floorPricingFromEndpoints(endpoints), { prompt: 0.4, completion: 1.5 });
  // Gemini 3.8 Flash shape: Flex $0.375/$1.875 vs Standard $0.75/$3.75 (both already 50% off)
  assert.deepStrictEqual(P.floorPricingFromEndpoints([
    { provider_name: 'Standard', pricing: { prompt: '0.00000075', completion: '0.00000375', discount: 0.5 } },
    { provider_name: 'Flex', pricing: { prompt: '0.000000375', completion: '0.000001875', discount: 0.5 } },
  ]), { prompt: 0.375, completion: 1.875 });
  // tie on sum → lower prompt wins
  assert.deepStrictEqual(P.floorPricingFromEndpoints([
    { pricing: { prompt: '0.0000006', completion: '0.0000004' } }, // 0.6+0.4
    { pricing: { prompt: '0.0000003', completion: '0.0000007' } }, // 0.3+0.7
  ]), { prompt: 0.3, completion: 0.7 });
  assert.strictEqual(P.floorPricingFromEndpoints([]), null);
  assert.strictEqual(P.floorPricingFromEndpoints(null), null);
});

test('formatModelPrice prefixes 最低 when floor', () => {
  assert.strictEqual(
    P.formatModelPrice({ price: { prompt: 0.1, completion: 0.32 }, priceIsFloor: true }),
    '最低 输入 $0.10 / 输出 $0.32 · 百万Token'
  );
  assert.strictEqual(
    P.formatModelPrice({ priceFloor: { prompt: 0.1, completion: 0.32 } }),
    '最低 输入 $0.10 / 输出 $0.32 · 百万Token'
  );
});

test('buildEndpointsRequest and parseEndpointsResponse', () => {
  const req = P.buildEndpointsRequest({ baseUrl: 'https://openrouter.ai/api/v1/', apiKey: 'sk' }, 'openai/gpt-4o-mini');
  assert.strictEqual(req.method, 'GET');
  assert.strictEqual(req.url, 'https://openrouter.ai/api/v1/models/openai/gpt-4o-mini/endpoints');
  assert.strictEqual(req.headers.Authorization, 'Bearer sk');
  const eps = P.parseEndpointsResponse(JSON.stringify({
    data: { id: 'openai/gpt-4o-mini', endpoints: [{ pricing: { prompt: '0.00000015', completion: '0.0000006' } }] }
  }));
  assert.strictEqual(eps.length, 1);
  assert.deepStrictEqual(P.floorPricingFromEndpoints(eps), { prompt: 0.15, completion: 0.6 });
});
