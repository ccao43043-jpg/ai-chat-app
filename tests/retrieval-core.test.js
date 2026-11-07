const test = require('node:test');
const assert = require('node:assert');
const RC = require('../app/src/main/assets/www/retrieval-core.js');

test('grams：中文 bigram', () => {
  assert.deepStrictEqual(RC.grams('青铜钥匙'), ['青铜', '铜钥', '钥匙']);
});

test('bm25f：title 权重大于 content', () => {
  const docs = [
    { id: '1', title: '其他', content: '一大段关于青铜钥匙的描述文字填满', keywords: [], tags: [], updatedAt: 1 },
    { id: '2', title: '青铜钥匙', content: '短', keywords: [], tags: [], updatedAt: 1 },
  ];
  const idx = RC.buildIndex(docs, ['title', 'keywords', 'tags', 'content']);
  const Q = RC.buildQuery('青铜钥匙');
  const w = { title: 4, keywords: 3, tags: 2, content: 1 };
  assert.ok(RC.bm25f(idx, Q, docs[1], w) > RC.bm25f(idx, Q, docs[0], w));
});

test('mmr + pickByBudget', () => {
  const cands = [
    { id: 'a', score: 1, text: '青石巷雨后积水' },
    { id: 'b', score: 0.95, text: '青石巷雨后积水很多' },
    { id: 'c', score: 0.5, text: '烛光酒馆老板卡尔' },
  ];
  const ranked = RC.mmr(cands, 0.7, null, 3);
  assert.ok(ranked.some(x => x.id === 'c'), 'diversity');
  const picked = RC.pickByBudget(ranked, c => 100, 150);
  assert.ok(picked.length <= 1);
});

test('jaccard3 去重阈值', () => {
  assert.ok(RC.jaccard3('青石巷雨后积水', '青石巷雨后积水很多') > 0.6);
  assert.ok(RC.jaccard3('青石巷', '烛光酒馆') < 0.3);
});
