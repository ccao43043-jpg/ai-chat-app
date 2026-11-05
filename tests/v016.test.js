// v0.16.0：RP/缓存审查三阶段 — 剧情遗忘 / 记忆冲突召回 / 缓存成本
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const R = require('../app/src/main/assets/www/rpcache.js');
const G = require('../app/src/main/assets/www/plugins/cache/gcache.js');
const M = require('../app/src/main/assets/www/rpmemory.js');
const A = require('../app/src/main/assets/www/affect.js');
const P = require('../app/src/main/assets/www/providers.js');

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
const FULL_SUM = `FACTS:
- 曹含森进入北境追踪失踪案

CHARACTER_KNOWLEDGE:
- 张燕：只知道失踪案与商人有关

PLAYER_KNOWLEDGE:
- 曹含森知道自己有特殊魔法

SECRET:
- 幕后组织尚未对玩家公开

UNRESOLVED:
- 幕后组织身份未确认

RELATIONSHIPS:
- 曹含森与张燕：合作调查

OBJECTS:
- 破损的商队账本

LOCATION:
- 北境关卡客栈`;

// ─── 阶段1：剧情遗忘 / 摘要 / 临时裁剪 ───
test('阶段1：缺关键知识分区则 parseSummary / commitChapter 拒提交', () => {
  const bad = 'FACTS:\n- 有人来了\n\nSECRET:\n- 无';
  const ps = R.parseSummary(bad);
  assert.ok(!ps.ok);
  assert.ok(ps.critMissing.length >= 1);
  assert.ok(ps.critMissing.includes('CHARACTER_KNOWLEDGE'));
  const st0 = withBlocks();
  const r = R.commitChapter(st0, { content: bad, coveredIds: ['u1'], at: 1, atRound: 1 });
  assert.ok(!r.ok);
  assert.strictEqual(r.reason, 'invalid_summary');
  assert.strictEqual(R.chaptersOf(r.state).length, 0);
});

test('阶段1：完整摘要可 commit，带 sourceFp 与 quality', () => {
  const ps = R.parseSummary(FULL_SUM);
  assert.ok(ps.ok, JSON.stringify(ps));
  assert.ok(ps.quality >= R.SUMMARY_MIN_QUALITY);
  assert.deepStrictEqual(ps.critMissing, []);
  const batch = convo(4);
  const covered = batch.map(m => m.id);
  const fp = R.chapterSourceFp(batch, covered);
  assert.ok(fp && fp.startsWith('sha256:'));
  const st0 = withBlocks();
  const r = R.commitChapter(st0, { content: FULL_SUM, coveredIds: covered, batch, at: 1, atRound: 2, rounds: 2 });
  assert.ok(r.ok);
  assert.strictEqual(r.chapter.sourceFp, fp);
  assert.ok(r.chapter.quality >= R.SUMMARY_MIN_QUALITY);
  assert.strictEqual(R.chaptersOf(r.state).length, 1);
});

test('阶段1：低质量摘要 force=false 拒提交', () => {
  const thin = `FACTS:
- 无

CHARACTER_KNOWLEDGE:
- 无

PLAYER_KNOWLEDGE:
- 无

SECRET:
- 无

UNRESOLVED:
- 无

RELATIONSHIPS:
- 无

OBJECTS:
- 无

LOCATION:
- 无`;
  const ps = R.parseSummary(thin);
  // v0.17：五区全「无」不得凑分，必须拒绝
  assert.ok(!ps.ok, 'all-empty critical must fail');
  assert.ok(ps.quality < R.SUMMARY_MIN_QUALITY);
  assert.ok((ps.critEmpty || []).length >= 5);
  const st0 = withBlocks();
  const r = R.commitChapter(st0, { content: thin, coveredIds: ['u1'], at: 1 });
  assert.ok(!r.ok);
});

test('阶段1：fallbackTrim 默认临时不推进 window；permanent 才推进', () => {
  let st = withBlocks();
  st.settings = Object.assign({}, st.settings, {
    max_context: 2600, output_reserve: 0, safety_margin: 0,
    summary: Object.assign({}, st.settings.summary, { enabled: false, keep_recent_turns: 3 }),
  });
  const long = n => convo(n).map(m => Object.assign({}, m, { content: m.content + '描写'.repeat(100) }));
  let p = R.plan(st, '', long(14));
  assert.ok(p.overBudget);
  const win0 = JSON.stringify(st.window);
  st = R.fallbackTrim(st, p); // 默认临时
  assert.strictEqual(JSON.stringify(st.window), win0);
  assert.ok(st.overflow && st.overflow.permanent === false);
  const tmp = R.temporaryTrimPlan(st, p, { reason: 'summary_failed' });
  assert.ok(tmp.plan.tempTrim && tmp.plan.trimmed);
  assert.strictEqual(JSON.stringify(tmp.state.window), win0);
  st = R.fallbackTrim(st, p, { permanent: true });
  assert.ok(st.window && st.window.startId);
  assert.strictEqual(st.overflow, null);
});

