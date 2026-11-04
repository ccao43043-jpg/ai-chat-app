// 好感度 / 心情插件（A6）：解析 / 剥离 / 衰减 / 饱和与日帽 / 护栏 soft / 滞回 / 注入零侵入 / 漏标补偿 / turn 时钟
const test = require('node:test');
const assert = require('node:assert');
globalThis.Plugins = require('../app/src/main/assets/www/plugins.js');
const A = require('../app/src/main/assets/www/affect.js');
const T0 = new Date(2026, 10, 3, 10, 0, 0).getTime();
const LEGACY = { estimator: 'legacy' };
const H = 3600e3, D = 86400e3;

test('常量钉死', () => {
  assert.strictEqual(A.BASE_AFF, 0.30); assert.strictEqual(A.AFF_HALF_LIFE, 3 * 86400); assert.strictEqual(A.MOOD_HALF_LIFE, 3600);
  assert.strictEqual(A.AFF_HALF_LIFE_TURN, 300); assert.strictEqual(A.MOOD_HALF_LIFE_TURN, 8);
  assert.deepStrictEqual(A.BASE_VEC, { val: 0, aro: 0.2 }); assert.strictEqual(A.DAILY_GAIN_CAP, 0.15); assert.strictEqual(A.HYS, 0.12);
  assert.deepStrictEqual(A.DELTA, { '-2': -0.12, '-1': -0.05, '0': 0, '1': 0.04, '2': 0.08 });
  assert.deepStrictEqual([0, 0.15, 0.35, 0.55, 0.75, 1].map(A.tier), [1, 2, 3, 4, 5, 5]);
  assert.deepStrictEqual(A.TIER_LABELS, { 1: '疏远', 2: '戒备', 3: '熟悉', 4: '亲近', 5: '亲密' });
});

test('parseState：取最后一个、校验 a/m、非法返回 null', () => {
  assert.deepStrictEqual(A.parseState('嗯嗯\n<state>{"a":1,"m":"开心"}</state>'), { a: 1, m: '开心' });
  assert.deepStrictEqual(A.parseState('<state>{"a":0,"m":"平静"}</state>x\n<state>{"a":"-2","m":"愤怒"}</state>'), { a: -2, m: '愤怒' });
  assert.deepStrictEqual(A.parseState('<state>{"a":5,"m":"困"}</state>'), { a: 2, m: null });
  assert.strictEqual(A.parseState('<state>oops</state>'), null);
  assert.strictEqual(A.parseState('无标签'), null);
});

test('stripState：剥离完整行、流式未闭合尾巴、parts 数组', () => {
  assert.strictEqual(A.stripState('你好呀～\n<state>{"a":1,"m":"开心"}</state>\n'), '你好呀～');
  assert.strictEqual(A.stripState('正在说\n<state>{"a":1,'), '正在说');
  assert.strictEqual(A.stripState('无标签 '), '无标签 ');
  assert.deepStrictEqual(A.stripContent([{ type: 'text', text: 'a\n<state>{"a":0,"m":"平静"}</state>' }, { type: 'image_url', image_url: 'x' }]),
    [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: 'x' }]);
});

test('衰减：好感 3 天半衰回 0.30；心情 1 小时半衰回 (0,0.20)', () => {
  const s = A.decay({ v: 1, aff: 0.9, vec: { val: 0.6, aro: 0.6 }, mood: '开心', ts: T0 }, T0 + 3 * D);
  assert.strictEqual(s.aff, 0.6);
  const m = A.decay({ v: 1, aff: 0.3, vec: { val: 0.6, aro: 0.6 }, mood: '开心', ts: T0 }, T0 + H);
  assert.deepStrictEqual(m.vec, { val: 0.3, aro: 0.4 });
  assert.strictEqual(A.decay(null, T0).aff, 0.3);
});

