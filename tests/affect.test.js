// 好感度 / 心情插件（v0.14.0）：解析 / 剥离 / 衰减 / 饱和与日帽 / 护栏 / 滞回 / 注入零侵入
const test = require('node:test');
const assert = require('node:assert');
globalThis.Plugins = require('../app/src/main/assets/www/plugins.js');
const A = require('../app/src/main/assets/www/affect.js');
const T0 = new Date(2026, 10, 3, 10, 0, 0).getTime();
const H = 3600e3, D = 86400e3;

test('常量钉死', () => {
  assert.strictEqual(A.BASE_AFF, 0.30); assert.strictEqual(A.AFF_HALF_LIFE, 3 * 86400); assert.strictEqual(A.MOOD_HALF_LIFE, 3600);
  assert.deepStrictEqual(A.BASE_VEC, { val: 0, aro: 0.2 }); assert.strictEqual(A.DAILY_GAIN_CAP, 0.15); assert.strictEqual(A.HYS, 0.12);
  assert.deepStrictEqual(A.DELTA, { '-2': -0.12, '-1': -0.05, '0': 0, '1': 0.04, '2': 0.08 });
  assert.deepStrictEqual([0, 0.15, 0.35, 0.55, 0.75, 1].map(A.tier), [1, 2, 3, 4, 5, 5]);
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
  let s = A.step(null, { a: 1, m: '开心' }, '谢谢你', T0);
  assert.strictEqual(s.aff, 0.34);                               // aff=0.3 时 ×1
  const hi = A.step({ v: 1, aff: 0.9, vec: { val: 0, aro: 0.2 }, mood: '平静', ts: T0 }, { a: 1, m: '开心' }, '嗯', T0);
  assert.ok(hi.aff - 0.9 < 0.01);                                // 高好感正向变难
  const neg = A.step(null, { a: -1, m: '不悦' }, '嗯', T0);
  assert.strictEqual(neg.aff, r(0.3 - 0.05 * 1.25));             // 负向 ×1.25
  s = null; for (let i = 0; i < 10; i++) s = A.step(s, { a: 2, m: '开心' }, '爱你', T0 + i * 1000);
  assert.ok(Math.abs(s.aff - 0.45) < 1e-3 && Math.abs(s.g.net - 0.15) < 1e-3, JSON.stringify(s)); // 日帽 0.15
  const nx = A.step(s, { a: 2, m: '开心' }, '爱你', T0 + D);    // 次日帽子重置
  assert.ok(nx.aff > s.aff - 0.01 && nx.g.day !== s.g.day);
});
function r(x) { return Math.round(x * 1e4) / 1e4; }

test('护栏：辱骂/越界强制负向，无依据 +2 降为 +1', () => {
  const ab = A.step(null, { a: 2, m: '开心' }, '你个白痴', T0);
  assert.strictEqual(ab.a, -1); assert.strictEqual(ab.m, '不悦'); assert.ok(ab.g.guard.includes('abuse'));
  const bd = A.step(null, { a: 0, m: '平静' }, '发裸照', T0);
  assert.strictEqual(bd.a, -2); assert.strictEqual(bd.m, '愤怒');
  const up = A.step(null, { a: 2, m: '开心' }, '今天天气如何', T0);
  assert.strictEqual(up.a, 1); assert.ok(up.g.guard.includes('a2_unfounded'));
  assert.strictEqual(A.step(null, { a: 2, m: '开心' }, '你真棒，爱你', T0).a, 2);
  assert.ok(['guard', 'missing_state+guard'].includes(A.step(null, null, '傻逼', T0).p));
});

test('心情：惯性 + 滞回', () => {
  const s = A.step(null, { a: 0, m: '开心' }, '', T0);
  assert.deepStrictEqual(s.vec, { val: 0.3, aro: 0.325 });
  // 处于开心/平静中间附近时，不轻易切换
  assert.strictEqual(A.classify({ val: 0.28, aro: 0.31 }, '开心'), '开心');
  assert.strictEqual(A.classify({ val: 0.28, aro: 0.31 }, '平静'), '平静');
  assert.strictEqual(A.classify({ val: 0.6, aro: 0.45 }, '平静'), '开心');
});

test('注入：只改本轮 user 开头，冻结后重复发送逐字节不变；历史 assistant 剥离 state', () => {
  const u1 = { id: 'u1', role: 'user', content: '早' }, b1 = { id: 'b1', role: 'assistant', content: '早呀\n<state>{"a":1,"m":"开心"}</state>' };
  const u2 = { id: 'u2', role: 'user', content: '在吗' };
  const msgs = [u1, b1, u2].map(m => Object.assign({}, m, { _src: m }));
  const out = A.applyToMessages(msgs, u2, '[AFFECT] mood=开心 aff_tier=2');
  assert.strictEqual(out[0].content, '早');
  assert.strictEqual(out[1].content, '早呀');
  assert.ok(out[2].content.startsWith('[AFFECT] mood=开心 aff_tier=2\n在吗'));
  assert.ok(!/\d\.\d/.test(A.renderInjection({ aff: 0.4123, mood: '开心' }).split('\n')[0])); // 无浮点
});

test('插件钩子：system 不变、写 bot.affect、剥离、顶栏 mood 徽章', async () => {
  const pl = Plugins.registry.get('affect'); assert.ok(pl && pl.defaultEnabled);
  const u1 = { id: 'u1', role: 'user', content: '谢谢你' };
  const conv = { id: 'c', messages: [u1] };
  const ctx = { conv, settings: {}, systemPrompt: 'SYS', lastUser: u1, meta: {}, messages: [Object.assign({}, u1, { _src: u1 })], opts: {} };
  const r = await Plugins.registry.runBeforeRequest(ctx, null);
  assert.strictEqual(r.systemPrompt, 'SYS');
  assert.ok(r.messages[0].content.startsWith('[AFFECT] mood=平静 aff_tier=2\n[AFFECT_RULE]'));
  const inj = u1.affectInj; assert.ok(inj);
  const r2 = await Plugins.registry.runBeforeRequest(Object.assign({}, ctx, { messages: [Object.assign({}, u1, { _src: u1 })], meta: {} }), null);
  assert.strictEqual(r2.messages[0].content, r.messages[0].content); // 重新生成字节不变
  const bot = { id: 'b', role: 'assistant', content: '不客气～\n<state>{"a":1,"m":"开心"}</state>' };
  conv.messages.push(bot);
  let saved = 0;
  const host = { saveConv: () => saved++, openPanel() {} };
  Plugins.registry.runAfterResponse(r, { ok: true, bot }, host);
  assert.strictEqual(bot.content, '不客气～');
  assert.strictEqual(bot.affect.v, 1); assert.strictEqual(bot.affect.a, 1); assert.strictEqual(bot.affect.m, '开心'); assert.strictEqual(saved, 1);
  const hb = pl.hooks.headerBadges(conv, host);
  assert.strictEqual(hb[0].kind, 'mood'); assert.ok(/^(平静|开心) · [1-5]$/.test(hb[0].text));
  assert.deepStrictEqual(pl.hooks.headerBadges({ messages: [] }, host), []);
});