test('阶段1：Gemini Hybrid 默认 semantic，可切 fast_local；质量门不静默推进 cut', () => {
  assert.strictEqual(G.DEFAULTS.summaryStrategy, 'semantic');
  assert.strictEqual(G.STATIC_PROMPT_VERSION, 2);
  const turns = [];
  for (let i = 0; i < 12; i++) turns.push([{ role: 'user', content: '曹含森在北境调查失踪案，遇见张燕。第' + i + '轮。' }, { role: 'assistant', content: '张燕说商人账本有线索，密道通向旧矿。第' + i + '轮结果。' }]);
  const sem = G.HybridWindow.summarizeTurnsSemantic(turns.slice(0, 3), 0);
  assert.ok(sem.includes('曹含森') || sem.includes('张燕'));
  assert.ok(sem.includes('结果'));
  const fast = G.HybridWindow.summarizeTurnsFast(turns.slice(0, 3), 0);
  assert.ok(fast.includes('玩家'));
  const q = G.HybridWindow.scoreHybridSummary(sem, turns.slice(0, 3));
  assert.ok(q > 0);
  // apply 语义摘要：足够轮次应创建摘要
  const hist = turns.flat();
  const r = G.HybridWindow.apply(hist, G.HybridWindow.empty(), { summaryStrategy: 'semantic' });
  assert.ok(r.totalTurns >= G.HybridWindow.RAW_MAX || r.rawTurns <= G.HybridWindow.RAW_MAX);
  if (r.summaryCreated) {
    assert.ok(r.state.summaries[0].sourceFp || r.state.summaries[0].fp);
    assert.ok(r.state.summaries[0].quality != null);
  }
});

test('阶段1：Gemini static_hash 为 SHA-256 前缀', () => {
  const text = '【世界观】\n魔法大陆\n【角色卡】\n曹含森';
  const info = G.PromptBuilder.analyzeLayers(text);
  assert.ok(info.static_hash.startsWith('sha256:'));
  assert.strictEqual(info.static_prompt_version, 2);
  const h = G.PromptBuilder.staticHash(info.staticText);
  assert.ok(h.startsWith('sha256:'));
  // 与 crypto 一致（去掉 sha256: 前缀后应是 hex）
  assert.match(h.slice(7), /^[0-9a-f]{64}$/);
});

// ─── 阶段2：长期记忆冲突 / 置顶 / affect ───
test('阶段2：冲突检测优先于相似度合并，旧条 supersede', () => {
  assert.ok(M.detectConflict('张燕喜欢曹含森', '张燕讨厌曹含森'));
  const r = M.mergeEntries(
    [{ id: 'm1', seq: 1, type: 'relation', text: '张燕喜欢曹含森', keywords: ['张燕'], version: 1 }],
    [{ type: 'relation', text: '张燕讨厌曹含森', keywords: ['张燕'] }],
    1000, 'auto'
  );
  assert.ok(r.conflicts >= 1);
  assert.ok(r.superseded >= 1);
  const old = r.list.find(e => e.id === 'm1');
  assert.ok(old.supersededBy);
  assert.ok(old.disabled);
  const neu = r.list.find(e => e.supersedes === 'm1');
  assert.ok(neu);
  assert.strictEqual(neu.version, 2);
  // 召回跳过失效
  const sel = M.selectRelevant(r.list, '张燕 讨厌', { maxInject: 5, minScore: 1 });
  assert.ok(!sel.some(e => e.id === 'm1'));
  assert.ok(sel.some(e => e.supersedes === 'm1'));
});

test('阶段2：中文关键词可超过 16；置顶独立于 maxInject', () => {
  const long = '曹含森在北境关卡客栈遇见张燕调查商人失踪案与密道旧矿账本线索以及幕后组织伏笔';
  const kw = M.autoKeywords(long);
  assert.ok(kw.length > 16, 'keywords=' + kw.length);
  assert.ok(kw.length <= 48);
  const list = [
    { id: 'p1', seq: 1, type: 'fact', text: '置顶：艾琳是密道守护者', keywords: ['艾琳', '密道'], pinned: true },
    { id: 'n1', seq: 2, type: 'fact', text: '普通：北境下雪', keywords: ['北境', '下雪'] },
    { id: 'n2', seq: 3, type: 'fact', text: '普通：客栈老板姓周', keywords: ['客栈', '老板'] },
  ];
  const sel = M.selectRelevant(list, '密道 艾琳 北境', { maxInject: 1, pinBudget: 8, minScore: 1 });
  assert.ok(sel.some(e => e.pinned && e.id === 'p1'));
  assert.ok(sel.filter(e => !e.pinned).length <= 1);
});

