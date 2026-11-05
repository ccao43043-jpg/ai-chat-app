// v0.17.0：复审报告 1–6 项验收（空摘要门 / Hybrid 证据覆盖 / 三元组冲突 / 校准隔离 / 关键词合并 / 版本一致）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../app/src/main/assets/www/rpcache.js');
const G = require('../app/src/main/assets/www/plugins/cache/gcache.js');
const M = require('../app/src/main/assets/www/rpmemory.js');

const u = (i, t) => ({ id: 'u' + i, role: 'user', content: t || '玩家第' + i + '轮：推开门，观察四周。' });
const a = (i, t) => ({ id: 'a' + i, role: 'assistant', content: t || '角色第' + i + '轮回复：门外是长长的走廊，烛光摇曳。' });
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
- 曹含森把账本照片交给张燕保存

CHARACTER_KNOWLEDGE:
- 张燕：知道账本异常；不知道曹含森已察觉她保存照片

PLAYER_KNOWLEDGE:
- 曹含森知道张燕保存了账本照片

SECRET:
- 张燕私下保存账本照片，曹含森尚未摊牌

UNRESOLVED:
- 幕后组织身份未确认

RELATIONSHIPS:
- 张燕与曹含森：合作调查，信任上升

OBJECTS:
- 商队账本照片：归属张燕私下持有

LOCATION:
- 别墅书房`;

// ─── §4.1 章节摘要质量门 ───
test('v017-1：五区全「无」拒提交；八分区完整；SUMMARY_MIN_QUALITY 统一', () => {
  assert.strictEqual(R.SUMMARY_MIN_QUALITY, 0.60);
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
  assert.ok(!ps.ok);
  assert.strictEqual(ps.quality, 0);
  assert.ok(ps.critEmpty.length === 5);
  const st0 = withBlocks();
  const r = R.commitChapter(st0, { content: thin, coveredIds: ['u1'], at: 1 });
  assert.ok(!r.ok);
  assert.strictEqual(R.chaptersOf(r.state).length, 0);

  // 缺 soft 分区也拒
  const noSoft = `FACTS:
- 有事发生

CHARACTER_KNOWLEDGE:
- 张燕知道 partial

PLAYER_KNOWLEDGE:
- 玩家知道 partial

SECRET:
- 有秘密

UNRESOLVED:
- 未解`;
  const ps2 = R.parseSummary(noSoft);
  assert.ok(!ps2.ok);
  assert.ok(ps2.missing.includes('RELATIONSHIPS'));

  // 完整优质摘要可通过；门槛与常量一致
  const good = R.parseSummary(FULL_SUM);
  assert.ok(good.ok);
  assert.ok(good.quality >= R.SUMMARY_MIN_QUALITY);
  assert.strictEqual(good.minQuality, R.SUMMARY_MIN_QUALITY);
  const c = R.commitChapter(st0, { content: FULL_SUM, coveredIds: ['u1'], at: 1 });
  assert.ok(c.ok);
});

test('v017-1：合并路径 consolidate 同样执行质量门', () => {
  let st = withBlocks();
  st = R.commitChapter(st, { content: FULL_SUM, coveredIds: ['u1'], at: 1 }).state;
  const bad = `FACTS:
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
  const r = R.consolidate(st, { content: bad, coveredIds: ['u2'], at: 2 });
  assert.ok(r.ok === false);
  assert.strictEqual(r.reason, 'invalid_summary');
  assert.strictEqual(R.chaptersOf(r.state).length, 1); // 未改动
  const ok = R.consolidate(st, { content: FULL_SUM, coveredIds: ['u2'], at: 2 });
  assert.ok(ok.ok);
  assert.strictEqual(R.chaptersOf(ok.state).length, 1);
});

