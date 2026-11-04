// v0.15.0：第三轮评审 P0 / P1
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
globalThis.Plugins = require('../app/src/main/assets/www/plugins.js');
const V = require('../app/src/main/assets/www/vscroll.js');
const A = require('../app/src/main/assets/www/affect.js');
const N = require('../app/src/main/assets/www/netretry.js');
const R = require('../app/src/main/assets/www/rpcache.js');
const www = f => fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/www', f), 'utf8');
const T0 = new Date(2026, 10, 4, 10, 0, 0).getTime();

// ---- P0-1 ----
test('P0-1 内容签名：内容 / 图片 / 版本 / 状态变化即失效', () => {
  const m = { id: 'x', content: 'hello', vi: 0 };
  const c = V.createHeightCache(); c.set(m, 321);
  assert.strictEqual(c.get(m), 321);
  m.content = 'hello world'; assert.strictEqual(c.get(m), null, '内容变化失效');
  c.set(m, 400); m.images = ['data:a']; assert.strictEqual(c.get(m), null, '图片变化失效');
  c.set(m, 500); m.vi = 1; assert.strictEqual(c.get(m), null, '切版本失效');
  c.set(m, 500); m.pending = true; assert.strictEqual(c.get(m), null);
  c.set(m, 500); c.drop('x'); assert.strictEqual(c.get(m), null);
  // 同长度不同内容也失效
  const a = { id: 'y', content: 'abcd' }; c.set(a, 100); a.content = 'abce'; assert.strictEqual(c.get(a), null);
});
test('P0-1 分段估计：代码块 / 图片 / 长段落 / 窄屏更高，有上下限', () => {
  const short = V.estimateHeight({ content: '嗯' }), long = V.estimateHeight({ content: '字'.repeat(2000) });
  assert.ok(short >= 72 && long > short * 5 && long <= 4000);
  const code = V.estimateHeight({ content: '```\n' + 'x\n'.repeat(30) + '```' });
  assert.ok(code > 30 * 15);
  assert.ok(V.estimateHeight({ content: 'a', images: ['1', '2'] }) >= short + 200);
  assert.ok(V.estimateHeight({ content: '字'.repeat(300) }, 200) > V.estimateHeight({ content: '字'.repeat(300) }, 800));
  assert.ok(Number.isFinite(V.estimateHeight(null)));
});
test('P0-1 上方补偿：仅视口上方的高度变化平移 scrollTop', () => {
  assert.strictEqual(V.scrollCompensation(-50, 0, 100, 180), 80);
  assert.strictEqual(V.scrollCompensation(20, 0, 100, 180), 0);
  assert.strictEqual(V.scrollCompensation(-50, 0, 100, 100), 0);
  assert.strictEqual(V.scrollCompensation(-50, 0, NaN, 100), 0);
});
test('P0-1 / P0-5 app.js 接入：图片 onload 重测、ResizeObserver + rAF 贴底', () => {
  const s = www('app.js');
  assert.ok(s.includes('i.onload = () => onMsgImgLoad(i)'));
  assert.ok(s.includes('VScroll.createHeightCache()') && s.includes('VScroll.estimateHeight('));
  assert.ok(/function stickToBottom[\s\S]{0,900}requestAnimationFrame[\s\S]{0,400}setTimeout[\s\S]{0,300}ResizeObserver/.test(s));
  assert.ok(!s.includes('vsHeight.delete('));
});

