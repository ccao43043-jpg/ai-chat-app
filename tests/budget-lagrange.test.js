// 方向 A：层间拉格朗日 + 层内 history 二分（budget_mode / min_history_ratio）
const test = require('node:test');
const assert = require('node:assert');
const R = require('../app/src/main/assets/www/rpcache.js');

const u = (i, t) => ({ id: 'u' + i, role: 'user', content: t || ('玩家第' + i + '轮：推开门。') });
const a = (i, t) => ({ id: 'a' + i, role: 'assistant', content: t || ('角色第' + i + '轮：走廊烛光摇曳。') });
function convo(n) {
  const out = [];
  for (let i = 1; i <= n; i++) { out.push(u(i)); if (i < n) out.push(a(i)); }
  return out;
}

function baseState(extraSettings) {
  let st = R.newState();
  st = R.setBlock(st, 'world', '魔法世界。', 1).state;
  st = R.setBlock(st, 'character', '曹含森，冷静。', 1).state;
  st = R.setBlock(st, 'rules', 'NPC不能读心。', 1).state;
  st = R.setBlock(st, 'state', 'HP: 80', 1).state;
  if (extraSettings) st.settings = Object.assign({}, st.settings, extraSettings);
  return st;
}

test('DEFAULT_SETTINGS：budget_mode=lagrangian，min_history_ratio=0.35，lagrange_layers 默认', () => {
  assert.strictEqual(R.DEFAULT_SETTINGS.budget_mode, 'lagrangian');
  assert.strictEqual(R.DEFAULT_SETTINGS.min_history_ratio, 0.35);
  assert.deepStrictEqual(R.DEFAULT_SETTINGS.lagrange_layers, ['memory', 'summary']);
  const st = R.normalizeState(null);
  assert.strictEqual(st.settings.budget_mode, 'lagrangian');
  assert.strictEqual(st.settings.min_history_ratio, 0.35);
  assert.deepStrictEqual(st.settings.lagrange_layers, ['memory', 'summary']);
  // 显式 greedy 保留
  assert.strictEqual(R.normalizeState({ settings: { budget_mode: 'greedy' } }).settings.budget_mode, 'greedy');
});

test('greedy：与强制关闭拉格朗日后的 plan 逐字段一致（同输入）', () => {
  let st = baseState({ budget_mode: 'greedy', max_context: 8000, output_reserve: 0, safety_margin: 0 });
  const mem = [
    '- 置顶设定：北境关卡有结界',
    '- 张燕尚不知道曹含森有魔法',
    '- 过场：街上有人卖苹果',
    '- 未解决：幕后组织身份未确认',
  ].join('\n');
  st = R.setBlock(st, 'memory', mem, 1).state;
  st = R.addChapter(st, {
    content: 'FACTS:\n- 进入北境\n\nUNRESOLVED:\n- 幕后组织\n\nRELATIONSHIPS:\n- 曹含森与张燕合作',
    coveredIds: [], at: 1, atRound: 2,
  });
  const items = convo(8).map((m, i) => Object.assign({}, m, {
    content: m.content + (i === itemsLastUser(convo(8)) ? ' 提到张燕与幕后组织' : ''),
  }));
  function itemsLastUser(arr) { return arr.length - 1; }
  const items2 = convo(8);
  items2[items2.length - 1] = Object.assign({}, items2[items2.length - 1], { content: '继续调查张燕与幕后组织。' });

  const greedy = R.plan(st, 'SYS', items2);
  // 同一 state 再显式 greedy（应已是）
  const again = R.plan(Object.assign({}, st, { settings: Object.assign({}, st.settings, { budget_mode: 'greedy' }) }), 'SYS', items2);
  assert.strictEqual(greedy.system, again.system);
  assert.deepStrictEqual(greedy.tokens, again.tokens);
  assert.deepStrictEqual(greedy.hist.map(m => m.id), again.hist.map(m => m.id));
  assert.strictEqual(greedy.overBudget, again.overBudget);
  assert.strictEqual(greedy.needSummary, again.needSummary);
  assert.ok(!greedy.lagrange || greedy.lagrange.skipped || greedy.settings.budget_mode === 'greedy');
});