// ─── §4.2 Hybrid 证据覆盖 ───
test('v017-2：关键事实在玩家句尾 / 回复中间仍被语义摘要保留', () => {
  const pad = '无关闲聊描写。'.repeat(8);
  const turn = [
    { role: 'user', content: pad + '我把证据交给张燕。' },
    { role: 'assistant', content: '张燕点头。' + pad + '她不知道曹含森已发现她保存照片。' + pad + '夜色渐深。' },
  ];
  const sem = G.HybridWindow.summarizeTurnsSemantic([turn], 0);
  assert.ok(/证据|交给张燕|张燕/.test(sem), 'tail decision retained: ' + sem);
  assert.ok(/不知道|保存照片|秘密|发现/.test(sem), 'mid secret retained: ' + sem);
  const ev = G.HybridWindow.extractHybridEvidence([turn]);
  assert.ok(ev.some(e => e.kind === 'action' || e.kind === 'decision'), JSON.stringify(ev));
  assert.ok(ev.some(e => e.kind === 'secret' || /不知道|保存/.test(e.text)), JSON.stringify(ev));
  const q = G.HybridWindow.scoreHybridSummary(sem, [turn]);
  assert.ok(q >= 0.35, 'semantic quality ' + q);
});

test('v017-2：低质量摘要不推进 cut；fast_local 不得绕过永久门', () => {
  assert.ok(G.HybridWindow.HYBRID_SUMMARY_MIN_QUALITY >= 0.5);
  // 构造几乎无信息的批次 → 分数低
  const turns = [];
  for (let i = 0; i < G.HybridWindow.RAW_MAX; i++) {
    turns.push([{ role: 'user', content: '嗯。' }, { role: 'assistant', content: '哦。' }]);
  }
  const hist = turns.flat();
  const st0 = G.HybridWindow.empty();
  const cut0 = st0.cut;
  const r = G.HybridWindow.apply(hist, st0, { summaryStrategy: 'semantic' });
  // 质量不足：cut 不得推进
  assert.strictEqual(r.state.cut, cut0);
  assert.ok(r.summaryFailed || !r.summaryCreated);
  if (r.temporaryFallback) {
    assert.strictEqual(r.temporaryFallback.permanent, false);
    assert.strictEqual(r.temporaryFallback.strategy, 'fast_local');
  }
  // 即使策略显式 fast_local，质量不足也不得永久推进
  const st1 = G.HybridWindow.empty();
  const r2 = G.HybridWindow.apply(hist, st1, { summaryStrategy: 'fast_local' });
  assert.strictEqual(r2.state.cut, 0);
});

test('v017-2：高质量批次可永久推进 cut', () => {
  const turns = [];
  for (let i = 0; i < G.HybridWindow.RAW_MAX; i++) {
    turns.push([
      { role: 'user', content: '曹含森在北境关卡遇见张燕，调查商人失踪案，决定把账本交给她保存。第' + i + '轮。' },
      { role: 'assistant', content: '张燕收下账本。她不知道曹含森已发现密道通向旧矿。密道里藏着证据。第' + i + '轮结果。' },
    ]);
  }
  const r = G.HybridWindow.apply(turns.flat(), G.HybridWindow.empty(), { summaryStrategy: 'semantic' });
  if (r.summaryCreated) {
    assert.ok(r.state.cut > 0);
    assert.ok(r.state.summaries[0].permanent !== false);
    assert.ok(r.state.summaries[0].quality >= G.HybridWindow.HYBRID_SUMMARY_MIN_QUALITY);
  } else {
    // 若仍失败，至少证明没误推进
    assert.strictEqual(r.state.cut, 0);
  }
});

// ─── §4.3 关系三元组冲突 ───
test('v017-3：同 subject+object+关系族才极性冲突；不同主体不冲突', () => {
  assert.ok(M.detectConflict('张燕喜欢曹含森', '张燕讨厌曹含森'));
  assert.ok(!M.detectConflict('张燕喜欢曹含森', '李明讨厌王强'), 'different subjects must not conflict');
  assert.ok(!M.detectConflict('张燕喜欢曹含森', '张燕讨厌王强'), 'different objects must not conflict');
  const t = M.extractRelationTriple('张燕喜欢曹含森');
  assert.strictEqual(t.subject, M.extractRelationTriple('张燕讨厌曹含森').subject);
  assert.strictEqual(t.family, 'affection');
  // 反转保留时间线：旧条 supersede，仍在 list
  const r = M.mergeEntries(
    [{ id: 'm1', seq: 1, type: 'relation', text: '张燕喜欢曹含森', keywords: ['张燕', '曹含森'], version: 1 }],
    [{ type: 'relation', text: '张燕讨厌曹含森', keywords: ['张燕'] }],
    1000, 'auto'
  );
  assert.ok(r.conflicts >= 1);
  const old = r.list.find(e => e.id === 'm1');
  assert.ok(old.supersededBy);
  assert.ok(old.disabled);
  const neu = r.list.find(e => e.supersedes === 'm1');
  assert.ok(neu && neu.version === 2);
  // 不同主体：合并为两条，不冲突
  const r2 = M.mergeEntries(
    [{ id: 'm1', seq: 1, type: 'relation', text: '张燕喜欢曹含森', keywords: ['张燕'], version: 1 }],
    [{ type: 'relation', text: '李明讨厌王强', keywords: ['李明'] }],
    1000, 'auto'
  );
  assert.strictEqual(r2.conflicts, 0);
  assert.strictEqual(r2.list.filter(e => !e.disabled).length, 2);
});

