// P0：缓存门槛自适应；不破坏其它服务商；不低于官方门槛
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const www = path.join(__dirname, '..', 'app/src/main/assets/www');
const G = require(path.join(www, 'plugins/cache/gcache.js'));
const E = G.CachePolicyEngine;

test('adaptiveMinTokens：冷启动 = 官方门槛；命中差才上调；永不低于官方值', () => {
  assert.strictEqual(E.minCacheTokens('google/gemini-2.5-pro'), 4096);
  assert.strictEqual(E.adaptiveMinTokens('google/gemini-2.5-pro'), 4096);
  assert.strictEqual(E.adaptiveMinTokens('google/gemini-2.5-pro', { hitSamples: 2, hitRate: 0.1 }), 4096);
  assert.strictEqual(E.adaptiveMinTokens('google/gemini-2.5-flash', { hitSamples: 10, hitRate: 0.8 }), 1024);
  const poor = E.adaptiveMinTokens('google/gemini-2.5-flash', { hitSamples: 10, hitRate: 0.30 });
  assert.strictEqual(poor, Math.round(1024 * 1.5));
  assert.ok(poor >= E.minCacheTokens('google/gemini-2.5-flash'));
  const mid = E.adaptiveMinTokens('google/gemini-2.5-flash-lite', { hitSamples: 8, hitRate: 0.50 });
  assert.strictEqual(mid, Math.round(2048 * 1.25));
  assert.ok(mid >= 2048);
});

test('decide：自适应提高门槛后，临界前缀改走隐式；官方门槛以下仍不写显式', () => {
  const info = {
    model: 'google/gemini-2.5-flash',
    staticText: '字'.repeat(1100), // ~1100 tokens CJK，高于 1024、低于 1024*1.5
    static_hash: 'aaa',
    prevStaticHash: 'aaa',
    cacheStats: { hitSamples: 10, hitRate: 0.2 },
  };
  const d = E.decide({ mode: 'auto' }, info);
  assert.strictEqual(d.explicit, false);
  assert.match(d.reason, /门槛/);

  const ok = E.decide({ mode: 'auto' }, Object.assign({}, info, { cacheStats: { hitSamples: 10, hitRate: 0.9 } }));
  assert.strictEqual(ok.explicit, true);

  const short = E.decide({ mode: 'auto' }, Object.assign({}, info, { staticText: '字'.repeat(800), cacheStats: { hitSamples: 10, hitRate: 0.9 } }));
  assert.strictEqual(short.explicit, false);
});

test('其它服务商缓存不受影响：mmcache 不调用 adaptiveMinTokens / CachePolicyEngine', () => {
  const mm = fs.readFileSync(path.join(www, 'plugins/cache/mmcache.js'), 'utf8');
  assert.ok(!mm.includes('adaptiveMinTokens'));
  assert.ok(!mm.includes('CachePolicyEngine'));
  assert.ok(!mm.includes('minCacheTokens'));
});

test('openai-compat 适配器仍不打 cache_control（即使 decide 为显式）', () => {
  const long = '系统设定。'.repeat(800);
  const req = { headers: {}, body: JSON.stringify({ model: 'google/gemini-2.5-flash', messages: [
    { role: 'system', content: long },
    { role: 'user', content: '你好' },
  ] }) };
  const r = G.applyToRequest(req, { mode: 'auto' }, {
    adapter: 'openai-compat',
    prevStaticHash: G.hash(long),
    cacheStats: { hitSamples: 10, hitRate: 0.9 },
  });
  const body = JSON.parse(r.req.body);
  const hasCC = JSON.stringify(body).includes('cache_control');
  assert.strictEqual(hasCC, false);
  assert.strictEqual(r.adapter, 'openai-compat');
});
