const test = require('node:test');
const assert = require('node:assert');
require('../app/src/main/assets/www/retrieval-core.js');
const K = require('../app/src/main/assets/www/knowledge.js');

function sampleDoc() {
  return {
    worldId: 'w1', updatedAt: 1,
    categories: [
      { id: 'locations', name: '地点', order: 0, entries: [
        { id: 'e-alley', title: '青石巷', content: '城西一条窄巷，雨后积水，尽头是旧井。', keywords: ['青石巷', '雨'], tags: [], pinned: false, updatedAt: 1 },
        { id: 'e-well', title: '旧井', content: '青石巷尽头的废井。', keywords: ['旧井'], tags: [], pinned: false, updatedAt: 1 },
      ]},
      { id: 'inventory', name: '物品', order: 1, entries: [
        { id: 'e-key', title: '青铜钥匙', content: '在巷口旧井旁捡到的青铜钥匙。', keywords: ['钥匙', '青铜'], tags: [], pinned: true, updatedAt: 1 },
      ]},
    ],
  };
}

test('search BM25：青石召回巷', () => {
  const hits = K.search(sampleDoc(), '青石巷', { limit: 5 });
  assert.ok(hits.some(h => h.entry.id === 'e-alley'));
});

test('selectForInject：预算不超、pinned 优先、trace', () => {
  const r = K.selectForInject(sampleDoc(), '青铜钥匙旧井', { budget: 400 });
  assert.ok(r.trace.tokens <= 400);
  assert.ok(r.hits.some(h => h.entry.id === 'e-key'), 'pinned key');
  assert.ok(Array.isArray(r.trace.hitIds));
});

test('selectForInject：与 L1 重复去重', () => {
  const l1 = '城西一条窄巷，雨后积水，尽头是旧井。青石巷的详细描写。';
  const r = K.selectForInject(sampleDoc(), '青石巷', { budget: 400, alreadyTexts: [l1] });
  assert.ok(!r.hits.some(h => h.entry.id === 'e-alley') || r.trace.dropped.some(d => d.reason === 'dup'));
});

test('spliceIntoUserContent：插在 MEMORY 与 STATE 之间', () => {
  const base = '你好\n\n[MEMORY_UPDATE]\n- 旧事\n\n[CURRENT_STATE]\n地点：巷口';
  const inj = K.renderInjection([{ categoryName: '地点', entry: { title: '青石巷', content: '窄巷' } }]);
  const out = K.spliceIntoUserContent(base, inj);
  const iMem = out.indexOf('[MEMORY_UPDATE]');
  const iKn = out.indexOf('[LOCAL_KNOWLEDGE]');
  const iSt = out.indexOf('[CURRENT_STATE]');
  assert.ok(iMem >= 0 && iKn > iMem && iSt > iKn);
});

test('budget 0 → 无注入', () => {
  const r = K.selectForInject(sampleDoc(), '青石巷', { budget: 0 });
  assert.strictEqual(r.hits.length, 0);
});
