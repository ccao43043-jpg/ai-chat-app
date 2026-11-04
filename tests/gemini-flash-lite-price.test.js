const test = require('node:test');
const assert = require('node:assert');
const R = require('../app/src/main/assets/www/rpcache.js');

test('C7：BUILTIN_PRICES 含 Gemini 2.5 Flash-Lite，priceFor 非 null', () => {
  const p = R.priceFor('google/gemini-2.5-flash-lite');
  assert.ok(p, 'priceFor(google/gemini-2.5-flash-lite) should be non-null');
  assert.equal(p.miss, 0.10);
  assert.equal(p.out, 0.40);
  assert.equal(p.hit, 0.025);
  assert.ok(p.builtin);
  assert.ok(R.priceFor('gemini-2.5-flash-lite'));
  assert.ok(R.priceFor('google/gemini-3.5-flash-lite'), 'flash-lite match covers family');
  assert.equal(R.priceFor('totally-unknown-xyz'), null);
});
