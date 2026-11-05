// v0.21.3：P1 本地日期 / P2 时间出固定前缀 / P3 保活公式 / P6 结构化分层
const test = require('node:test');
const assert = require('node:assert');
const W = '../app/src/main/assets/www/';
const TU = require(W + 'timeutil.js');
const S = require(W + 'search.js');
const G = require(W + 'plugins/cache/gcache.js');
const R = require(W + 'rpcache.js');
const T = require(W + 'templates.js');
const P = require(W + 'providers.js');
const fs = require('fs'), path = require('path');
const OR = { type: 'openai', presetId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-x' };

test('P1：localDateStr 按 Asia/Shanghai 计算（UTC 凌晨前一天 → 北京时间当天）', () => {
  const t = new Date('2026-11-05T00:06:00+08:00'); // = 2026-11-04T16:06Z
  assert.strictEqual(t.toISOString().slice(0, 10), '2026-11-04', 'UTC 日期是前一天（旧 bug）');
  assert.strictEqual(TU.localDateStr(t, 'Asia/Shanghai'), '2026-11-05');
  assert.strictEqual(TU.localTimeStr(t, 'Asia/Shanghai'), '00:06');
  assert.strictEqual(TU.zoneLabel(t, 'Asia/Shanghai'), '北京时间');
  assert.ok(TU.nowLine(t, 'Asia/Shanghai').includes('现在是 2026-11-05 00:06（北京时间'));
  assert.match(TU.localDateStr(t), /^\d{4}-\d{2}-\d{2}$/);
});
test('P1：TZ=Asia/Shanghai 进程下搜索「今天」与 Hybrid 摘要 at 为本地日期', () => {
  const { execFileSync } = require('child_process');
  const code = `const S=require(${JSON.stringify(path.resolve(__dirname, W, 'search.js'))});const TU=require(${JSON.stringify(path.resolve(__dirname, W, 'timeutil.js'))});
    const now=new Date('2026-11-05T00:06:00+08:00');process.stdout.write(JSON.stringify([TU.localDateStr(now), S.buildSearchContext([{title:'a',url:'https://a.com',content:'x'}],'q',{now})]));`;
  const [d, ctx] = JSON.parse(execFileSync(process.execPath, ['-e', code], { env: Object.assign({}, process.env, { TZ: 'Asia/Shanghai' }) }).toString());
  assert.strictEqual(d, '2026-11-05');
  assert.ok(ctx.includes('2026-11-05') && !ctx.includes('2026-11-04'));
  const src = ['search.js', 'plugins/cache/gcache.js', 'templates.js'].map(f => fs.readFileSync(path.join(__dirname, W, f), 'utf8')).join('\n');
  assert.ok(!/toISOString\(\)\.slice\(0,\s*10\)/.test(src), '禁止用 UTC 日期当「今天」');
  assert.strictEqual(S.buildSearchContext([{ title: 'a', url: 'https://a.com', content: 'x' }], 'q', { now: new Date('2026-11-05T00:06:00+08:00'), timeZone: 'Asia/Shanghai' }).includes('2026-11-05'), true);
});

test('P2：内置 RP 模板固定 system 不含具体时间；两次套用（不同时刻）字节一致', () => {
  ['t-rp-immersive', 't-rp-longform'].forEach(id => {
    const tpl = T.BUILTIN_TEMPLATES.find(x => x.id === id);
    assert.ok(!/\{\{(date|time|日期|时间)\}\}/.test(tpl.content), id);
    assert.ok(tpl.content.includes(TU.NOW_MARKER), id);
  });
  const imm = T.BUILTIN_TEMPLATES.find(x => x.id === 't-rp-immersive');
  const a = T.applyToConv({}, imm).systemPrompt;
  const realNow = Date.now; Date.now = () => realNow() + 3600e3;
  const b = T.applyToConv({}, imm).systemPrompt; Date.now = realNow;
  assert.strictEqual(a, b);
  // 旧版（v0.21.2）未改过的内置原文 → 升级为新文案
  const old = Object.assign({}, imm, { content: imm.content.replace('现实日期、时间与时区见本轮动态信息（仅供参考）。', '现在是 {{date}} {{time}}（现实时间，仅供参考）。'), builtin: true });
  const up = T.mergeBuiltins([old]).find(x => x.id === 't-rp-immersive');
  assert.strictEqual(up.content, imm.content);
});
test('P2：同一对话两轮仅时间流逝 → static_hash / 固定前缀不变（时间只在 user 尾部）', () => {
  const sys = T.applyToConv({}, T.BUILTIN_TEMPLATES.find(x => x.id === 't-rp-immersive')).systemPrompt;
  const mk = t => [{ role: 'user', content: '你好' + '\n\n' + TU.nowLine(t, 'Asia/Shanghai') }];
  const r1 = G.applyToRequest(P.buildChatRequest(OR, 'google/gemini-2.5-flash', mk(new Date('2026-11-05T00:06:00+08:00')), sys, {}), { mode: 'auto' });
  const r2 = G.applyToRequest(P.buildChatRequest(OR, 'google/gemini-2.5-flash', mk(new Date('2026-11-05T00:19:00+08:00')), sys, {}), { mode: 'auto' });
  assert.strictEqual(r1.prefix, r2.prefix);
  assert.strictEqual(r1.layers.static_hash, r2.layers.static_hash);
  assert.ok(!r1.prefix.includes('00:06'));
});

test('P3：保活净收益按方案 4.3（TTL=240, p=210, N_max=3, r=0.25, q 阶跃）', () => {
  const K = G.KeepAlive;
  const exp = { 120: 0, 230: 0, 240: 0, 260: 0.5, 480: 0.25, 900: 0 };
  Object.keys(exp).forEach(g => assert.ok(Math.abs(K.netForGap(+g, 240, 210, 3, 0.25) - exp[g]) < 1e-9, 'g=' + g + ' → ' + K.netForGap(+g, 240, 210, 3, 0.25)));
  assert.strictEqual(K.pingsForGap(230, 210, 3, 240), 0);
  assert.strictEqual(K.pingsForGap(480, 210, 3, 240), 2);
  assert.strictEqual(K.pingsForGap(900, 210, 3, 240), 0, '覆盖不了不 ping');
  assert.strictEqual(K.recommend([900, 1200, 230], 240, 210, 3, 0.25).net, 0, '不再出现负收益');
});

function rpState(charBody) {
  let st = R.newState();
  st = R.setBlock(st, 'world', '雨港：' + '潮湿的港口城市，'.repeat(200), 1).state;
  st = R.setBlock(st, 'character', charBody, 1).state;
  st = R.setBlock(st, 'rules', '不替玩家行动。', 1).state;
  st = R.setBlock(st, 'style', '冷峻克制。', 1).state;
  st = R.setBlock(st, 'memory', '玩家欠艾琳一个人情。', 1).state;
  return st;
}
const BASE = '你是叙事者。现实日期、时间与时区见本轮动态信息。\n\n【扮演规则】\n- 始终在角色中。';
const CHAR_BAD = '艾琳，女骑士。\n【状态】\n- 左臂旧伤\n【当前场景】\n雨夜码头\n' + '她说话简短，守信，'.repeat(150) + '\n【背景】\n出身北境';
const CHAR_OK = CHAR_BAD.replace(/【(状态|当前场景|背景)】/g, '$1：');

test('P6：buildSystemSegments 与 buildSystem 逐字节一致，记忆为动态层', () => {
  const st = rpState(CHAR_BAD);
  const segs = R.buildSystemSegments(st, BASE);
  assert.strictEqual(segs.map(x => x.text).join('\n\n'), R.buildSystem(st, BASE));
  assert.deepStrictEqual(segs.filter(x => x.kind === 'dynamic').map(x => x.title), ['LONG_TERM_MEMORY']);
  assert.ok(segs.find(x => x.id === 'character').text.includes('【状态】'));
});
test('P6：正文含【状态】【当前场景】时固定段不被误搬；static_hash 与无误判预期一致', () => {
  const run = (charBody, useSeg, extraSys, prev) => {
    const st = rpState(charBody);
    let sys = R.buildSystem(st, BASE); if (extraSys) sys += extraSys;
    const req = P.buildChatRequest(OR, 'google/gemini-2.5-flash-lite', [{ role: 'user', content: '出发' }], sys, {});
    return { r: G.applyToRequest(req, { mode: 'auto', rpGuardrails: 'on' }, { rp: true, prevStaticHash: prev, segments: useSeg ? R.buildSystemSegments(st, BASE) : null }), st };
  };
  // 旧正则路径（回退）：【状态】起整段被当动态层，固定前缀大幅变短——复现 bug
  const legacy = run(CHAR_BAD, false).r;
  const { r, st } = run(CHAR_BAD, true);
  const expected = G.PromptBuilder.RP_ANCHOR + '\n\n' + R.systemStablePrefix(st, BASE);
  assert.ok(legacy.layers.staticText.length < expected.length && !legacy.layers.staticText.includes('她说话简短'), '旧路径误剔');
  assert.strictEqual(r.layers.staticText, expected, '结构化：固定段 = 锚点 + static + 章节');
  assert.ok(r.layers.staticText.includes('【状态】') && r.layers.staticText.includes('[STYLE]'));
  assert.strictEqual(r.layers.dynamicText, R.memoryText(st));
  assert.strictEqual(r.layers.static_hash, G.PromptBuilder.staticHash(expected));
  // 显式断点只切在记忆之前，设定整段写缓存
  const b = JSON.parse(run(CHAR_BAD, true, '', r.layers.static_hash).r.req.body).messages[0].content;
  assert.ok(Array.isArray(b) && b[0].cache_control && b[0].text.includes('[STYLE]') && b[1].text.startsWith('[LONG_TERM_MEMORY]'));
  // 对照：同内容但正文无【】标题 → 两条路径固定前缀长度相当（无误判）
  const ok = run(CHAR_OK, true).r;
  assert.strictEqual(ok.layers.staticText, G.PromptBuilder.RP_ANCHOR + '\n\n' + R.systemStablePrefix(rpState(CHAR_OK), BASE));
  // 尾部被其他插件追加（如 [AFFECT_RULE]）仍算固定层
  const af = run(CHAR_BAD, true, '\n[AFFECT_RULE] x').r;
  assert.ok(af.layers.staticText.endsWith('[AFFECT_RULE] x') && af.layers.staticText.includes('【状态】'));
  // 无分段 → 回退旧正则
  assert.ok(!G.PromptBuilder.layersFromSegments('【世界观】\na\n【当前状态】\nb', null).structured);
});