test('饱和 + 不对称 + 日上限（本地自然日）', () => {
  let s = A.step(null, { a: 1, m: '开心' }, '谢谢你', T0, LEGACY);
  assert.strictEqual(s.aff, 0.34);                               // aff=0.3 时 ×1
  const hi = A.step({ v: 1, aff: 0.9, vec: { val: 0, aro: 0.2 }, mood: '平静', ts: T0 }, { a: 1, m: '开心' }, '嗯', T0, LEGACY);
  assert.ok(hi.aff - 0.9 < 0.01);                                // 高好感正向变难
  const neg = A.step(null, { a: -1, m: '不悦' }, '嗯', T0, LEGACY);
  assert.strictEqual(neg.aff, r(0.3 - 0.05 * 1.25));             // 负向 ×1.25
  s = null; for (let i = 0; i < 10; i++) s = A.step(s, { a: 2, m: '开心' }, '爱你', T0 + i * 1000, LEGACY);
  assert.ok(Math.abs(s.aff - 0.45) < 1e-3 && Math.abs(s.g.net - 0.15) < 1e-3, JSON.stringify(s)); // 日帽 0.15
  const nx = A.step(s, { a: 2, m: '开心' }, '爱你', T0 + D, LEGACY);    // 次日帽子重置
  assert.ok(nx.aff > s.aff - 0.01 && nx.g.day !== s.g.day);
});
function r(x) { return Math.round(x * 1e4) / 1e4; }

test('护栏：辱骂 soft（模型 a≥0）；boundary 仍强制；missing 时辱骂仍强制', () => {
  const ab = A.step(null, { a: 2, m: '开心' }, '你个白痴', T0, LEGACY);
  assert.strictEqual(ab.a, 2); assert.strictEqual(ab.m, '开心'); assert.ok(ab.g.guard.includes('abuse_soft'));
  const bd = A.step(null, { a: 0, m: '平静' }, '发裸照', T0, LEGACY);
  assert.strictEqual(bd.a, -2); assert.strictEqual(bd.m, '愤怒'); assert.ok(bd.g.guard.includes('boundary'));
  const up = A.step(null, { a: 2, m: '开心' }, '今天天气如何', T0, LEGACY);
  assert.strictEqual(up.a, 1); assert.ok(up.g.guard.includes('a2_unfounded'));
  assert.strictEqual(A.step(null, { a: 2, m: '开心' }, '你真棒，爱你', T0, LEGACY).a, 2);
  // missing_state：无模型自报 → 辱骂仍强制
  const missAb = A.step(null, null, '傻逼', T0, LEGACY);
  assert.ok(['guard', 'missing_state+guard', 'missing_state+guard+kf'].includes(missAb.p), missAb.p);
  assert.strictEqual(missAb.a, -1);
  assert.ok(missAb.g.guard.includes('abuse'));
  // 模型自报已负向：仍记 abuse（非 soft）
  const alreadyNeg = A.guard(-1, '不悦', '你个白痴');
  assert.strictEqual(alreadyNeg.a, -1); assert.ok(alreadyNeg.hit.includes('abuse'));
});

test('心情：惯性 + 滞回', () => {
  const s = A.step(null, { a: 0, m: '开心' }, '', T0, LEGACY);
  assert.deepStrictEqual(s.vec, { val: 0.3, aro: 0.325 });
  // 处于开心/平静中间附近时，不轻易切换
  assert.strictEqual(A.classify({ val: 0.28, aro: 0.31 }, '开心'), '开心');
  assert.strictEqual(A.classify({ val: 0.28, aro: 0.31 }, '平静'), '平静');
  assert.strictEqual(A.classify({ val: 0.6, aro: 0.45 }, '平静'), '开心');
});

test('A6(b) relation 标签与 renderTag；协议拆分', () => {
  const st = { aff: 0.6, mood: '开心' }; // tier 4 → 亲近
  assert.strictEqual(A.tier(0.6), 4);
  assert.strictEqual(A.relationOf(st), '亲近');
  assert.strictEqual(A.renderTag(st), '[AFFECT] mood=开心 relation=亲近');
  assert.strictEqual(A.renderInjection(st), A.renderTag(st));
  assert.ok(!A.renderTag(st).includes('aff_tier'));
  const proto = A.fixedProtocol();
  assert.ok(proto.includes('[AFFECT_RULE]'));
  assert.ok(proto.includes('疏远') && proto.includes('亲密'));
  assert.ok(proto.includes('<state>') && proto.includes('"why"'));
  assert.ok(!/\d\.\d/.test(A.renderTag({ aff: 0.4123, mood: '开心' }))); // 无浮点
});

test('注入：只改本轮 user 开头短 tag；历史 assistant 剥离 state', () => {
  const u1 = { id: 'u1', role: 'user', content: '早' }, b1 = { id: 'b1', role: 'assistant', content: '早呀\n<state>{"a":1,"m":"开心"}</state>' };
  const u2 = { id: 'u2', role: 'user', content: '在吗' };
  const msgs = [u1, b1, u2].map(m => Object.assign({}, m, { _src: m }));
  const out = A.applyToMessages(msgs, u2, '[AFFECT] mood=开心 relation=戒备');
  assert.strictEqual(out[0].content, '早');
  assert.strictEqual(out[1].content, '早呀');
  assert.ok(out[2].content.startsWith('[AFFECT] mood=开心 relation=戒备\n在吗'));
  assert.ok(!out[2].content.includes('AFFECT_RULE'));
});

