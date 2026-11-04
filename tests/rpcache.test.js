// DeepSeek RP 缓存优化器 V1：规范化、版本、六层顺序、状态后置、逐字节稳定前缀、自动摘要、诊断、统计、隐私
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const R = require('../app/src/main/assets/www/rpcache.js');
const P = require('../app/src/main/assets/www/providers.js');

const ds = Object.assign({ apiKey: 'sk' }, P.PRESETS.find(p => p.presetId === 'deepseek'));
const u = (i, t) => ({ id: 'u' + i, role: 'user', content: t || '玩家第' + i + '轮：推开门，观察四周。' });
const a = (i, t) => ({ id: 'a' + i, role: 'assistant', content: t || '角色第' + i + '轮回复：门外是长长的走廊，烛光摇曳。' });
function convo(n) { const out = []; for (let i = 1; i <= n; i++) { out.push(u(i)); if (i < n) out.push(a(i)); } return out; }
function withBlocks(extra) {
  let st = R.newState();
  st = R.setBlock(st, 'world', '这是一个魔法世界。', 1).state;
  st = R.setBlock(st, 'character', '曹含森，23岁，冷静。', 1).state;
  st = R.setBlock(st, 'rules', '1. NPC不能读取玩家内心', 1).state;
  st = R.setBlock(st, 'memory', '张燕尚不知道曹含森拥有特殊魔法能力。', 1).state;
  st = R.setBlock(st, 'state', 'HP: 82/100\nLocation: 王都西区', 1).state;
  return Object.assign(st, extra || {});
}

test('规范化只做安全处理', () => {
  assert.strictEqual(R.canonicalize('\uFEFFa \r\nb\t\r\n\r\n\r\n\r\n\r\n\r\nc  '), 'a\nb\n\n\nc');
  assert.strictEqual(R.canonicalize('一\n\n\n二'), '一\n\n\n二', '少于 4 个空行不动');
  assert.strictEqual(R.canonicalize('  缩进保留'), '  缩进保留');
});

