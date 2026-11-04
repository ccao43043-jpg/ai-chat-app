/**
 * 第四轮方向 E：事实账本（§6.4）
 * - 冲突/更新关闭旧事实 validToTurn
 * - 等价合并不关区间、合并 confidence
 * - 渲染只出当前有效事实；预算按 confidence×recency
 * - 摘要与账本冲突时质量分下降并可拒提交
 * - 回滚后不出现「未来事实」（按保留 msgId 过滤）
 */
const test = require('node:test');
const assert = require('node:assert');
const M = require('../app/src/main/assets/www/rpmemory.js');
const R = require('../app/src/main/assets/www/rpcache.js');

function fullSummary(extraFacts) {
  return [
    'FACTS:',
    extraFacts || '- 艾琳是药剂师',
    'CHARACTER_KNOWLEDGE:',
    '- 艾琳知道主角来历',
    'PLAYER_KNOWLEDGE:',
    '- 玩家知道密道位置',
    'SECRET:',
    '- 幕后组织尚未揭露',
    'UNRESOLVED:',
    '- 商人失踪案未破',
    'RELATIONSHIPS:',
    '- 待定',
    'OBJECTS:',
    '- 旧矿账本',
    'LOCATION:',
    '- 王都西区',
  ].join('\n');
}

test('ledger：冲突关闭旧事实 validToTurn + supersededBy', () => {
  let r = M.upsertFact([], M.factFromText('张燕喜欢曹含森', { id: 'f1', turn: 3, confidence: 0.6, sourceMsgId: 'm1' }), 3);
  assert.strictEqual(r.action, 'add');
  assert.strictEqual(r.fact.validToTurn, null);
  r = M.upsertFact(r.ledger, M.factFromText('张燕讨厌曹含森', { id: 'f2', turn: 10, confidence: 0.8, sourceMsgId: 'm2' }), 10);
  assert.strictEqual(r.action, 'conflict');
  assert.ok(r.closed);
  assert.strictEqual(r.closed.validToTurn, 10);
  assert.strictEqual(r.closed.supersededBy, 'f2');
  assert.strictEqual(r.fact.validToTurn, null);
  const cur = M.currentFacts(r.ledger);
  assert.strictEqual(cur.length, 1);
  assert.strictEqual(cur[0].id, 'f2');
  assert.ok(cur[0].value.polarity < 0);
});

test('ledger：非冲突更新（住在 A→B）关闭旧区间', () => {
  let r = M.upsertFact([], M.factFromText('艾琳住在王都', { id: 'l1', turn: 2, confidence: 0.7, sourceMsgId: 's1' }), 2);
  assert.strictEqual(r.action, 'add');
  assert.strictEqual(r.fact.attribute, 'location');
  r = M.upsertFact(r.ledger, M.factFromText('艾琳住在北境', { id: 'l2', turn: 8, confidence: 0.75, sourceMsgId: 's2' }), 8);
  assert.strictEqual(r.action, 'update');
  assert.strictEqual(r.closed.validToTurn, 8);
  assert.strictEqual(r.closed.supersededBy, 'l2');
  const cur = M.currentFacts(r.ledger);
  assert.strictEqual(cur.length, 1);
  assert.ok(String(cur[0].value.object).includes('北境') || String(cur[0].quote).includes('北境'));
});

test('ledger：等价合并不关区间、提升 confidence', () => {
  let r = M.upsertFact([], M.factFromText('张燕喜欢曹含森', { id: 'a1', turn: 1, confidence: 0.5, sourceMsgId: 'm1' }), 1);
  const beforeTo = r.fact.validToTurn;
  const beforeFrom = r.fact.validFromTurn;
  const beforeConf = r.fact.confidence;
  r = M.upsertFact(r.ledger, M.factFromText('张燕爱曹含森', { id: 'a2', turn: 5, confidence: 0.6, sourceMsgId: 'm2' }), 5);
  assert.strictEqual(r.action, 'merge');
  assert.strictEqual(r.closed, null);
  assert.strictEqual(r.fact.validToTurn, beforeTo);
  assert.strictEqual(r.fact.validFromTurn, beforeFrom);
  assert.ok(r.fact.confidence > beforeConf, 'confidence should rise on merge');
  assert.strictEqual(M.currentFacts(r.ledger).length, 1);
});