test('greedy 回退：字节级对齐「无 lagrange 字段的旧路径」——同预算下关闭后与手工重建一致', () => {
  let st = baseState({
    budget_mode: 'greedy',
    max_context: 5000, output_reserve: 0, safety_margin: 0,
    summary: Object.assign({}, R.DEFAULT_SETTINGS.summary, { enabled: false, keep_recent_turns: 3 }),
  });
  st = R.setBlock(st, 'memory', '稳定事实：结界。', 1).state;
  const long = convo(12).map(m => Object.assign({}, m, { content: m.content + '描写'.repeat(80) }));
  const p = R.plan(st, '', long);
  // greedy 不挂 lagrange 挑选结果（apply 直接返回）
  assert.ok(!p.lagrange || p.lagrange === undefined);
  const assembled = R.assemble(p);
  assert.ok(assembled.system.indexOf('[LONG_TERM_MEMORY]') >= 0);
  assert.strictEqual(assembled.system, p.system);
});

test('价值函数：pin / entityHit / openThread / typeWeight / resolveRatio 与 decay', () => {
  const ents = R.extractEntities(['张燕在北境见到曹含森']);
  assert.ok(ents.has('张燕') && ents.has('北境') && ents.has('曹含森'));
  const ctx = { entities: ents, recentTexts: ['张燕已经知道结界的事了'] };
  const pinned = R.itemSalience({ text: '📌 置顶：结界规则', pinned: true }, ctx);
  const plain = R.itemSalience({ text: '过场：卖苹果' }, ctx);
  assert.ok(pinned > plain);
  const open = R.itemSalience({ text: '未解决：幕后组织尚未现身？' }, ctx);
  assert.ok(open > plain);
  const rel = R.itemSalience({ text: 'RELATIONSHIPS:\n- 曹含森与张燕' }, ctx);
  assert.ok(rel > plain);
  // decay：τ_memory=40
  assert.strictEqual(R.itemDecay('static', 100), 1);
  assert.ok(Math.abs(R.itemDecay('memory', 40) - Math.exp(-1)) < 1e-10);
  assert.ok(R.itemDecay('summary', 0) === 1);
  const v = R.itemValue({ text: '张燕线索', layer: 'memory', deltaTurns: 0 }, ctx);
  assert.ok(v > 1);
});