test('SHA-256 与 Node crypto 一致', () => {
  ['', 'abc', '你好，世界', 'x'.repeat(1000)].forEach(s => assert.strictEqual(R.sha256(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex')));
});

test('版本：仅空白差异不升级；L1 修改让 static 版本 +1；历史与恢复', () => {
  let st = R.newState();
  let r = R.setBlock(st, 'world', '魔法世界', 1); st = r.state;
  assert.strictEqual(R.getBlock(st, 'world').version, 1); assert.strictEqual(st.staticVersion, 1);
  r = R.setBlock(st, 'world', '魔法世界  \r\n\r\n', 2);
  assert.strictEqual(r.changed, false); assert.strictEqual(r.state, st);
  st = R.setBlock(st, 'world', '科幻世界', 3).state;
  assert.strictEqual(R.getBlock(st, 'world').version, 2); assert.strictEqual(st.staticVersion, 2);
  st = R.setBlock(st, 'memory', '记忆', 4).state;
  assert.strictEqual(st.staticVersion, 2, 'L2 不影响 static 版本');
  assert.strictEqual(R.vlabel('static', st.staticVersion), 'static_v002');
  assert.strictEqual(R.vlabel('memory', R.getBlock(st, 'memory').version), 'memory_v001');
  st = R.setBlock(st, 'world', null, 5, 1).state;
  const w = R.getBlock(st, 'world');
  assert.strictEqual(w.content, '魔法世界'); assert.strictEqual(w.version, 3); assert.strictEqual(w.restoredFrom, 1);
  assert.deepStrictEqual(w.history.map(h => h.version), [1, 2]);
});

test('对话系统提示词视为 L1：变化时 static 版本 +1，不变不升', () => {
  let st = R.syncBase(R.newState(), '你是一个RP助手');
  assert.strictEqual(st.staticVersion, 1);
  assert.strictEqual(R.syncBase(st, '你是一个RP助手  '), st);
  assert.strictEqual(R.syncBase(st, '新的人设').staticVersion, 2);
});

test('六层顺序（C-2）：static → summary → memory 在 system；L4 原样；L5 + L6 在最后一条用户消息', () => {
  let st = withBlocks();
  st = R.addSummary(st, { content: 'FACTS:\n- 进入北境', coveredIds: [], at: 1 });
  const p = R.plan(st, '你是RP助手', convo(3));
  const { system, messages } = R.assemble(p);
  const idx = ['你是RP助手', '[WORLD]', '[CHARACTER]', '[RP_RULES]', '[CHAPTER_SUMMARY #001]', '[LONG_TERM_MEMORY]'].map(t => system.indexOf(t));
  idx.forEach(i => assert.ok(i >= 0));
  assert.deepStrictEqual(idx, idx.slice().sort((x, y) => x - y), 'system 内顺序固定');
  assert.ok(!system.includes('HP:'), '动态状态不在 system 中');
  const last = messages[messages.length - 1];
  assert.strictEqual(last.content, u(3).content + '\n\n[CURRENT_STATE]\nHP: 82/100\nLocation: 王都西区', 'V2：本轮输入在前，状态在后');
  assert.deepStrictEqual(messages.slice(0, -1).map(m => m.content), [u(1).content, a(1).content, u(2).content, a(2).content], 'L4 原样、原顺序');
  assert.ok(!/\d{4}-\d{2}-\d{2}|\d{13}/.test(system), '前缀中没有时间戳');
});

test('逐字节稳定：状态每轮变化，第 N+1 轮请求的历史前缀 == 第 N 轮的历史 + 原样追加；请求体逐字节前缀一致', () => {
  let st = withBlocks();
  const msgs = [];
  let prev = null;
  for (let turn = 1; turn <= 6; turn++) {
    st = R.setBlock(st, 'state', 'HP: ' + (90 - turn) + '/100\nTime: 21:' + (10 + turn), turn).state; // 每轮修改动态状态
    msgs.push(u(turn));
    const p = R.plan(st, '你是RP助手', msgs);
    const req = R.assemble(p);
    const body = P.buildChatRequest(ds, 'deepseek-flash', req.messages, req.system, { stream: true }).body;
    const parsed = JSON.parse(body).messages;
    // 历史里从不出现状态
    parsed.slice(1, -1).forEach(m => assert.ok(!m.content.includes('[CURRENT_STATE]')));
    if (prev) {
      assert.strictEqual(parsed[0].content, prev.parsed[0].content, 'system 不变');
      const k = prev.parsed.length - 1; // 上一轮除最后一条之外的全部
      assert.deepStrictEqual(parsed.slice(0, k), prev.parsed.slice(0, k));
      assert.strictEqual(parsed[k].content, u(turn - 1).content, '上一轮的输入以原文进入历史（不带状态）');
      assert.strictEqual(parsed[k + 1].content, a(turn - 1).content);
      const cut = prev.body.lastIndexOf('{"role":"user"');
      assert.ok(body.startsWith(prev.body.slice(0, cut)), '请求体（JSON 文本）逐字节前缀一致');
      const fp = R.fingerprints(p, '你是RP助手');
      const d = R.diagnose(prev.entry, fp, p.hist);
      assert.deepStrictEqual(d, { static: 'SAME', memory: 'SAME', summary: 'SAME', delta: 'SAME', state: 'CHANGED', input: 'CHANGED', history: 'APPEND' });
    }
    const fp = R.fingerprints(p, '你是RP助手');
    prev = { parsed, body, entry: R.makeLogEntry({ fp, at: turn }) };
    msgs.push(a(turn));
  }
});

test('诊断：SAME / APPEND / CHANGED 与原因', () => {
  const st = withBlocks();
  const p1 = R.plan(st, '', convo(3)); const f1 = R.fingerprints(p1, '');
  const e1 = R.makeLogEntry({ fp: f1, at: 1000, model: 'deepseek-flash' });
  assert.deepStrictEqual(R.diagnose(null, f1, p1.hist).static, 'NEW');
  assert.strictEqual(e1.reason, '首次请求，缓存尚未建立');
  // 重新生成：历史、输入都一样
  assert.deepStrictEqual(R.diagnose(e1, f1, p1.hist), { static: 'SAME', memory: 'SAME', summary: 'SAME', delta: 'SAME', state: 'SAME', input: 'SAME', history: 'SAME' });
  // 修改角色卡
  const st2 = R.setBlock(st, 'character', '曹含森，24岁', 2).state;
  const p2 = R.plan(st2, '', convo(3)); const f2 = R.fingerprints(p2, '');
  const d2 = R.diagnose(e1, f2, p2.hist);
  assert.strictEqual(d2.static, 'CHANGED');
  const e2 = R.makeLogEntry({ fp: f2, diag: d2, at: 2000, model: 'deepseek-flash', prev: e1 });
  assert.strictEqual(e2.reason, '角色卡 / 世界观等永久锚点被修改');
  // 编辑了较早的消息
  const items = convo(3); items[0] = Object.assign({}, items[0], { content: '改过的第一轮' });
  const p3 = R.plan(st, '', items); const d3 = R.diagnose(e1, R.fingerprints(p3, ''), p3.hist);
  assert.strictEqual(d3.history, 'CHANGED');
  // 正常追加
  const p4 = R.plan(st, '', convo(4)); const d4 = R.diagnose(e1, R.fingerprints(p4, ''), p4.hist);
  assert.strictEqual(d4.history, 'APPEND');
  const e4 = R.makeLogEntry({ fp: R.fingerprints(p4, ''), diag: d4, at: 3000, model: 'deepseek-flash', prev: e1, usage: { prompt: 1000, hit: 900, miss: 100, cacheSupported: true } });
  assert.strictEqual(e4.reason, '正常动态更新');
  assert.strictEqual(e4.hit_rate, 0.9);
});

test('Token 预算与自动摘要触发：遵守 min_new_turns / keep_recent_turns', () => {
  const st = withBlocks();
  st.settings.summary = { enabled: true, trigger_tokens: 200, min_new_turns: 5, keep_recent_turns: 4 };
  // 历史 8 轮（第 9 轮为当前输入）：可摘要 4 轮 < 5 → 不触发（即使超过 trigger_tokens）
  let p = R.plan(st, '', convo(9));
  assert.ok(R.estimateItems(p.unsummarized) >= 200);
  assert.strictEqual(p.batchRounds, 4); assert.strictEqual(p.needSummary, false);
  // 历史 9 轮：可摘要 5 轮 → 触发
  p = R.plan(st, '', convo(10));
  assert.strictEqual(p.needSummary, true); assert.strictEqual(p.summaryReason, 'trigger');
  assert.deepStrictEqual(p.batch.map(m => m.id), ['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5']);
  // 关闭摘要
  p = R.plan(Object.assign({}, st, { settings: Object.assign({}, st.settings, { summary: Object.assign({}, st.settings.summary, { enabled: false }) }) }), '', convo(10));
  assert.strictEqual(p.needSummary, false);
  // 超预算：即使新增轮数不足也会摘要
  const st2 = Object.assign({}, st, { settings: Object.assign({}, st.settings, { max_context: 1000, output_reserve: 0, safety_margin: 0, summary: Object.assign({}, st.settings.summary, { trigger_tokens: 1e9 }) }) });
  const big = convo(6).map(m => Object.assign({}, m, { content: m.content + '很长的内容'.repeat(60) }));
  p = R.plan(st2, '', big);
  assert.ok(p.overBudget); assert.strictEqual(p.summaryReason, 'budget'); assert.strictEqual(p.batchRounds, 1);
});

test('章节（V2）：只追加、之前章节逐字不变；编辑 / 撤销；原始消息不删除', () => {
  let st = withBlocks();
  st.settings.summary = Object.assign({}, st.settings.summary, { enabled: true, trigger_tokens: 100, min_new_turns: 2, keep_recent_turns: 2, min_interval_turns: 0 });
  const items = convo(6);
  let p = R.plan(st, '', items);
  assert.ok(p.needSummary);
  const prompt = R.buildSummaryPrompt({ chapters: [], memory: R.getBlock(st, 'memory').content, batch: p.batch });
  R.SUMMARY_SECTIONS.forEach(k => assert.ok(prompt.includes(k + ':'), '提示词包含 ' + k));
  assert.ok(prompt.includes('知识边界'));
  const out = '```\n[CHAPTER SUMMARY]\nFACTS:\n- 曹含森进入北境\n\nCHARACTER_KNOWLEDGE:\n- 张燕：只知道失踪案与商人有关\n\nPLAYER_KNOWLEDGE:\n- 曹含森知道自己有特殊魔法\n\nSECRET:\n- 幕后组织尚未对玩家公开\n\nUNRESOLVED:\n- 幕后组织未确认\n\nRELATIONSHIPS:\n- 曹含森与张燕：合作调查\n\nOBJECTS:\n- 商队账本\n\nLOCATION:\n- 北境关卡\n```';
  const ps = R.parseSummary(out);
  assert.ok(ps.ok); assert.ok(ps.text.startsWith('FACTS:')); assert.deepStrictEqual(ps.missing, []); assert.ok(ps.quality >= R.SUMMARY_MIN_QUALITY); assert.deepStrictEqual(ps.critMissing, []);
  assert.ok(!R.parseSummary('他们聊了很多。').ok, '不合格式的输出不接受');
  st = R.addChapter(st, { content: ps.text, coveredIds: p.batch.map(m => m.id), at: 10, atRound: 6 });
  assert.strictEqual(R.activeSummary(st).no, 1);
  p = R.plan(st, '', items);
  assert.ok(!p.needSummary);
  assert.deepStrictEqual(p.hist.map(m => m.id), ['u4', 'a4', 'u5', 'a5'], '被摘要的消息不再发送');
  assert.strictEqual(items.length, 11, '原始消息仍在');
  assert.ok(p.system.includes('[CHAPTER_SUMMARY #001]\nFACTS:'));
  const sys1 = p.stablePrefix; // C-2：memory 排在 summary 之后，稳定前缀 = static + 章节
  assert.ok(p.system.startsWith(sys1));
  // 继续对话后追加 #002：只覆盖新移出的消息；#001 逐字保留，system 以旧 system 为前缀
  const more = convo(10);
  p = R.plan(st, '', more);
  assert.ok(p.needSummary);
  assert.deepStrictEqual(p.batch.map(m => m.id), ['u4', 'a4', 'u5', 'a5', 'u6', 'a6', 'u7', 'a7'], '新章节只包含新移出的历史');
  const prompt2 = R.buildSummaryPrompt({ chapters: R.chaptersOf(st), batch: p.batch });
  assert.ok(prompt2.includes('曹含森进入北境') && prompt2.includes('不要复述'), '之前章节作为只读参考');
  st = R.addChapter(st, { content: 'FACTS:\n- 第二章', coveredIds: p.batch.map(m => m.id), at: 20, atRound: 10 });
  p = R.plan(st, '', more);
  assert.ok(p.system.startsWith(sys1), 'V2：追加章节后旧 system 仍是前缀');
  assert.ok(p.system.includes('[CHAPTER_SUMMARY #001]') && p.system.includes('[CHAPTER_SUMMARY #002]'));
  assert.deepStrictEqual(p.hist.map(m => m.id), ['u8', 'a8', 'u9', 'a9']);
  assert.strictEqual(R.coveredIds(st).length, 14);
  // 编辑：只有内容真正变化才生效，旧内容进入章节历史
  assert.strictEqual(R.editChapter(st, 2, 'FACTS:\n- 第二章  \n', 30).changed, false);
  st = R.editChapter(st, 2, 'FACTS:\n- 第二章（修订）', 30).state;
  assert.strictEqual(R.chaptersOf(st)[1].history.length, 1); assert.strictEqual(R.chaptersOf(st)[1].source, 'edit');
  assert.ok(R.plan(st, '', more).system.startsWith(sys1), '编辑 #002 不影响 #001 之前的前缀');
  // 撤销最后一章：覆盖的消息重新发送，存档保留
  const r = R.removeLastChapter(st, 40); st = r.state;
  assert.strictEqual(r.reopened, 8);
  p = R.plan(st, '', more);
  assert.strictEqual(p.hist[0].id, 'u4'); assert.strictEqual(st.archive.length, 1);
});

test('超预算：临时裁剪不永久推进窗口；permanent 才固定起点', () => {
  let st = withBlocks();
  st.settings = Object.assign({}, st.settings, { max_context: 2600, output_reserve: 0, safety_margin: 0, summary: Object.assign({}, st.settings.summary, { enabled: false, keep_recent_turns: 3 }) });
  const long = n => convo(n).map(m => Object.assign({}, m, { content: m.content + '描写'.repeat(100) }));
  let p = R.plan(st, '', long(14));
  assert.ok(p.overBudget); assert.ok(!p.needSummary);
  const beforeWin = JSON.stringify(st.window);
  const tmp = R.temporaryTrimPlan(st, p, { reason: 'summary_failed' });
  st = tmp.state; p = tmp.plan;
  assert.ok(p.tempTrim && p.trimmed);
  assert.strictEqual(JSON.stringify(st.window), beforeWin, '临时裁剪不得永久推进 window');
  assert.ok(st.overflow && st.overflow.permanent === false);
  // 显式 permanent 才固定起点（用户确认场景）
  st = R.fallbackTrim(st, R.plan(withBlocks(), '', long(14)), { permanent: true });
  // rebuild with same settings
  st.settings = Object.assign({}, st.settings, { max_context: 2600, output_reserve: 0, safety_margin: 0, summary: Object.assign({}, st.settings.summary, { enabled: false, keep_recent_turns: 3 }) });
  p = R.plan(st, '', long(14));
  assert.ok(!p.overBudget); assert.ok(p.trimmed);
  const start = p.hist[0].id;
  assert.strictEqual(p.hist[0].role, 'user');
  const p2 = R.plan(st, '', long(15));
  assert.strictEqual(p2.hist[0].id, start, 'permanent 后下一轮起点不变');
  assert.deepStrictEqual(p2.hist.slice(0, p.hist.length).map(m => m.content), p.hist.map(m => m.content));
});

test('日志默认不保存完整 Prompt；开启 save_prompt 才保存', () => {
  const st = withBlocks(); const p = R.plan(st, '', convo(2)); const fp = R.fingerprints(p, '');
  const prompt = R.assemble(p);
  const e = R.makeLogEntry({ fp, at: 1, model: 'deepseek-flash', usage: { prompt: 100, hit: 80, miss: 20, cacheSupported: true }, prompt, savePrompt: false, request_id: 'req_0001' });
  const keys = ['request_id', 'timestamp', 'model', 'prompt_tokens', 'cache_hit_tokens', 'cache_miss_tokens', 'completion_tokens', 'hit_rate', 'static_hash', 'memory_hash', 'summary_hash', 'history_hash', 'state_hash', 'full_prefix_hash', 'summary_happened', 'over_budget'];
  keys.forEach(k => assert.ok(k in e, '日志包含 ' + k));
  const ser = JSON.stringify(e);
  assert.ok(!ser.includes('魔法世界') && !ser.includes('HP:') && !ser.includes('玩家第'), '默认不含任何 Prompt 文本');
  const e2 = R.makeLogEntry({ fp, at: 1, prompt, savePrompt: true });
  assert.ok(JSON.stringify(e2).includes('魔法世界'));
});

test('统计：今日、平均命中率、平均 Miss / 请求、最近 20 次、连续命中、费用', () => {
  const now = new Date(2026, 9, 2, 15, 0).getTime();
  const mk = (hit, miss, at, model) => R.makeLogEntry({ at, model: model || 'deepseek-flash', usage: { prompt: hit + miss, hit, miss, completion: 100, cacheSupported: true } });
  const logs = [mk(0, 1000, now - 86400e3), mk(900, 100, now - 3000), mk(950, 50, now - 2000), R.makeLogEntry({ at: now - 1000, model: 'glm', usage: { prompt: 500 } }), mk(990, 10, now)];
  const s = R.stats(logs, R.DEFAULT_PRICES, 'peak', now);
  assert.strictEqual(s.requests, 5); assert.strictEqual(s.supported, 4);
  assert.strictEqual(s.today.requests, 4); assert.strictEqual(s.today.hit, 2840); assert.strictEqual(s.today.miss, 160);
  assert.ok(Math.abs(s.avgRate - (0 + 0.9 + 0.95 + 0.99) / 4) < 1e-9);
  assert.strictEqual(s.avgMiss, (1000 + 100 + 50 + 10) / 4);
  assert.strictEqual(s.streak, 3); assert.strictEqual(s.max, 0.99); assert.strictEqual(s.min, 0);
  assert.strictEqual(s.last20.length, 5); assert.strictEqual(s.last20[4].n, 5);
  const c = R.costOf(logs[1], R.DEFAULT_PRICES, 'peak');
  assert.ok(Math.abs(c.saved - 900 * (0.3 - 0.006) / 1e6) < 1e-12);
  assert.strictEqual(R.isPeak(Date.UTC(2026, 9, 2, 2)), true); assert.strictEqual(R.isPeak(Date.UTC(2026, 9, 3, 2)), false);
});

test('异常检测：命中率骤降 + 基于哈希的原因', () => {
  const mk = (rate, diag, extra) => Object.assign(R.makeLogEntry({ at: 1, model: 'deepseek-flash', usage: { prompt: 1000, hit: rate * 1000, miss: 1000 - rate * 1000, cacheSupported: true }, diag }), extra || {});
  const ok = { static: 'SAME', memory: 'SAME', summary: 'SAME', history: 'APPEND', state: 'CHANGED', input: 'CHANGED' };
  const base = [0.92, 0.93, 0.91, 0.92, 0.93].map(r => mk(r, ok));
  assert.strictEqual(R.detectAnomaly(base).anomaly, false);
  const an = R.detectAnomaly(base.concat([mk(0.41, Object.assign({}, ok, { summary: 'CHANGED' }))]));
  assert.ok(an.anomaly); assert.ok(Math.abs(an.avg - 0.922) < 1e-9);
  assert.ok(an.causes[0].includes('章节摘要指纹变化'));
  assert.deepStrictEqual(an.changed, ['summary', 'state']);
  const an2 = R.detectAnomaly(base.concat([mk(0.2, ok, { reasons: ['正常动态更新'] })]));
  assert.ok(an2.anomaly); assert.ok(an2.causes.some(c => c.includes('服务端缓存')));
  assert.strictEqual(R.detectAnomaly(base.concat([mk(0.85, ok)])).anomaly, false, '小幅波动不报警');
  const cold = mk(0, { static: 'NEW', memory: 'NEW', summary: 'NEW', history: 'NEW', state: 'NEW', input: 'NEW' });
  assert.ok(R.detectAnomaly([cold, mk(0.6, ok), mk(0.65, ok), mk(0.05, ok)]).anomaly, '首次冷启动请求不拉低基线');
});

test('界面中文标签（v0.3.3）：只改显示，不改保存的键名与发送给模型的文本', () => {
  assert.deepStrictEqual(R.LAYERS.map(k => R.LAYER_TITLES[k]), ['固定设定', '长期记忆', '章节摘要', '对话历史', '记忆增量', '当前状态', '本轮输入']);
  assert.deepStrictEqual(['SAME', 'APPEND', 'CHANGED', 'NEW'].map(R.diagLabel), ['未变', '追加', '已改动', '首次']);
  assert.strictEqual(R.verLabel('static', 1), '固定设定 第 1 版');
  assert.strictEqual(R.verLabel('state', 12), '当前状态 第 12 版');
  assert.strictEqual(R.vlabel('static', 1), 'static_v001', '内部标签不变');
  assert.ok(R.SUMMARY_SECTIONS.every(k => R.SUMMARY_SECTION_CN[k]), '每个摘要段落都有中文释义');
  // 诊断结果与日志仍保存英文代码
  let st = R.syncBase(R.normalizeState(null), 'S');
  const p = R.plan(st, 'S', [{ id: 'u1', role: 'user', content: '你好' }]);
  const e = R.makeLogEntry({ fp: R.fingerprints(p, 'S'), at: 1 });
  const p2 = R.plan(st, 'S', [{ id: 'u1', role: 'user', content: '你好' }, { id: 'a1', role: 'assistant', content: '嗨' }, { id: 'u2', role: 'user', content: '继续' }]);
  assert.deepStrictEqual(R.diagnose(e, R.fingerprints(p2, 'S'), p2.hist), { static: 'SAME', memory: 'SAME', summary: 'SAME', delta: 'SAME', state: 'SAME', input: 'CHANGED', history: 'APPEND' });
  // 发送给模型的分段标记与摘要格式保持英文
  st = R.setBlock(st, 'state', 'HP: 80', 1).state;
  assert.strictEqual(R.finalUserContent(st, '推门'), '推门\n\n[CURRENT_STATE]\nHP: 80');
  const sp = R.buildSummaryPrompt({ prevSummary: null, memory: '', batch: [{ role: 'user', content: 'x' }] });
  R.SUMMARY_SECTIONS.forEach(k => assert.ok(JSON.stringify(sp).includes(k + ':'), k));
});