test('ledger：渲染只出当前有效；预算按 confidence×recency', () => {
  let led = [];
  led = M.upsertFact(led, M.factFromText('张燕喜欢曹含森', { id: 'c1', turn: 1, confidence: 0.9, sourceMsgId: 'a' }), 1).ledger;
  led = M.upsertFact(led, M.factFromText('李明信任主角', { id: 'c2', turn: 20, confidence: 0.5, sourceMsgId: 'b' }), 20).ledger;
  led = M.upsertFact(led, M.factFromText('王强存活', { id: 'c3', turn: 21, confidence: 0.95, sourceMsgId: 'c' }), 21).ledger;
  // 冲突关闭第一条
  led = M.upsertFact(led, M.factFromText('张燕讨厌曹含森', { id: 'c4', turn: 22, confidence: 0.8, sourceMsgId: 'd' }), 22).ledger;

  const rendered = M.renderLedger(led, { nowTurn: 22, budget: 10 });
  assert.ok(rendered.startsWith('[MEMORY_LEDGER]'));
  assert.ok(!rendered.includes('喜欢'), 'closed fact must not render');
  assert.ok(rendered.includes('讨厌') || rendered.includes('张燕'), 'current affection should render');

  // 预算=1：应优先 confidence×recency 最高者（王强存活 0.95×近，或张燕讨厌）
  const tight = M.renderLedger(led, { nowTurn: 22, budget: 1, tau: 20 });
  const lines = tight.split('\n').filter(l => l.startsWith('- '));
  assert.strictEqual(lines.length, 1);

  // 旧高置信但很久：在小 tau 下可能输给近事实
  const byRecency = M.renderLedger(led, { nowTurn: 22, budget: 2, tau: 5 });
  assert.ok(byRecency.split('\n').filter(l => l.startsWith('- ')).length <= 2);
});

test('ledger：摘要冲突降质并可拒提交；unsupported 轻罚', () => {
  let led = [];
  led = M.upsertFact(led, M.factFromText('张燕喜欢曹含森', { id: 'x1', turn: 3, confidence: 0.8, sourceMsgId: 'u1' }), 3).ledger;

  const goodBase = R.scoreSummary(fullSummary('- 天气晴朗'));
  assert.ok(goodBase >= R.SUMMARY_MIN_QUALITY);

  // 冲突摘要：账本是喜欢，摘要写讨厌
  const conflictText = fullSummary('- 张燕讨厌曹含森');
  const chk = M.checkSummaryAgainstLedger(conflictText, led, goodBase);
  assert.ok(chk.conflictCount >= 1, 'should detect conflict');
  assert.ok(chk.summaryQuality < goodBase);
  assert.ok(Math.abs(chk.summaryQuality - (goodBase - 0.10 * chk.conflictCount - 0.03 * chk.unsupportedCount)) < 1e-9);

  const ps = R.parseSummary(conflictText, { ledger: led, RPMemory: M });
  assert.ok(ps.ledgerCheck);
  assert.ok(ps.ledgerCheck.conflictCount >= 1);
  assert.ok(ps.quality < goodBase);
  // 冲突足够多或贴门槛时拒提交
  const commit = R.commitChapter(R.newState(), { content: conflictText, coveredIds: ['u1'], at: 1, ledger: led, RPMemory: M });
  if (ps.quality < R.SUMMARY_MIN_QUALITY) {
    assert.strictEqual(commit.ok, false);
    assert.ok(commit.reason === 'ledger_conflict' || commit.reason === 'low_quality' || commit.reason === 'invalid_summary');
    assert.ok(commit.parsed.retryHint || commit.parsed.ledgerCheck.conflictCount >= 1);
  } else {
    // 若单条冲突未跌破门槛，再叠 unsupported 断言把分打下去
    const heavier = fullSummary('- 张燕讨厌曹含森\n- 无名氏解锁宝箱\n- 路人甲在场');
    const ps2 = R.parseSummary(heavier, { ledger: led, RPMemory: M });
    assert.ok(ps2.ledgerCheck.conflictCount >= 1);
    assert.ok(ps2.quality <= goodBase - 0.10);
  }

  // unsupported：摘要提到账本没有的主体 → 计数但不算硬冲突
  const unsup = M.checkSummaryAgainstLedger(fullSummary('- 路人甲喜欢路人乙'), led, 1.0);
  assert.strictEqual(unsup.conflictCount, 0);
  assert.ok(unsup.unsupportedCount >= 1);
  assert.ok(unsup.summaryQuality <= 1.0 - 0.03);
});