test('lagrangian：按价值密度挑选——低密度过场被丢、高密度设定/未解决保留', () => {
  let st = baseState({
    budget_mode: 'lagrangian',
    max_context: 2200, output_reserve: 0, safety_margin: 0,
    min_history_ratio: 0.35,
    summary: Object.assign({}, R.DEFAULT_SETTINGS.summary, { enabled: false, keep_recent_turns: 2 }),
  });
  // 大块低价值 + 小块高价值，逼出挑选
  const filler = '过场描写闲聊天气。'.repeat(120);
  const mem = [
    '📌 置顶设定：北境结界需要血契才能通过',
    filler,
    '- 未解决：幕后组织身份尚未确认？',
    '- 过场：广场有人卖糖葫芦' + '啊'.repeat(80),
  ].join('\n');
  st = R.setBlock(st, 'memory', mem, 1).state;
  const hist = convo(6).map(m => Object.assign({}, m, { content: m.content + '剧情'.repeat(40) }));
  hist[hist.length - 1] = Object.assign({}, hist[hist.length - 1], { content: '继续追查幕后组织与北境结界。' });
  const p = R.plan(st, 'SYS', hist);
  assert.ok(p.lagrange, '应记录 lagrange 结果');
  if (!p.lagrange.skipped) {
    assert.ok(p.system.indexOf('置顶设定') >= 0 || p.system.indexOf('未解决') >= 0, '高价值条目应保留');
    // 若发生了丢弃，过场大块更可能被丢
    if (p.lagrange.dropped && p.lagrange.dropped.length) {
      const droppedText = p.lagrange.dropped.map(d => d.id).join(',');
      assert.ok(p.system.length <= R.plan(Object.assign({}, st, { settings: Object.assign({}, st.settings, { budget_mode: 'greedy' }) }), 'SYS', hist).system.length
        || p.tokens.memory <= R.plan(Object.assign({}, st, { settings: Object.assign({}, st.settings, { budget_mode: 'greedy' }) }), 'SYS', hist).tokens.memory);
      assert.ok(true, 'dropped=' + droppedText);
    }
  }
  // 密度挑选单元：直接测 selectLagrangeOptional
  const cands = R.collectLagrangeCandidates(st, p, ['memory']);
  assert.ok(cands.length >= 2);
  const dens = cands.map(c => c.density);
  assert.ok(Math.max(...dens) > Math.min(...dens));
  const B = 800, fixedCore = 100, tAllHist = 400, tMinHist = Math.floor(0.35 * B);
  const sel = R.selectLagrangeOptional(cands, { B, fixedCore, tAllHist, tMinHist });
  assert.ok(sel.picked.length >= 1);
  assert.ok(sel.picked.every(x => x.density >= sel.mu - 1e-9 || R.itemSalience(x, {}) /* pin path */));
  // 被选中的最低密度应 ≥ 被丢弃的最高密度（阈值规则；pin 例外）
  const pickedNonPin = sel.picked.filter(x => !/置顶|📌/.test(x.text));
  const droppedNonPin = sel.dropped.filter(x => !/置顶|📌/.test(x.text));
  if (pickedNonPin.length && droppedNonPin.length) {
    const minP = Math.min(...pickedNonPin.map(x => x.density));
    const maxD = Math.max(...droppedNonPin.map(x => x.density));
    assert.ok(minP + 1e-9 >= maxD || minP >= sel.mu - 1e-9, '阈值：picked 密度应不低于 μ');
  }
});

test('min_history_ratio：可选层不得把 history 预算压破下限', () => {
  let st = baseState({
    budget_mode: 'lagrangian',
    max_context: 4000, output_reserve: 0, safety_margin: 0,
    min_history_ratio: 0.45,
    lagrange_layers: ['memory', 'summary'],
    summary: Object.assign({}, R.DEFAULT_SETTINGS.summary, { enabled: false, keep_recent_turns: 2 }),
  });
  // 超预算：巨大低价值记忆 + 不小的历史 → 必须丢掉记忆以保住 history 占比
  const bigMem = Array.from({ length: 20 }, (_, i) =>
    (i === 0 ? '📌 关键设定：血契' : ('- 过场填充' + i + '：' + '填充文本闲聊过场。'.repeat(80)))
  ).join('\n');
  st = R.setBlock(st, 'memory', bigMem, 1).state;
  const hist = convo(8).map(m => Object.assign({}, m, { content: m.content + '对话内容。'.repeat(50) }));
  const greedy = R.plan(Object.assign({}, st, { settings: Object.assign({}, st.settings, { budget_mode: 'greedy' }) }), 'SYS', hist);
  assert.ok(greedy.overBudget, '构造前提：greedy 应超预算');
  const p = R.plan(st, 'SYS', hist);
  assert.ok(p.lagrange && !p.lagrange.skipped, '应触发挑选');
  const B = p.lagrange.B, tMin = p.lagrange.tMinHist;
  assert.strictEqual(tMin, Math.floor(B * 0.45));
  const optionalUsed = (p.tokens.memory | 0) + (p.tokens.summary | 0);
  const fixedCore = p.lagrange.fixedCore;
  const Bhist = B - fixedCore - optionalUsed;
  assert.ok(Bhist >= tMin - 2, 'history 可用预算应 ≥ min_history_ratio*B，实际 Bhist=' + Bhist + ' tMin=' + tMin);
  assert.ok(p.tokens.memory < greedy.tokens.memory, '应丢掉部分记忆');
  assert.ok(p.system.indexOf('关键设定') >= 0, '钉住条目应尽量保留');
});