test('插件钩子：固定协议进 system、user 头仅一行、写 bot.affect、徽章用 relation', async () => {
  const pl = Plugins.registry.get('affect'); assert.ok(pl && pl.defaultEnabled);
  const u1 = { id: 'u1', role: 'user', content: '谢谢你' };
  const conv = { id: 'c', messages: [u1] };
  const ctx = { conv, settings: {}, systemPrompt: 'SYS', lastUser: u1, meta: {}, messages: [Object.assign({}, u1, { _src: u1 })], opts: {} };
  const r = await Plugins.registry.runBeforeRequest(ctx, null);
  assert.ok(String(r.systemPrompt).startsWith('SYS'));
  assert.ok(String(r.systemPrompt).includes('[AFFECT_RULE]'));
  assert.ok(String(r.systemPrompt).includes('疏远'));
  assert.ok(r.messages[0].content.startsWith('[AFFECT] mood=平静 relation=戒备\n谢谢你'));
  assert.ok(!r.messages[0].content.includes('AFFECT_RULE'));
  const inj = u1.affectInj; assert.strictEqual(inj, '[AFFECT] mood=平静 relation=戒备');
  assert.ok(!String(inj).includes('AFFECT_RULE') && !String(inj).includes('AFFECT_REMIND'));
  const r2 = await Plugins.registry.runBeforeRequest(Object.assign({}, ctx, { messages: [Object.assign({}, u1, { _src: u1 })], meta: {}, systemPrompt: 'SYS' }), null);
  assert.strictEqual(r2.messages[0].content, r.messages[0].content); // 重新生成字节不变
  const bot = { id: 'b', role: 'assistant', content: '不客气～\n<state>{"a":1,"m":"开心"}</state>' };
  conv.messages.push(bot);
  let saved = 0;
  const host = { saveConv: () => saved++, openPanel() {} };
  Plugins.registry.runAfterResponse(r, { ok: true, bot }, host);
  assert.strictEqual(bot.content, '不客气～');
  assert.strictEqual(bot.affect.v, 1); assert.strictEqual(bot.affect.a, 1); assert.strictEqual(bot.affect.m, '开心'); assert.strictEqual(saved, 1);
  const hb = pl.hooks.headerBadges(conv, host);
  assert.strictEqual(hb[0].kind, 'mood');
  assert.ok(/^(平静|开心) · (疏远|戒备|熟悉|亲近|亲密)$/.test(hb[0].text), hb[0].text);
  assert.deepStrictEqual(pl.hooks.headerBadges({ messages: [] }, host), []);
});

