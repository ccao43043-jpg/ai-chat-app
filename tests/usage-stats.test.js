const test = require('node:test');
const assert = require('node:assert');
const U = require('../app/src/main/assets/www/usage-stats.js');

const usage = (p, c, hit, miss) => ({ prompt: p, completion: c, hit, miss, cacheSupported: hit != null });

test('record + prune 到 LOG_LIMIT', () => {
  let s = U.emptyState();
  for (let i = 0; i < 10; i++) {
    s = U.record(s, U.makeEntry({ usage: usage(100, 10), at: 1000 + i, msgId: 'm' + i, key: 'k' + i }));
  }
  assert.strictEqual(s.log.length, 10);
  // 强制小上限：直接塞满后用内部逻辑
  const lim = U.LOG_LIMIT;
  assert.ok(lim >= 100);
  let big = U.emptyState();
  for (let i = 0; i < lim + 5; i++) {
    big = U.record(big, U.makeEntry({ usage: usage(1, 1), at: i + 1, key: 'x' + i }));
  }
  assert.strictEqual(big.log.length, lim);
  assert.strictEqual(big.log[0].key, 'x5');
  assert.strictEqual(big.log[lim - 1].key, 'x' + (lim + 4));
});

test('同 key 不重复记账', () => {
  let s = U.emptyState();
  const e = U.makeEntry({ usage: usage(50, 5, 40, 10), at: 1, key: 'same' });
  s = U.record(s, e);
  s = U.record(s, U.makeEntry({ usage: usage(50, 5, 40, 10), at: 2, key: 'same' }));
  assert.strictEqual(s.log.length, 1);
});

test('聚合 totals / byDay / byModel / byProvider / byConv', () => {
  const now = Date.parse('2026-10-05T12:00:00+08:00');
  let s = U.emptyState();
  const rows = [
    { usage: usage(1000, 100, 800, 200), at: now - 864e5, model: 'deepseek-flash', providerId: 'ds', providerName: 'DeepSeek', convId: 'c1', convTitle: '甲', key: 'a' },
    { usage: usage(500, 50), at: now, model: 'gpt-4o', providerId: 'oa', providerName: 'OpenAI', convId: 'c2', convTitle: '乙', key: 'b' },
    { usage: usage(200, 20, 100, 100), at: now, model: 'deepseek-flash', providerId: 'ds', providerName: 'DeepSeek', convId: 'c1', convTitle: '甲', type: 'summary', key: 'c' },
  ];
  rows.forEach(r => { s = U.record(s, U.makeEntry(r)); });
  const range = U.rangeOf('30d', now);
  const list = U.filterLog(s.log, range);
  const t = U.sumList(list);
  assert.strictEqual(t.prompt, 1700);
  assert.strictEqual(t.completion, 170);
  assert.strictEqual(t.requests, 3);
  assert.strictEqual(t.hit, 900);
  assert.strictEqual(t.miss, 800); // 200+100 + 500(无缓存按整段 miss)
  const models = U.groupBy(list, e => e.model);
  assert.strictEqual(models[0].key, 'deepseek-flash');
  assert.strictEqual(models[0].requests, 2);
  const prov = U.groupBy(list, e => e.providerName || e.providerId);
  assert.ok(prov.find(x => x.key === 'DeepSeek').total === 1320);
  const convs = U.groupBy(list, e => e.convTitle || e.convId);
  assert.strictEqual(convs[0].key, '甲');
  const days = U.byDay(list, 3, now);
  assert.strictEqual(days.length, 3);
  assert.strictEqual(days[2].requests, 2); // 今天
  assert.strictEqual(days[1].requests, 1); // 昨天
});

test('花费估算：DeepSeek 高峰/非高峰', () => {
  // 北京时间周二 10:00 = UTC 02:00 → 高峰
  const peakAt = Date.parse('2026-10-06T10:00:00+08:00');
  const offAt = Date.parse('2026-10-05T20:00:00+08:00'); // 周日晚 → 非高峰
  const e1 = U.makeEntry({ usage: usage(1e6, 1e6, 5e5, 5e5), at: peakAt, model: 'deepseek-flash', key: 'p' });
  const e2 = U.makeEntry({ usage: usage(1e6, 0, 0, 1e6), at: offAt, model: 'deepseek-flash', key: 'o' });
  const prices = U.DEFAULT_PRICES;
  // peak: (5e5*0.006 + 5e5*0.3 + 1e6*1.2) / 1e6 = 0.003 + 0.15 + 1.2 = 1.353
  assert.ok(Math.abs(U.costOf(e1, prices, 'peak') - 1.353) < 1e-9);
  // offpeak half of miss-only input: (1e6*0.3)/1e6 * 0.5 = 0.15
  assert.ok(Math.abs(U.costOf(e2, prices, 'offpeak') - 0.15) < 1e-9);
  const est = U.estimateCost([e1, e2], prices, 'peak');
  assert.strictEqual(est.priced, 2);
  assert.ok(est.cost > 1);
});

test('回填：扫描对话 + 版本分支，不重复；第二次跳过', () => {
  const convs = [{
    id: 'c1', title: '旧', providerId: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-flash', updatedAt: 1000,
    messages: [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 100 },
      { id: 'a1', role: 'assistant', content: 'v2', createdAt: 300, usage: usage(30, 5, 10, 20), model: 'deepseek-flash',
        vi: 1, versions: [
          { content: 'v1', createdAt: 200, usage: usage(20, 4), model: 'deepseek-flash', tail: [
            { id: 'u2', role: 'user', content: 'cont', createdAt: 250 },
            { id: 'a2', role: 'assistant', content: 'old branch', createdAt: 260, usage: usage(40, 6), model: 'deepseek-flash' },
          ]},
          null,
        ]},
    ],
  }];
  let s = U.backfill(U.emptyState(), convs);
  assert.ok(s.backfilled);
  assert.strictEqual(s.log.length, 3); // v1, branch a2, current a1
  const prompts = s.log.map(e => e.prompt).sort((a, b) => a - b);
  assert.deepStrictEqual(prompts, [20, 30, 40]);
  // 再回填不变
  const s2 = U.backfill(s, convs);
  assert.strictEqual(s2.log.length, 3);
  // 直播再记同一 key 不增加
  const again = U.makeEntry({ usage: usage(30, 5, 10, 20), at: 300, msgId: 'a1',
    key: 'bf:a1:300:30:5:chat' });
  const s3 = U.record(s2, again);
  assert.strictEqual(s3.log.length, 3);
});
test('日期范围 preset 与 clear / CSV', () => {
  const now = Date.parse('2026-10-05T15:00:00+08:00');
  assert.strictEqual(U.rangeOf('today', now).from, new Date(now).setHours(0, 0, 0, 0));
  const r7 = U.rangeOf('7d', now);
  assert.ok(r7.to - r7.from >= 6 * 864e5);
  let s = U.emptyState();
  s = U.record(s, U.makeEntry({ usage: usage(10, 1), at: now, key: 'z', model: 'deepseek-flash', providerName: 'DeepSeek', convTitle: '测' }));
  const csv = U.toCSV(s.log);
  assert.ok(csv.includes('输入') && csv.includes('DeepSeek'));
  s = U.clear(s);
  assert.strictEqual(s.log.length, 0);
  assert.ok(s.backfilled);
});
