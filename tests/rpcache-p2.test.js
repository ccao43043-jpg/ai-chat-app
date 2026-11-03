// v0.8.9 P2：增量指纹 / Token 估算缓存 / fallbackTrim 二分（docs/plugins/plugin-optimization.md 4.2 / 4.3）
const test = require('node:test');
const assert = require('node:assert');
const R = require('../app/src/main/assets/www/rpcache.js');
const B = require('./bench/rpcache-core.bench.js');

const conv = (n, len) => Array.from({ length: n }, (_, i) => ({ id: 'x' + i, role: i % 2 ? 'assistant' : 'user', content: '剧情推进 story ' + i + ' '.repeat(i % 7) + '字'.repeat(len + (i * 37) % 200) }));

test('P2 history_hash：SAME / APPEND / CHANGED 判定与旧语义一致', () => {
  const st = R.normalizeState(null);
  const a = R.fingerprints(R.plan(st, '', conv(10, 50)), '');
  const pb = R.plan(st, '', conv(12, 50)), b = R.fingerprints(pb, '');
  assert.ok(a.history_hash.startsWith('c:'));
  assert.strictEqual(R.diagnose(a, R.fingerprints(R.plan(st, '', conv(10, 50)), ''), []).history, 'SAME');
  assert.strictEqual(R.diagnose(a, b, pb.hist).history, 'APPEND');
  const edited = conv(12, 50); edited[2] = Object.assign({}, edited[2], { content: '改过了' });
  const pc = R.plan(st, '', edited);
  assert.strictEqual(R.diagnose(a, R.fingerprints(pc, ''), pc.hist).history, 'CHANGED');
});

test('P2 旧日志（SHA-256 history_hash）仍可判定 APPEND', () => {
  const st = R.normalizeState(null);
  const p0 = R.plan(st, '', conv(10, 30));
  const legacy = Object.assign({}, R.fingerprints(p0, ''), { history_hash: R.sha256(R.serializeHistory(p0.hist)) });
  const p1 = R.plan(st, '', conv(12, 30));
  assert.strictEqual(R.diagnose(legacy, R.fingerprints(p1, ''), p1.hist).history, 'APPEND');
});

test('P2 digest 缓存：同 id 内容变化会重新计算', () => {
  const h1 = [{ id: 'k', role: 'user', content: 'A' }], h2 = [{ id: 'k', role: 'user', content: 'B' }];
  assert.notStrictEqual(R.historyPrefixes(h1).pop(), R.historyPrefixes(h2).pop());
  assert.strictEqual(R.estimateItems([{ id: 'q', role: 'user', content: '字字字字字' }]), R.estimateTokens('字字字字字') + 4);
  assert.strictEqual(R.estimateItems([{ id: 'q', role: 'user', content: 'ab' }]), R.estimateTokens('ab') + 4);
});

function linearTrim(st, p) {
  const keep = Math.max(1, st.settings.summary.keep_recent_turns | 0), k = p.calib || 1, un = p.unsummarized;
  const users = []; un.forEach((m, i) => { if (m.role === 'user') users.push(i); });
  let j = Math.max(0, users.length - keep);
  const fixed = p.tokens.total - p.tokens.history;
  const est = it => it.reduce((n, m) => n + R.estimateTokens(m.content) + 4 + (m.images ? m.images.length * 1000 : 0), 0);
  while (j < users.length - 1 && fixed + est(un.slice(users[j])) * k > p.limit) j++;
  const s = users.length ? users[j] : 0;
  return un[s] ? { startId: un[s].id, startOrdinal: s } : st.window;
}

test('P2 fallbackTrim 二分与原线性扫描结果一致（随机）', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let t = 0; t < 60; t++) {
    const st = R.normalizeState(null);
    st.settings.summary.enabled = false;
    st.settings.max_context = 2000 + Math.floor(rnd() * 20000); st.settings.output_reserve = 500; st.settings.safety_margin = 100;
    st.settings.summary.keep_recent_turns = 1 + Math.floor(rnd() * 6);
    if (rnd() < 0.5) st.calib = 0.5 + rnd() * 2;
    const p = R.plan(st, '设定', conv(10 + Math.floor(rnd() * 120), 20 + Math.floor(rnd() * 300)));
    assert.deepStrictEqual(R.fallbackTrim(st, p).window, linearTrim(st, p), 'case ' + t);
  }
});

test('P2 性能回归：600 条消息请求核心稳态 < 10ms（桌面 Node）', () => {
  const r = B.run(600, 10);
  assert.strictEqual(r.diag, 'APPEND');
  assert.ok(r.ms < 10, 'core ' + r.ms.toFixed(2) + 'ms');
});