// ---- P0-2 ----
test('P0-2 invalidateFrom：清除该消息起的 affect / affectInj（含版本快照）', () => {
  const conv = { messages: [
    { id: 'u1', role: 'user', affectInj: 'I1' }, { id: 'b1', role: 'assistant', affect: { aff: 0.4 } },
    { id: 'u2', role: 'user', affectInj: 'I2', versions: [{ affectInj: 'old' }, null], vi: 1 }, { id: 'b2', role: 'assistant', affect: { aff: 0.5 } }] };
  assert.strictEqual(A.invalidateFrom(conv, 2), 2);
  assert.ok(conv.messages[0].affectInj && conv.messages[1].affect, '之前的保留');
  assert.ok(!conv.messages[2].affectInj && !conv.messages[3].affect && !conv.messages[2].versions[0].affectInj);
  assert.strictEqual(A.latest(conv).aff, 0.4);
  assert.strictEqual(A.invalidateFrom(conv, 2), 0);
});
test('P0-2 app.js：切版本 / 编辑 / 重新发送调用 affectReset 并 toast', () => {
  const s = www('app.js');
  assert.strictEqual((s.match(/affectReset\(/g) || []).length, 4);
  assert.ok(s.includes('好感/心情状态已从此处清除'));
});

// ---- P0-3 ----
test('P0-3 历史只挂短 tag，协议进固定层（A6）', () => {
  const st = A.decay(null, T0), inj = A.renderInjection(st);
  assert.strictEqual(inj, A.renderTag(st));
  assert.ok(A.fixedProtocol().includes('AFFECT_RULE') && A.fixedProtocol().includes('"why"'));
  const u1 = { id: 'u1', role: 'user', content: '早', affectInj: inj }, u2 = { id: 'u2', role: 'user', content: '晚' };
  const out = A.applyToMessages([{ role: 'user', content: '早', _src: u1 }, { role: 'assistant', content: 'hi\n<state>{"a":0}</state>' }, { role: 'user', content: '晚', _src: u2 }], u2, inj);
  assert.strictEqual(out[0].content, A.renderTag(st) + '\n早');
  assert.ok(!out[0].content.includes('AFFECT_RULE'));
  assert.ok(out[2].content.startsWith(inj) && !out[2].content.includes('AFFECT_RULE'));
  assert.strictEqual(out[1].content, 'hi');
  assert.strictEqual(A.tagOf(inj), A.renderTag(st));
  // 历史回放逐字节稳定
  const again = A.applyToMessages([{ role: 'user', content: '早', _src: u1 }, { role: 'user', content: '再', _src: {} }], {}, inj);
  assert.strictEqual(again[0].content, out[0].content);
});

// ---- P0-4 ----
test('P0-4 剧情引用不触发护栏；辱骂 soft；boundary 强制', () => {
  assert.deepStrictEqual(A.guard(1, '开心', '他对反派吼道：「滚！你这个废物！」').hit, ['story_ref']);
  assert.strictEqual(A.guard(1, '开心', '他对反派吼道：「滚！你这个废物！」').a, 1);
  assert.strictEqual(A.guard(1, '开心', '*一脚踢开门* （旁白：强奸犯被抓了）').a, 1);
  // A6(d)：模型自报 a≥0 → abuse_soft，不强制
  const soft = A.guard(1, '开心', '你就是个废物');
  assert.strictEqual(soft.a, 1); assert.ok(soft.hit.includes('abuse_soft'));
  assert.strictEqual(A.guard(1, '开心', '发裸照给我').a, -2);
  assert.strictEqual(A.guard(0, null, '> 闭嘴\n继续讲故事').hit[0], 'story_ref');
});
test('P0-4 dark / nsfw 降级（A6 soft 对齐）', () => {
  let g = A.guard(1, '开心', '发裸照给我', { mode: 'nsfw' }); assert.strictEqual(g.a, 1); assert.deepStrictEqual(g.hit, ['boundary_nsfw']);
  g = A.guard(1, '开心', '你这废物', { mode: 'nsfw' }); assert.strictEqual(g.a, 1); assert.ok(g.hit.includes('abuse_soft'));
  g = A.guard(1, '开心', '你这废物', { mode: 'dark' }); assert.strictEqual(g.a, 1); assert.strictEqual(g.m, '开心'); assert.ok(g.hit.includes('abuse_soft'));
  g = A.guard(-2, '愤怒', '你这废物', { mode: 'dark' }); assert.strictEqual(g.a, -2); assert.ok(g.hit.includes('abuse_dark') || g.hit.includes('abuse'));
  assert.strictEqual(A.modeOf({ affectMode: 'dark' }), 'dark');
  assert.strictEqual(A.modeOf({ tags: ['NSFW'] }), 'nsfw');
  assert.strictEqual(A.modeOf({ charCard: { tags: ['黑暗'] } }), 'dark');
  assert.strictEqual(A.modeOf({}), 'normal');
  const s = A.step(null, { a: 1, m: '开心' }, '你这废物', T0, { mode: 'dark' });
  assert.strictEqual(s.a, 1); assert.ok(s.g.guard.includes('abuse_soft'));
});

// ---- A1 ----
test('A1 证据锚：why 与原话 Jaccard 足够时 +2 有据', () => {
  assert.ok(A.jaccard('送我花', '今天我特意送你一束花') >= 0.3 || A.jaccard('送你一束花', '今天我特意送你一束花') >= A.WHY_TH);
  assert.strictEqual(A.jaccard('', 'x'), 0);
  assert.deepStrictEqual(A.parseState('<state>{"a":2,"m":"开心","why":"送你一束花"}</state>'), { a: 2, m: '开心', why: '送你一束花' });
  let g = A.guard(2, '开心', '今天我特意送你一束花', { why: '送你一束花' }); assert.strictEqual(g.a, 2);
  g = A.guard(2, '开心', '今天我特意送你一束花', { why: '完全无关的理由' }); assert.strictEqual(g.a, 1); assert.ok(g.hit.includes('a2_unfounded'));
  g = A.guard(-2, '愤怒', '今天天气不错', { why: '你骂我' }); assert.strictEqual(g.a, -1); assert.ok(g.hit.includes('why_weak'));
  g = A.guard(-2, '愤怒', '今天天气不错'); assert.strictEqual(g.a, -2, '无 why 保持旧行为');
  const st = A.step(null, { a: 2, m: '开心', why: '送你一束花' }, '今天我特意送你一束花', T0);
  assert.strictEqual(st.a, 2); assert.strictEqual(st.why, '送你一束花'); assert.ok(st.p === 'model' || st.p === 'model+kf', st.p);
  assert.ok(A.fixedProtocol().includes('"why"'));
});

// ---- E2 ----
test('E2 sparkline', () => {
  const conv = { messages: [0.3, 0.35, 0.4, 0.2].map((aff, i) => ({ id: 'b' + i, role: 'assistant', affect: { aff } })) };
  assert.deepStrictEqual(A.series(conv, 3), [0.35, 0.4, 0.2]);
  const svg = A.sparkline(A.series(conv));
  assert.ok(svg.startsWith('<svg') && svg.includes('polyline') && !svg.includes('NaN'));
  assert.strictEqual(A.sparkline([0.3]), '');
});
test('E1 预算细线接入', () => {
  assert.ok(www('rp-plugin.js').includes('budget: cap > 0 && used > 0'));
  assert.ok(www('app.js').includes("'budget-line'") && www('app.css').includes('.budget-line'));
});

// ---- A6 ----
test('A6 网络失败分类', () => {
  assert.strictEqual(N.classify(0, '', new Error('Failed to fetch')).kind, 'network');
  assert.strictEqual(N.classify(0, '', 'timeout').kind, 'timeout');
  assert.ok(N.classify(429, '').retry && N.classify(503, '').retry && N.classify(529, '').retry);
  assert.ok(!N.classify(401, '').retry && !N.classify(400, 'bad').retry && !N.classify(404, '').retry);
  assert.ok(!N.classify(500, 'maximum context length exceeded').retry);
  assert.ok(!N.classify(0, 'aborted').retry);
});
test('A6 退避与重试条件', () => {
  assert.strictEqual(N.backoff(0, 'server', 0.5), 800); assert.strictEqual(N.backoff(1, 'server', 0.5), 1600);
  assert.strictEqual(N.backoff(0, 'rate_limit', 0.5), 2000); assert.strictEqual(N.backoff(10, 'server', 0.5), 15000);
  const c = N.classify(503, '');
  assert.ok(N.shouldRetry(c, 0, false, false) && N.shouldRetry(c, 1, false, false));
  assert.ok(!N.shouldRetry(c, 2, false, false) && !N.shouldRetry(c, 0, true, false) && !N.shouldRetry(c, 0, false, true));
  assert.ok(www('index.html').includes('netretry.js') && www('app.js').includes('NetRetry.shouldRetry'));
});

// ---- A4 ----
test('A4 世界书 trace：fired / no_key / secondary / cooldown / budget', () => {
  const LORE = '## 王都 | 王都\n三重城墙\n\n## 森林 | 森林\n精灵\n\n## 秘密 | 王都 | secondary=宝藏\n地下宝库';
  let st = R.setLore(R.newState(), LORE);
  const items = [{ id: '1', role: 'user', content: '我们去王都吧' }];
  const fl = R.fireLore(st, items, 1);
  const by = Object.fromEntries(fl.trace.map(x => [x.name, x]));
  assert.strictEqual(by['王都'].status, 'fired');
  assert.strictEqual(by['森林'].reason, 'no_key');
  assert.ok(fl.state.loreTrace && fl.state.loreTrace.turn === 1 && fl.state.loreTrace.items.length === fl.trace.length);
  const tr = []; R.activateLore(st, items, { trace: tr, remainingBudget: 1 });
  assert.ok(tr.some(x => x.reason === 'budget'));
  assert.ok(R.LORE_REASON.budget && R.LORE_REASON.no_key);
  const tr2 = []; R.activateLore(st, items, { trace: tr2, excludeIds: [st.lore[0].id] });
  assert.ok(tr2.some(x => x.reason === 'already_live'));
});