test('阶段2：affect 区分 missing_state 与明确中性；why 可定位原文', () => {
  const T0 = Date.now();
  const miss = A.step(null, null, '你好', T0);
  assert.strictEqual(miss.p, 'missing_state');
  assert.strictEqual(miss.stateMissing, true);
  assert.strictEqual(miss.a, null);
  const neu = A.step(null, { a: 0, m: '平静', why: '' }, '你好', T0);
  assert.strictEqual(neu.explicitNeutral, true);
  assert.strictEqual(neu.stateMissing, false);
  assert.strictEqual(neu.a, 0);
  const loc = A.locateWhy('推开门', '我轻轻推开门，观察四周。');
  assert.ok(loc);
  assert.ok(loc.start >= 0);
  assert.ok(loc.quote.includes('推开门') || loc.approx);
});

test('阶段2：世界书 loreTrace 含版本与注入 Token/预算', () => {
  let st = withBlocks();
  st = R.setLore(st, '## 北境 | 北境\n' + '北境终年积雪，关卡戒备森严。'.repeat(3));
  const items = [u(1, '我前往北境关卡')];
  const r = R.fireLore(st, items, Date.now(), { convId: 'c1' });
  assert.ok(r.state.loreTrace);
  assert.strictEqual(r.state.loreTrace.v, 2);
  assert.ok(typeof r.state.loreTrace.injectTokens === 'number');
  assert.ok(r.state.loreTrace.budget && r.state.loreTrace.budget.total > 0);
  if (r.fired.length) assert.ok(r.state.loreTrace.injectTokens > 0);
});

// ─── 阶段3：缓存成本 / Token 校准 ───
test('阶段3（C-3 更新）：无真实命中样本时用 Beta(6,4) 先验悲观分位，而非默认 80%', () => {
  let st = withBlocks();
  st.settings = Object.assign({}, st.settings, {
    max_context: 32000, output_reserve: 2000, safety_margin: 500,
    summary: Object.assign({}, st.settings.summary, { enabled: true, trigger_tokens: 800, keep_recent_turns: 4, min_new_turns: 6 }),
  });
  // 造足量未摘要历史
  const long = convo(20).map(m => Object.assign({}, m, { content: m.content + '剧情'.repeat(80) }));
  const p = R.plan(st, '', long);
  const envNoHit = {
    cold: false, warm: 1, strategy: 'implicit', horizon: 12,
    hitRate: null, hitSamples: 0,
    cost: { model: 'deepseek-chat', prices: null, at: Date.now(), mode: 'auto' },
  };
  // 注入价格：用内置
  const a1 = R.adaptiveSummary(p, envNoHit);
  // C-3：不再一刀切禁用；用先验 Beta(6,4) 的悲观分位（≈0.40），绝不使用 80% 默认值
  const prior = R.hitPosterior([]);
  assert.ok(Math.abs(a1.hitQ - prior.q) < 1e-12 && a1.hitQ < 0.5, 'got ' + JSON.stringify(a1));
  assert.ok(/先验/.test(a1.why));
  const envHit = Object.assign({}, envNoHit, { hitRate: 0.9, hitSamples: 5 });
  const a2 = R.adaptiveSummary(p, envHit);
  // 有样本才可能 adaptive（也可能回本轮数不够）；至少不应再报「无样本」
  assert.ok(!/先验主导/.test(a2.why) && a2.hitQ > a1.hitQ);
});

test('阶段3：Token 校准按 provider/model/modality 隔离', () => {
  let st = withBlocks();
  // 多次校准让两路充分分离
  for (let i = 0; i < 8; i++) {
    st = R.calibrate(st, 1000, 1800, { provider: 'openrouter', model: 'google/gemini-2.5-flash', modality: 'text' });
    st = R.calibrate(st, 1000, 600, { provider: 'deepseek', model: 'deepseek-chat', modality: 'text' });
  }
  const k1 = R.calibOf(st, { provider: 'openrouter', model: 'google/gemini-2.5-flash', modality: 'text' });
  const k2 = R.calibOf(st, { provider: 'deepseek', model: 'deepseek-chat', modality: 'text' });
  assert.notStrictEqual(k1, k2);
  assert.ok(k1 > 1.2, 'gemini calib ' + k1);
  assert.ok(k2 < 0.9, 'deepseek calib ' + k2);
  assert.ok(st.calibBy['openrouter|google/gemini-2.5-flash|text']);
  assert.ok(st.calibBy['deepseek|deepseek-chat|text']);
  const key = R.calibKey({ provider: 'x', model: 'y', modality: 'image' });
  assert.strictEqual(key, 'x|y|image');
});

test('阶段3：图片 Token 计入 itemTokens', () => {
  const m = { id: 'img1', role: 'user', content: '看图', images: [{ url: 'data:image/png;base64,xx' }, { url: 'data:image/png;base64,yy' }] };
  const t = R.itemTokens(m);
  assert.ok(t >= 2000, 'expect image allowance, got ' + t);
});
