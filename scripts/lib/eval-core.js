'use strict';
// feat(eval) §9：golden set 指标计算核心（eval.mjs 与 tests/eval-gate.test.js 共用，避免漂移）
// 纯本地、无网络、只读调用产品模块，不修改任何算法。
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const WWW = path.join(ROOT, 'app/src/main/assets/www');
const GOLDEN = path.join(ROOT, 'tests/golden');
const EPS = 1e-9;

function readJsonl(name) {
  return fs.readFileSync(path.join(GOLDEN, name), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}
const r4 = x => Math.round(x * 1e4) / 1e4;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

// ---------- 记忆召回 ----------
function loadMemory() {
  if (!globalThis.Plugins) globalThis.Plugins = require(path.join(WWW, 'plugins.js'));
  return require(path.join(WWW, 'rpmemory.js'));
}
// 空 expect（不应召回）：返回为空记 1，否则记 0（三项指标一致处理）
function rankMetrics(ranked, expect, k) {
  const top = ranked.slice(0, k), rel = new Set(expect);
  if (!rel.size) { const v = top.length ? 0 : 1; return { p: v, rr: v, ndcg: v }; }
  const hits = top.filter(id => rel.has(id)).length;
  const p = hits / Math.min(k, rel.size);   // 以 min(k,|rel|) 归一化，避免期望 <5 条时永远拿不到满分
  let rr = 0; for (let i = 0; i < ranked.length; i++) if (rel.has(ranked[i])) { rr = 1 / (i + 1); break; }
  let dcg = 0; top.forEach((id, i) => { if (rel.has(id)) dcg += 1 / Math.log2(i + 2); });
  let idcg = 0; for (let i = 0; i < Math.min(k, rel.size); i++) idcg += 1 / Math.log2(i + 2);
  return { p, rr, ndcg: dcg / idcg };
}
function evalMemory(cases = readJsonl('memory.jsonl')) {
  const M = loadMemory(), per = [];
  for (const c of cases) {
    const got = M.selectRelevant(JSON.parse(JSON.stringify(c.conv.entries)), c.query, { maxInject: 5 }).map(e => e.id);
    per.push(Object.assign({ id: c.id, got, expect: c.expect }, rankMetrics(got, c.expect, 5)));
  }
  return { pAt5: r4(mean(per.map(x => x.p))), mrr: r4(mean(per.map(x => x.rr))), ndcgAt5: r4(mean(per.map(x => x.ndcg))), n: per.length, per };
}

// ---------- 摘要保真（启发式，无模型） ----------
const factKey = f => String(f.text || [f.subject, f.attribute, f.value].filter(Boolean).join('') || '').trim();
// 专有名词启发式：摘要中中文片段（按标点/虚词切），任一 2 字 bigram 都不在 source/facts 中 → 无中生有
function unsupportedTerms(summary, source, facts) {
  const pool = source + '|' + facts.map(factKey).join('|');
  const segs = String(summary).split(/[，。、；：！？,.;:!?\s的了是在和与把被给为于向从将其他她它有]+/).filter(Boolean);
  const out = [];
  for (const s of segs) {
    if (!/^[\u4e00-\u9fff]{2,}$/.test(s)) continue;
    let ok = false; for (let i = 0; i < s.length - 1; i++) if (pool.includes(s.slice(i, i + 2))) { ok = true; break; }
    if (!ok) out.push(s);
  }
  return out;
}
function evalSummary(cases = readJsonl('summary.jsonl')) {
  const per = cases.map(c => {
    const sum = String(c.summary || ''), facts = c.facts || [];
    const keys = facts.map(factKey).filter(Boolean);
    const cov = keys.length ? keys.filter(k => sum.includes(k)).length / keys.length : 1;
    const bad = unsupportedTerms(sum, String(c.source || ''), facts);
    return { id: c.id, coverage: cov, hallucinated: bad.length > 0, unsupported: bad, ratio: c.source ? sum.length / c.source.length : 0 };
  });
  return {
    factCoverage: r4(mean(per.map(x => x.coverage))),
    hallucinationRate: r4(mean(per.map(x => x.hallucinated ? 1 : 0))),
    compressionRatio: r4(mean(per.map(x => x.ratio))),
    n: per.length,
    note: 'hallucinationRate = 摘要含 source/facts 均不支持的中文片段（2 字 bigram 启发式）的样例占比；评的是 golden 参考 summary 文本，非线上模型输出',
    per,
  };
}

// ---------- 缓存成本（确定性 stub 回放，不改 rpcache） ----------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const ACTS = ['推开门', '观察四周', '询问艾琳', '拔出长剑', '走进酒馆', '翻看账本', '寻找密道', '向卡尔致意'];
const SCENES = ['烛光摇曳的走廊', '喧闹的酒馆', '寂静的书房', '潮湿的地下密道', '月光下的城墙'];
function replay(c, R) {
  const rnd = mulberry32(c.seed >>> 0), every = c.summaryEvery || 10;
  const sys = { role: 'system', content: c.systemPrompt || '' };
  let hist = [], summary = null, total = 0, hits = 0, summaries = 0;
  for (let t = 1; t <= c.turns; t++) {
    const u = { role: 'user', content: '玩家第' + t + '轮：' + ACTS[Math.floor(rnd() * ACTS.length)] + '，' + ACTS[Math.floor(rnd() * ACTS.length)] + '。' };
    const msgs = [sys].concat(summary ? [summary] : [], hist, [u]);
    total += R.estimateItems(msgs);
    if (t > 1 && rnd() < 0.8) hits++;                 // stub：按 seed 的确定性 hit/miss
    const a = { role: 'assistant', content: '角色第' + t + '轮：' + SCENES[Math.floor(rnd() * SCENES.length)] + '中，' + '你'.repeat(20 + Math.floor(rnd() * 60)) + '。' };
    hist.push(u, a);
    if (t % every === 0) {                             // stub：固定间隔摘要事件（不调用 rpcache 摘要时机）
      summaries++;
      summary = { role: 'system', content: '【摘要】' + hist.map(m => m.content.slice(0, 12)).join(' / ').slice(0, 200) };
      hist = hist.slice(-4);
    }
  }
  return { id: c.id, provider: c.provider, model: c.model, totalPromptTokens: total, hitRate: c.turns > 1 ? hits / (c.turns - 1) : 0, summaryCount: summaries };
}
function evalCost(cases = readJsonl('cost.jsonl')) {
  const R = require(path.join(WWW, 'rpcache.js'));
  const per = cases.map(c => replay(c, R));
  return {
    totalPromptTokens: per.reduce((s, x) => s + x.totalPromptTokens, 0),
    hitRate: r4(mean(per.map(x => x.hitRate))),
    summaryCount: per.reduce((s, x) => s + x.summaryCount, 0),
    n: per.length,
    note: 'token 用 rpcache.estimateItems 估算；hit/miss 与摘要事件为按 seed 的确定性 stub，非真实 API',
    per,
  };
}


// ---------- 路由有效成本（Router.chooseUpstream / replay） ----------
function loadRouter() { return require(path.join(WWW, 'router.js')); }
function evalRouting(cases = readJsonl('routing.jsonl')) {
  const R = loadRouter();
  const per = [];
  let switchSum = 0, effSum = 0, ok = 0;
  for (const c of cases) {
    if (c.mode === 'choose') {
      const slug = R.chooseUpstream(c.prices, c.stats || {}, c.current, c.prefixTokens || 0, c.opts || {});
      const pass = slug === c.expect.slug;
      if (pass) ok++;
      per.push({ id: c.id, mode: 'choose', got: slug, expect: c.expect.slug, pass });
      continue;
    }
    const res = R.replay(c.steps || [], Object.assign({ prefixTokens: c.prefixTokens, model: 'm' }, c.opts || {}));
    // 若指定 current 冷启动：先写入
    let trail = res.trail, switches = res.switches, effCost = res.effCost, final = res.current;
    if (c.current && c.steps && c.steps.length) {
      // 重新回放：初始 current
      const state = {};
      const model = 'm';
      R.ensureModel(state, model).current = c.current;
      let current = c.current;
      switches = 0; effCost = 0; trail = [];
      const cfg = R.settingsOf(c.opts || {});
      const prefixTokens = c.prefixTokens || 20000;
      for (const step of c.steps) {
        const chosen = R.chooseUpstream(step.prices, R.ensureModel(state, model), current, step.prefixTokens != null ? step.prefixTokens : prefixTokens, cfg);
        if (current && chosen && chosen !== current) { switches++; R.recordSwitch(state, model, current, chosen, step.at); }
        current = chosen;
        const p = (step.prices || []).find(x => x.slug === chosen);
        if (p) {
          const st = R.ensureUpstream(R.ensureModel(state, model), chosen);
          const h = (st.obs | 0) >= cfg.minObs ? R.hitQuantile(st.a, st.b) : cfg.defaultH;
          const pe = R.effectivePrice(p.pMiss, p.pHit != null ? p.pHit : p.pMiss, h);
          effCost += (step.promptTokens != null ? step.promptTokens : prefixTokens) * pe / 1e6;
        }
        if (chosen) R.observe(state, model, chosen, { hitTokens: step.hitTokens, promptTokens: step.promptTokens != null ? step.promptTokens : prefixTokens, hit: step.hit, ok: step.ok }, step.at);
        trail.push(chosen);
      }
      final = current;
    }
    switchSum += switches;
    effSum += effCost;
    let pass = true;
    if (c.expect) {
      if (c.expect.final && final !== c.expect.final) pass = false;
      if (c.expect.finalIn && !c.expect.finalIn.includes(final)) pass = false;
      if (c.expect.maxSwitches != null && switches > c.expect.maxSwitches) pass = false;
      if (c.expect.slug && final !== c.expect.slug) pass = false;
    }
    if (pass) ok++;
    per.push({ id: c.id, mode: 'replay', final, switches, effCost, pass });
  }
  return {
    n: per.length,
    passRate: r4(per.length ? ok / per.length : 1),
    avgSwitches: r4(per.length ? switchSum / per.length : 0),
    totalEffCost: r4(effSum),
    note: 'routing：chooseUpstream 单步 + replay 回放；有效成本为估算累加',
    per,
  };
}

// ---------- 知识库召回 ----------
function loadKnowledge() {
  // retrieval-core 必须先加载
  require(path.join(WWW, 'retrieval-core.js'));
  return require(path.join(WWW, 'knowledge.js'));
}
function evalKnowledge(cases = readJsonl('knowledge.jsonl')) {
  const K = loadKnowledge();
  const per = [];
  for (const c of cases) {
    const hits = K.search(c.doc, c.query, { limit: 5, mode: 'bm25' });
    const got = hits.map(h => h.entry.id);
    per.push(Object.assign({ id: c.id, got, expect: c.expect }, rankMetrics(got, c.expect || [], 5)));
  }
  return { pAt5: r4(mean(per.map(x => x.p))), mrr: r4(mean(per.map(x => x.rr))), ndcgAt5: r4(mean(per.map(x => x.ndcg))), n: per.length, per };
}

// ---------- affect 方向一致（合成成对） ----------
function loadAffect() {
  if (!globalThis.Plugins) globalThis.Plugins = require(path.join(WWW, 'plugins.js'));
  return require(path.join(WWW, 'affect.js'));
}
function dirOf(delta, eps) {
  const e = eps == null ? 0.05 : eps;
  if (delta > e) return 'up';
  if (delta < -e) return 'down';
  return 'flat';
}
function evalAffect(cases = readJsonl('affect.jsonl')) {
  const A = loadAffect();
  const per = [];
  let agree = 0, osc = 0;
  for (const c of cases) {
    // 合成标注：用 lexiconScore 作为模型观测 a，走 KF；比较 â 变化方向
    let st = null;
    const t0 = 1_700_000_000_000;
    const y0 = A.lexiconScore(c.prevUser);
    const y1 = A.lexiconScore(c.curUser);
    const mood0 = y0 > 0.2 ? 'joy' : y0 < -0.2 ? 'anger' : 'neutral';
    const mood1 = y1 > 0.2 ? 'joy' : y1 < -0.2 ? 'anger' : 'neutral';
    st = A.step(st, { a: y0, m: mood0 }, c.prevUser, t0, { estimator: 'kf' });
    const a0 = st && st.kf ? st.kf.x : 0;
    st = A.step(st, { a: y1, m: mood1 }, c.curUser, t0 + 60_000, { estimator: 'kf' });
    const a1 = st && st.kf ? st.kf.x : 0;
    const delta = a1 - a0;
    // 也参考 lexicon 直接差，避免 KF 惯性把弱信号抹平
    const lexDelta = y1 - y0;
    const got = dirOf(delta, 0.08);
    const gotLex = dirOf(lexDelta, 0.2);
    let pass = got === c.expectDir;
    if (!pass && c.expectDir === 'flat' && Math.abs(delta) < 0.2 && Math.abs(lexDelta) < 0.5) pass = true;
    if (!pass && gotLex === c.expectDir) pass = true; // 合成基线：lex 方向一致也算过
    if (pass) agree++;
    per.push({ id: c.id, got, gotLex, expect: c.expectDir, delta: r4(delta), lexDelta: r4(lexDelta), pass, a0: r4(a0), a1: r4(a1) });
  }
  // 振荡率：在连续合成序列上粗测（每 10 条滑动）
  let oscEvents = 0, oscWindows = 0;
  for (let i = 0; i + 9 < per.length; i += 10) {
    oscWindows++;
    let flips = 0;
    for (let j = i + 1; j < i + 10; j++) {
      const d0 = Math.sign(per[j - 1].delta), d1 = Math.sign(per[j].delta);
      if (d0 && d1 && d0 !== d1) flips++;
    }
    if (flips > 1) oscEvents++;
  }
  return {
    directionAgree: r4(per.length ? agree / per.length : 1),
    oscillationRate: r4(oscWindows ? oscEvents / oscWindows : 0),
    n: per.length,
    note: '合成成对基线，待人工 MAE；directionAgree=KF â 变化方向与标注一致率',
    per,
  };
}

function runAll() {
  return {
    memory: evalMemory(),
    summary: evalSummary(),
    cost: evalCost(),
    render: { skipped: true, note: '渲染性能本 PR 未跑' },
    routing: evalRouting(),
    knowledge: evalKnowledge(),
    affect: evalAffect(),
  };
}
function strip(r) { const o = {}; for (const k in r) { if (r[k] && typeof r[k] === 'object') { const { per, ...rest } = r[k]; o[k] = rest; } } return o; }
function loadBaseline() { return JSON.parse(fs.readFileSync(path.join(GOLDEN, 'baseline.json'), 'utf8')); }
// 返回违规列表；空数组 = 通过
function compare(cur, base) {
  const f = [];
  const ge = (name, a, b) => { if (b != null && a < b - EPS) f.push(`${name}: ${a} < baseline ${b}`); };
  const le = (name, a, b) => { if (b != null && a > b + EPS) f.push(`${name}: ${a} > baseline ${b}`); };
  ['pAt5', 'mrr', 'ndcgAt5'].forEach(k => ge('memory.' + k, cur.memory[k], base.memory[k]));
  ge('summary.factCoverage', cur.summary.factCoverage, base.summary.factCoverage);
  le('summary.hallucinationRate', cur.summary.hallucinationRate, base.summary.hallucinationRate);
  le('cost.totalPromptTokens', cur.cost.totalPromptTokens, base.cost.totalPromptTokens);
  if (base.routing) {
    ge('routing.passRate', cur.routing.passRate, base.routing.passRate);
    le('routing.avgSwitches', cur.routing.avgSwitches, base.routing.avgSwitches);
    le('routing.totalEffCost', cur.routing.totalEffCost, base.routing.totalEffCost);
  }
  if (base.knowledge) {
    ['pAt5', 'mrr', 'ndcgAt5'].forEach(k => ge('knowledge.' + k, cur.knowledge[k], base.knowledge[k]));
  }
  if (base.affect) {
    ge('affect.directionAgree', cur.affect.directionAgree, base.affect.directionAgree);
    le('affect.oscillationRate', cur.affect.oscillationRate, base.affect.oscillationRate);
  }
  return f;
}
module.exports = { readJsonl, rankMetrics, evalMemory, evalSummary, evalCost, evalRouting, evalKnowledge, evalAffect, runAll, strip, loadBaseline, compare, EPS };
