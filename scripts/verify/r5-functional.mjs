#!/usr/bin/env node
/** 第五轮功能验证：A 路由 / B 知识注入 / G 流式增量 / H 门禁 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WWW = path.join(ROOT, 'app/src/main/assets/www');

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
}

// ---- H：门禁三维 ----
const core = require(path.join(ROOT, 'scripts/lib/eval-core.js'));
const all = core.runAll();
const fails = core.compare(all, core.loadBaseline());
ok('H.eval_gate', fails.length === 0, fails.length ? fails.join('; ') : `routing.passRate=${all.routing.passRate} knowledge.pAt5=${all.knowledge.pAt5} affect.agree=${all.affect.directionAgree}`);
ok('H.golden_dims', all.routing && all.knowledge && all.affect, 'routing/knowledge/affect present');
ok('H.golden_sizes',
  core.readJsonl('routing.jsonl').length >= 15 &&
  core.readJsonl('knowledge.jsonl').length >= 25 &&
  core.readJsonl('affect.jsonl').length >= 20,
  `r=${core.readJsonl('routing.jsonl').length} k=${core.readJsonl('knowledge.jsonl').length} a=${core.readJsonl('affect.jsonl').length}`);

// ---- A：路由模拟 30 轮 ----
const Router = require(path.join(WWW, 'router.js'));
const Providers = require(path.join(WWW, 'providers.js'));
const prices = [
  { slug: 'flex-alpha', pMiss: 0.20, pHit: 0.04, ok: true },
  { slug: 'cheap-nocache', pMiss: 0.16, pHit: 0.16, ok: true },
  { slug: 'priority', pMiss: 0.40, pHit: 0.10, ok: true },
];
const steps = [];
for (let i = 0; i < 30; i++) {
  // 稳态：高命中在 flex-alpha
  steps.push({ prices, promptTokens: 20000, hitTokens: i < 3 ? 2000 : 15000, ok: true });
}
const replay = Router.replay(steps, { prefixTokens: 20000, model: 'google/gemini-test' });
ok('A.switches_le_2', replay.switches <= 2, `switches=${replay.switches}`);
ok('A.prefers_cache_affinity', replay.current === 'flex-alpha', `final=${replay.current}`);
// 对比：强制每轮 sort price（总选 cheap-nocache）的有效成本
let naiveCost = 0;
for (const s of steps) {
  const p = prices.find(x => x.slug === 'cheap-nocache');
  naiveCost += s.promptTokens * p.pMiss / 1e6;
}
const saving = (naiveCost - replay.effCost) / naiveCost;
ok('A.eff_cost_vs_naive', saving >= 0.05 || replay.effCost < naiveCost, `eff=${replay.effCost.toFixed(4)} naive=${naiveCost.toFixed(4)} saving=${(saving*100).toFixed(1)}%`);
// provider field
const field = Router.buildProviderField('flex-alpha', { enabled: true });
ok('A.provider_order', field.order && field.order[0] === 'flex-alpha' && !field.sort, JSON.stringify(field));
const off = Router.buildProviderField(null, { enabled: false });
ok('A.fallback_sort_price', off.sort === 'price', JSON.stringify(off));
// endpointRoutePrices
const eps = [
  { tag: 'flex-alpha', pricing: { prompt: '0.0000002', completion: '0.000001', input_cache_read: '0.00000004' } },
  { provider_name: 'cheap-nocache', pricing: { prompt: '0.00000016', completion: '0.000001' } },
];
const rp = Providers.endpointRoutePrices(eps);
ok('A.endpoint_prices', rp.length === 2 && rp[0].slug === 'flex-alpha', JSON.stringify(rp.map(x => x.slug)));

// ---- B：知识注入 ----
require(path.join(WWW, 'retrieval-core.js'));
const K = require(path.join(WWW, 'knowledge.js'));
const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/golden/knowledge.jsonl'), 'utf8').split('\n')[0]).doc;
// use full corpus from a case
const cases = fs.readFileSync(path.join(ROOT, 'tests/golden/knowledge.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const corpus = cases[0].doc;
const sel = K.selectForInject(corpus, '青铜钥匙 青石巷 旧井', { budget: 400 });
ok('B.inject_hits', sel.hits.length > 0, `hits=${sel.hits.map(h => h.entry.id).join(',')}`);
ok('B.budget', sel.trace.tokens <= 400, `tokens=${sel.trace.tokens}`);
ok('B.trace', sel.trace.hitIds && Array.isArray(sel.trace.dropped), JSON.stringify({ ids: sel.trace.hitIds, dropped: sel.trace.dropped.length }));
const l1 = '城西一条窄巷，雨后积水，尽头是旧井。青石巷详细设定。';
const dedup = K.selectForInject(corpus, '青石巷', { budget: 400, alreadyTexts: [l1] });
ok('B.dedup', dedup.trace.dropped.some(d => d.reason === 'dup') || !dedup.hits.some(h => h.entry.id === 'e-alley'), `dropped=${JSON.stringify(dedup.trace.dropped)}`);
const base = '玩家：去巷口看看\n\n[MEMORY_UPDATE]\n- 旧事\n\n[CURRENT_STATE]\n地点：城西';
const inj = K.renderInjection(sel.hits);
const spliced = K.spliceIntoUserContent(base, inj);
ok('B.splice_order',
  spliced.indexOf('[MEMORY_UPDATE]') < spliced.indexOf('[LOCAL_KNOWLEDGE]') &&
  spliced.indexOf('[LOCAL_KNOWLEDGE]') < spliced.indexOf('[CURRENT_STATE]'),
  'order ok');
ok('B.no_system_touch', !spliced.includes('system'), 'user-only');

// ---- G：流式增量 / DOM ----
const RD = require(path.join(WWW, 'render-diff.js'));
// stub minimal document
let creates = 0;
globalThis.document = {
  createElement(tag) {
    creates++;
    const el = {
      tagName: String(tag).toUpperCase(), children: [], childNodes: [], style: {}, className: '', dataset: {},
      appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
      removeChild(c) { this.children = this.children.filter(x => x !== c); this.childNodes = this.childNodes.filter(x => x !== c); },
      insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : this.children.length; this.children.splice(i, 0, c); this.childNodes.splice(i, 0, c); return c; },
      replaceChild(n, o) { const i = this.children.indexOf(o); if (i >= 0) this.children[i] = n; return n; },
      set innerHTML(v) { this._html = v; this.children = []; this.childNodes = []; },
      get innerHTML() { return this._html || ''; },
      querySelector() { return null; },
    };
    return el;
  },
};
const div = document.createElement('div');
creates = 0;
let html = '';
const chunks = 40;
const createsPerChunk = [];
for (let i = 0; i < chunks; i++) {
  html += `<p>段落${i} ` + '内容'.repeat(20) + `</p>`;
  const before = creates;
  RD.applyBlockDiff(div, html, () => {});
  createsPerChunk.push(creates - before);
}
const early = createsPerChunk.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
const late = createsPerChunk.slice(-5).reduce((a, b) => a + b, 0) / 5;
ok('G.block_diff_reuses', late <= early, `earlyAvgCreates=${early.toFixed(1)} lateAvgCreates=${late.toFixed(1)}`);
ok('G.app_has_incremental',
  fs.readFileSync(path.join(WWW, 'app.js'), 'utf8').includes('opts.incremental') &&
  fs.readFileSync(path.join(WWW, 'app.js'), 'utf8').includes('skeletonSig'),
  'fillMsgEl incremental + skeletonSig');
ok('G.batch_measure',
  fs.readFileSync(path.join(WWW, 'app.js'), 'utf8').includes('batchMeasure'),
  'read-then-write offsetHeight');

const failed = results.filter(r => !r.pass);
console.log('\n=== SUMMARY ===');
console.log(`pass ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  failed.forEach(f => console.log('  FAIL', f.name, f.detail));
  process.exit(1);
}
process.exit(0);
