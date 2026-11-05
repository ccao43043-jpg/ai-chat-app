// v0.8.9 P1：Hybrid「已发送版本」表按消息身份索引 + 原文 SHA-256/长度校验（docs/plugins/plugin-optimization.md 3.1 / 4.1）
const test = require('node:test');
const assert = require('node:assert');
const G = require('../app/src/main/assets/www/plugins/cache/gcache.js');

function runner(withIds) {
  const hybrid = G.HybridWindow.empty(), hist = [];
  let nid = 0;
  const send = (t, text) => {
    const user = { role: 'user', content: text, id: 'm' + (++nid) };
    const msgs = [{ role: 'system', content: '【角色卡】\n' + '固定设定'.repeat(50) + '\n【当前状态】\n第' + t + '幕' }].concat(hist, [user]);
    const body = JSON.stringify({ model: 'google/gemini-2.5-flash', messages: msgs.map(m => ({ role: m.role, content: m.content })) });
    const extra = { sessionId: 's', hybrid };
    if (withIds) extra.ids = msgs.slice(1).map(m => m.id);
    const r = G.applyToRequest({ body, headers: {} }, { mode: 'auto' }, extra);
    hist.push(user, { role: 'assistant', content: '回复' + t, id: 'm' + (++nid) });
    return JSON.parse(r.req.body).messages;
  };
  return { send, hist, hybrid };
}

for (const withIds of [false, true]) {
  test('P1 三轮「继续」：第 1 条历史在第 2、3 轮一致（' + (withIds ? '传 ids' : '无 id，按序号') + '）', () => {
    const { send } = runner(withIds);
    const m1 = send(1, '继续'), m2 = send(2, '继续'), m3 = send(3, '继续');
    assert.strictEqual(m2[1].content, m3[1].content);
    assert.ok(m2[1].content.includes('第1幕'), '第 1 条历史保留第 1 轮实际送出的动态层');
    assert.ok(m3[3].content.includes('第2幕'));
    assert.strictEqual(m1[m1.length - 1].content, m2[1].content, '与第 1 轮实际送出逐字一致');
    // 第 4 轮：前 3 轮历史前缀完全不变
    const m4 = send(4, '继续');
    assert.deepStrictEqual(m4.slice(0, 5).map(m => m.content).slice(1), m3.slice(1, 5).map(m => m.content).slice(0, 4));
  });
}

test('P1 FNV-32 碰撞对不再串替换', () => {
  const A = '部成大者在的下向 749188119', B = '月天上年如 643993261';
  assert.strictEqual(G.hash(A), G.hash(B), '前提：两串 FNV-32 相同');
  const H = G.HybridWindow, st = H.empty();
  H.recordSent(st, H.sentKey('a', 0), A, '【当前状态】X\n\n' + A);
  // 不同 id、相同哈希：不替换
  assert.strictEqual(H.outbound(st, { role: 'user', content: B }, H.sentKey('b', 1)).content, B);
  // 同 key 但原文变了（哈希碰撞的另一串）：长度/SHA 校验失败 → 不替换
  assert.strictEqual(H.outbound(st, { role: 'user', content: B }, H.sentKey('a', 0)).content, B);
  assert.strictEqual(H.outbound(st, { role: 'user', content: A }, H.sentKey('a', 0)).content, '【当前状态】X\n\n' + A);
});

test('P1 端到端：历史里碰撞串不会被换成另一条的已发送版本', () => {
  const { send } = runner(false);
  send(1, '部成大者在的下向 749188119');
  const m = send(2, '月天上年如 643993261');
  const m3 = send(3, '继续');
  assert.ok(m3[3].content.endsWith('月天上年如 643993261') && m3[3].content.includes('第2幕'));
  assert.ok(m3[1].content.includes('第1幕') && m3[1].content.endsWith('749188119'));
  assert.ok(m);
});

test('P1 旧版字符串条目加载时丢弃', () => {
  const st = { v: 1, cut: 0, summaries: [], sent: { '1a2b3c4d': '旧值' } };
  G.HybridWindow.apply([], st);
  assert.deepStrictEqual(st.sent, {});
});

test('P2 L0 含 ASCII 双引号 / 反斜杠的设定行不误报缺失', () => {
  const entries = [{ text: '她说："不要回头"' }, { text: '路径 C:\\data' }];
  const body = JSON.stringify({ messages: [{ role: 'system', content: entries.map(e => e.text).join('\n') }] });
  assert.strictEqual(G.MemoryManager.missingL0(entries, body).length, 0);
  assert.strictEqual(G.MemoryManager.missingL0([{ text: '不存在的设定' }], body).length, 1);
});

test('P1：batchFp 为 SHA-256；冻结批次改一个字符即作废摘要；旧 FNV 指纹平滑升级', () => {
  const H = G.HybridWindow;
  const hist = [];
  for (let i = 0; i < H.RAW_MAX + 2; i++) hist.push({ role: 'user', content: '张燕追问第' + i + '条线索，决定把证据交给曹含森。' }, { role: 'assistant', content: '曹含森点头。他不知道密道已暴露。回答' + i + '。' });
  const st = H.empty();
  const r1 = H.apply(hist, st);
  assert.ok(r1.summaryCreated && st.summaries.length);
  assert.match(st.summaries[0].fp, /^sha256:[0-9a-f]{64}$/);
  // 未修改：复用
  assert.strictEqual(H.apply(hist, st).prefixChanged, false);
  // 改一个字符：作废后重建（文本更新）
  const edited = hist.map(m => Object.assign({}, m)); edited[0].content = '张燕改口，把线索X交给李明。';
  const r2 = H.apply(edited, st);
  assert.strictEqual(r2.prefixChanged, true);
  assert.ok(/线索X|李明/.test(st.summaries[0].text));
  // 旧版 8 位 FNV 指纹：内容一致时升级而不作废
  const st2 = H.empty(); H.apply(hist, st2);
  const batch = H.splitTurns(hist).slice(st2.summaries[0].from, st2.summaries[0].to);
  st2.summaries[0].fp = G.hash(batch.flat().map(m => m.role + ':' + m.content).join('\n'));
  assert.strictEqual(H.apply(hist, st2).prefixChanged, false);
  assert.match(st2.summaries[0].fp, /^sha256:/);
});