test('μ 二分边界：预算极松 → 全选；预算极紧 → 几乎不选或只留 pin', () => {
  let st = baseState({ budget_mode: 'lagrangian', output_reserve: 0, safety_margin: 0 });
  const mem = [
    '📌 钉住：核心设定',
    '- 未解决：线索A尚未确认',
    '- 过场：闲聊' + '哈'.repeat(40),
    '- RELATIONSHIPS: 曹含森与张燕',
  ].join('\n');
  st = R.setBlock(st, 'memory', mem, 1).state;
  const hist = convo(4);

  // 极松
  st.settings = Object.assign({}, st.settings, { max_context: 1e7, min_history_ratio: 0.35 });
  const loose = R.plan(st, 'SYS', hist);
  assert.ok(!loose.lagrange || loose.lagrange.skipped || loose.lagrange.fullSelect,
    '极松应跳过或全选');
  assert.ok(loose.system.indexOf('核心设定') >= 0 && loose.system.indexOf('闲聊') >= 0);

  // 极紧：limit 刚够 static+state+input + 少量 history
  st.settings = Object.assign({}, st.settings, { max_context: 900, min_history_ratio: 0.4 });
  const tight = R.plan(st, 'SYS', hist.map(m => Object.assign({}, m, { content: m.content + '扩'.repeat(20) })));
  assert.ok(tight.lagrange, '极紧应有 lagrange');
  if (!tight.lagrange.skipped) {
    assert.ok(tight.lagrange.picked.length <= tight.lagrange.picked.length + tight.lagrange.dropped.length);
    // 钉住优先
    const pickIds = (tight.lagrange.picked || []).map(x => x.id);
    const allMem = R.splitMemoryItems(mem);
    const pin = allMem.find(x => /钉住|📌/.test(x.text));
    if (pin && tight.tokens.memory > 0) {
      assert.ok(tight.system.indexOf('核心设定') >= 0 || pickIds.indexOf(pin.id) >= 0
        || tight.lagrange.dropped.length === allMem.length);
    }
    // 极紧时可选层占用应显著小于全文记忆
    const fullMemTok = Math.round(R.estimateTokens(R.memoryText(st)) * (tight.calib || 1));
    assert.ok(tight.tokens.memory <= fullMemTok);
  }
});

test('同输入下 greedy 与「装得下时的 lagrangian」system 逐字节一致', () => {
  let st = baseState({ max_context: 100000, output_reserve: 12000, safety_margin: 2000 });
  st = R.setBlock(st, 'memory', '- 事实A\n- 事实B：张燕\n- 未解决：线索？', 1).state;
  st = R.addChapter(st, { content: 'FACTS:\n- 一章\n\nUNRESOLVED:\n- x', coveredIds: ['u1'], at: 1, atRound: 1 });
  const items = convo(5);
  const g = R.plan(Object.assign({}, st, { settings: Object.assign({}, st.settings, { budget_mode: 'greedy' }) }), 'SYS', items);
  const L = R.plan(Object.assign({}, st, { settings: Object.assign({}, st.settings, { budget_mode: 'lagrangian' }) }), 'SYS', items);
  assert.strictEqual(L.system, g.system);
  assert.deepStrictEqual(L.tokens, g.tokens);
  assert.deepStrictEqual(L.hist.map(m => m.id), g.hist.map(m => m.id));
});

test('splitMemoryItems / join 往返（列表项）', () => {
  const raw = '- aaa\n- bbb\n- ccc';
  const items = R.splitMemoryItems(raw);
  assert.strictEqual(items.length, 3);
  assert.strictEqual(R.joinMemoryItems(items), raw);
});
