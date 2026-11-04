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

function runAll() {
  return { memory: evalMemory(), summary: evalSummary(), cost: evalCost(), render: { skipped: true, note: '渲染性能本 PR 未跑' } };
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
  return f;
}
module.exports = { readJsonl, rankMetrics, evalMemory, evalSummary, evalCost, runAll, strip, loadBaseline, compare, EPS };