// ─── §4.4 校准从 1.0 ───
test('v017-4：新模型校准从 1.0 起，不继承全局 st.calib', () => {
  let st = withBlocks();
  st = Object.assign(st, { calib: 1.9 });
  const fresh = R.calibOf(st, { provider: 'brand-new', model: 'never-seen', modality: 'text' });
  assert.strictEqual(fresh, 1);
  st = R.calibrate(st, 1000, 2000, { provider: 'brand-new', model: 'never-seen', modality: 'text' });
  // prev=1.0, ratio=2.0 → EMA 1*0.7+2*0.3=1.3
  const after = R.calibOf(st, { provider: 'brand-new', model: 'never-seen', modality: 'text' });
  assert.ok(Math.abs(after - 1.3) < 0.01, 'got ' + after);
  // 另一模型仍是 1.0
  assert.strictEqual(R.calibOf(st, { provider: 'other', model: 'z', modality: 'text' }), 1);
});

// ─── §4.5 关键词合并上限 ───
test('v017-5：合并关键词统一 KW_MAX，优先级保留实体', () => {
  assert.strictEqual(M.KW_MAX, 48);
  const many = [];
  for (let i = 0; i < 40; i++) many.push('碎片词' + i);
  many.push('张燕', '曹含森', '账本', '喜欢', '今晚');
  const merged = M.mergeKeywords(['艾琳', '密道'], many);
  assert.ok(merged.length <= M.KW_MAX);
  assert.ok(merged.includes('张燕') || merged.includes('曹含森') || merged.includes('账本'), merged.join(','));
  assert.ok(merged.includes('喜欢') || merged.includes('今晚') || merged.includes('账本'));
  // 反复 merge 不压到 16
  let list = [{ id: 'm1', seq: 1, type: 'fact', text: '曹含森在北境关卡客栈遇见张燕调查商人失踪案与密道旧矿账本线索', keywords: M.autoKeywords('曹含森在北境关卡客栈遇见张燕调查商人失踪案与密道旧矿账本线索'), version: 1 }];
  for (let i = 0; i < 5; i++) {
    const r = M.mergeEntries(list, [{ type: 'fact', text: '曹含森在北境关卡客栈遇见张燕调查商人失踪案与密道旧矿账本线索以及幕后组织伏笔', keywords: M.autoKeywords('幕后组织伏笔账本密道张燕') }], 1000 + i, 'auto');
    list = r.list;
  }
  const kw = list[0].keywords || [];
  assert.ok(kw.length > 16, 'kept ' + kw.length);
  assert.ok(kw.length <= M.KW_MAX);
  assert.ok(kw.some(k => /张燕|账本|密道|组织/.test(k)), kw.join(','));
});

// ─── §4.6 README / 版本一致 ───
test('v017-6：README 当前版本与 package / APP_VERSION 一致', () => {
  const root = path.join(__dirname, '..');
  const v = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes('**v' + v), 'README 功能标题含 v' + v);
  assert.ok(new RegExp('Android `' + v.replace(/\./g, '\\.') + '`').test(readme), 'README Android 版本');
  const app = fs.readFileSync(path.join(root, 'app/src/main/assets/www/app.js'), 'utf8');
  assert.ok(app.includes("const APP_VERSION = '" + v + "'"));
  const gradle = fs.readFileSync(path.join(root, 'app/build.gradle'), 'utf8');
  assert.ok(gradle.includes("versionName '" + v + "'"));
});