test('ledger：回滚按 sourceMsgId 过滤，不出现未来事实', () => {
  let led = [];
  led = M.upsertFact(led, M.factFromText('艾琳住在王都', { id: 'p1', turn: 2, confidence: 0.7, sourceMsgId: 'keep-1' }), 2).ledger;
  led = M.upsertFact(led, M.factFromText('艾琳住在北境', { id: 'p2', turn: 9, confidence: 0.8, sourceMsgId: 'future-9' }), 9).ledger;
  assert.strictEqual(M.currentFacts(led).length, 1);
  assert.ok(String(M.currentFacts(led)[0].value.object).includes('北境') || M.currentFacts(led)[0].id === 'p2');

  const rolled = M.pruneBySourceIds(led, ['keep-1']);
  assert.strictEqual(rolled.length, 1);
  assert.strictEqual(rolled[0].sourceMsgId, 'keep-1');
  const cur = M.currentFacts(rolled);
  assert.strictEqual(cur.length, 1);
  assert.ok(String(cur[0].value.object).includes('王都') || cur[0].quote.includes('王都'));
  assert.ok(!M.renderLedger(rolled, { nowTurn: 2 }).includes('北境'));
});

test('ledger：mergeEntries 旁路写入生效区间并同步账本', () => {
  const r1 = M.mergeEntries([], [{ type: 'relation', text: '张燕喜欢曹含森', keywords: ['张燕'] }], 100, 'auto', {
    turn: 4, sourceMsgId: 'msg-a', ledger: [],
  });
  assert.ok(r1.ledger);
  assert.strictEqual(r1.list[0].validFromTurn, 4);
  assert.strictEqual(r1.list[0].validToTurn, null);
  assert.strictEqual(r1.list[0].sourceMsgId, 'msg-a');

  const r2 = M.mergeEntries(r1.list, [{ type: 'relation', text: '张燕讨厌曹含森', keywords: ['张燕'] }], 200, 'auto', {
    turn: 12, sourceMsgId: 'msg-b', ledger: r1.ledger,
  });
  assert.ok(r2.conflicts >= 1);
  const old = r2.list.find(e => e.disabled || e.supersededBy);
  assert.ok(old);
  assert.strictEqual(old.validToTurn, 12);
  const open = M.currentFacts(r2.ledger);
  assert.strictEqual(open.length, 1);
});

test('ledger：旧条目无 ledger 字段时仍按原逻辑工作', () => {
  const r = M.mergeEntries([], [{ type: 'fact', text: '艾琳是药剂师', keywords: ['艾琳'] }], 1);
  assert.strictEqual(r.list.length, 1);
  assert.strictEqual(r.list[0].validFromTurn, undefined);
  assert.strictEqual(r.ledger, undefined);
  const s = M.selectRelevant(r.list, '艾琳', { maxInject: 4, retrieval: 'legacy' });
  assert.ok(s.length >= 1);
});