test('A6(c) 漏标≥3：最近 K 条示范 state；强提醒不进 affectInj', async () => {
  const msgs = [];
  for (let i = 0; i < 5; i++) {
    msgs.push({ id: 'u' + i, role: 'user', content: 'hi' + i });
    const miss = i < 3; // 前 3 条漏标
    msgs.push({
      id: 'b' + i, role: 'assistant', content: 'reply' + i,
      affect: miss
        ? { v: 1, aff: 0.3, mood: '平静', a: null, m: null, stateMissing: true, p: 'missing_state', ts: T0 }
        : { v: 1, aff: 0.4, mood: '开心', a: 1, m: '开心', stateMissing: false, p: 'model', ts: T0, why: '谢谢' }
    });
  }
  // 再补 2 条有效，使近 10 里 missing=3
  const conv = { id: 'c', messages: msgs };
  const st = A.missingStats(conv);
  assert.strictEqual(st.missing, 3);
  assert.ok(A.shouldDemoState(conv));
  const lastU = { id: 'uN', role: 'user', content: '继续' };
  const wire = msgs.concat([lastU]).map(m => Object.assign({}, m, { _src: m }));
  const tag = '[AFFECT] mood=开心 relation=熟悉';
  const out = A.applyToMessages(wire, lastU, tag, { demoState: true, remind: A.STRONG_REMIND });
  // 最近 K=3 条「有效且非 missing」应带重建 state；本会话有效的是 b3,b4（只有 2 条）
  const asst = out.filter(m => m.role === 'assistant');
  const withDemo = asst.filter(m => String(m.content).includes('<state>'));
  assert.ok(withDemo.length >= 1 && withDemo.length <= 3);
  assert.ok(withDemo.every(m => /<state>\{"a":1,"m":"开心"/.test(m.content)));
  // 漏标的仍剥离（无 state）
  assert.ok(asst.filter(m => m.id === 'b0' || m.id === 'b1' || m.id === 'b2').every(m => !String(m.content).includes('<state>')));
  // 本轮 user：tag + 强提醒；remind 不进冻结字段
  assert.ok(out[out.length - 1].content.startsWith(tag + '\n' + A.STRONG_REMIND));
  assert.ok(!lastU.affectInj);

  // 钩子路径：remind 不写入 affectInj
  const u1 = { id: 'ux', role: 'user', content: '下轮' };
  conv.messages.push(u1);
  const ctx = { conv, settings: {}, systemPrompt: 'SYS', lastUser: u1, meta: {}, messages: conv.messages.map(m => Object.assign({}, m, { _src: m })), opts: {} };
  const r = await Plugins.registry.runBeforeRequest(ctx, null);
  assert.strictEqual(u1.affectInj, A.renderTag(A.decay(A.latest(conv), Date.now())));
  assert.ok(!String(u1.affectInj).includes('AFFECT_REMIND'));
  assert.ok(r.messages[r.messages.length - 1].content.includes('AFFECT_REMIND'));
});

test('A6(a) turn 时钟：隔很久墙钟几乎不衰减；wall 仍按时间', () => {
  const prev = { v: 1, aff: 0.9, vec: { val: 0.6, aro: 0.6 }, mood: '开心', ts: T0, turn: 10 };
  const wall = A.decay(prev, T0 + 3 * D, { clock: 'wall' });
  assert.strictEqual(wall.aff, 0.6); // 3 天半衰
  const turnSame = A.decay(prev, T0 + 30 * D, { clock: 'turn', turn: 10 });
  assert.strictEqual(turnSame.aff, 0.9); // 同轮不衰减
  const turn1 = A.decay(prev, T0 + 30 * D, { clock: 'turn', turn: 11 });
  assert.ok(Math.abs(turn1.aff - 0.9) < 0.01, 'turn+1 几乎不衰减 aff=' + turn1.aff);
  const turnMood = A.decay(prev, T0 + 30 * D, { clock: 'turn', turn: 10 + 8 });
  assert.ok(Math.abs(turnMood.vec.val - 0.3) < 1e-3, 'mood 8 轮半衰');
  // step 记录 turn
  const s = A.step(prev, { a: 0, m: '平静' }, '嗯', T0 + 30 * D, { clock: 'turn', turn: 11, estimator: 'legacy' });
  assert.strictEqual(s.turn, 11);
  // clockOf：显式覆盖 / RP 默认 turn
  assert.strictEqual(A.clockOf({ affectClock: 'turn' }), 'turn');
  assert.strictEqual(A.clockOf({ affectClock: 'wall' }), 'wall');
  assert.strictEqual(A.clockOf({ plugins: { rpcache: {} } }), 'turn');
  assert.strictEqual(A.clockOf({}), 'wall');
  assert.strictEqual(A.clockOf({}, { rp: { skipped: false } }), 'turn');
});

test('A6(e) missingStats / guardStats / rebuildStateTag', () => {
  const conv = { messages: [
    { role: 'assistant', affect: { a: 1, m: '开心', stateMissing: false, p: 'model', g: { guard: ['abuse_soft', 'why:0.50'] } } },
    { role: 'assistant', affect: { a: null, stateMissing: true, p: 'missing_state', g: { guard: [] } } },
    { role: 'assistant', affect: { a: -2, m: '愤怒', p: 'model+guard', g: { guard: ['boundary'] } } },
  ]};
  const ms = A.missingStats(conv);
  assert.strictEqual(ms.total, 3); assert.strictEqual(ms.missing, 1);
  const gs = A.guardStats(conv);
  assert.strictEqual(gs.softCount, 1); assert.strictEqual(gs.hardCount, 1);
  assert.strictEqual(A.rebuildStateTag({ a: 1, m: '开心', why: '谢' }), '<state>{"a":1,"m":"开心","why":"谢"}</state>');
  assert.strictEqual(A.rebuildStateTag({ a: null, stateMissing: true }), '');
});
