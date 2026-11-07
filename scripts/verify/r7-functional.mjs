#!/usr/bin/env node
/** 第七轮功能验证：D1 价目一致 / D2 EWMA 对账 / D3 路由后验每请求 1 份证据 */
import { createRequire } from 'node:module';
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

const C = require(path.join(WWW, 'cost-core.js'));
const R = require(path.join(WWW, 'rpcache.js'));
const U = require(path.join(WWW, 'usage-stats.js'));
const Router = require(path.join(WWW, 'router.js'));

// ---- D1 ----
const models = ['qwen3.7-plus', 'qwen/qwen3.8-max', 'deepseek-flash', 'google/gemini-2.5-flash-lite'];
let d1ok = true;
for (const m of models) {
  const cp = C.priceFor(m, {});
  const rp = R.priceFor(m, R.DEFAULT_PRICES);
  const up = U.priceFor(m, U.DEFAULT_PRICES);
  if (!cp || !rp || Math.abs(cp.miss - rp.miss) > 1e-12 || Math.abs(cp.miss - up.miss) > 1e-12) {
    d1ok = false;
    ok('D1.price_' + m, false, JSON.stringify({ cp, rp, up }));
  }
}
ok('D1.shared_pricebook', d1ok, models.join(','));

const at = Date.parse('2026-11-07T10:00:00+08:00');
const rpcE = { model: 'qwen3.7-plus', supported: true, timestamp: at, prompt_tokens: 20000, cache_hit_tokens: 15000, cache_miss_tokens: 5000, completion_tokens: 800 };
const usE = U.makeEntry({ usage: { prompt: 20000, completion: 800, hit: 15000, miss: 5000, cacheSupported: true }, at, model: 'qwen3.7-plus', key: 'd1' });
const c1 = C.costOf(rpcE, {}).actual;
const c2 = R.costOf(rpcE, R.DEFAULT_PRICES).actual;
const c3 = U.costOf(usE, U.DEFAULT_PRICES);
ok('D1.cost_triple', Math.abs(c1 - c2) < 1e-12 && Math.abs(c1 - c3) < 1e-12, `c1=${c1} c2=${c2} c3=${c3}`);
const defOnly = U.priceFor('totally-unknown-xyz', { default: { hit: 0, miss: 0.5, out: 1.5 } });
ok('D1.qwen_not_default', C.priceFor('qwen3.7-plus', {}).miss < defOnly.miss, `qwen=${C.priceFor('qwen3.7-plus', {}).miss} default=${defOnly.miss}`);

// ---- D2 ----
let calib = C.emptyCalib();
const bills = [];
for (let i = 0; i < 8; i++) {
  const est = 0.02;
  const actual = 0.01; // 持续高估
  calib = C.reconcile(calib, 'google/gemini-3.8-flash', est, actual);
  bills.push({ est, actual });
}
const view = C.calibView(calib, 'google/gemini-3.8-flash');
ok('D2.ewma_scale', view && view.scale < 0.9 && view.n === 8, JSON.stringify(view));
ok('D2.distorted_flag', view.distorted === true, `streak=${view.streak}`);
// 入账路径
const entry = U.makeEntry({
  usage: { prompt: 1e6, completion: 0, hit: 0, miss: 1e6, cacheSupported: true, cost: 0.12 },
  at, model: 'deepseek-flash', key: 'bill1',
});
let st = U.record(U.emptyState(), entry);
st = U.reconcileEntry(st, entry, 'peak');
ok('D2.record_actualCost', entry.actualCost === 0.12 && st.calib['deepseek-flash']?.n >= 1, JSON.stringify(st.calib['deepseek-flash']));
// 校准后估算贴近实付
const est0 = U.costOf(entry, st.prices, 'peak', null, null);
const est1 = U.costOf(entry, st.prices, 'peak', null, st.calib);
ok('D2.calib_moves_estimate', Math.abs(est1 - entry.actualCost) < Math.abs(est0 - entry.actualCost), `raw=${est0} calib=${est1} actual=${entry.actualCost}`);

// ---- D3 ----
const sShort = {}, sLong = {};
for (let i = 0; i < 12; i++) {
  Router.observe(sShort, 'm', 'up', { hitTokens: 80, promptTokens: 100, ok: true });
  Router.observe(sLong, 'm', 'up', { hitTokens: 80000, promptTokens: 100000, ok: true });
}
const A = sShort.m.upstreams.up, B = sLong.m.upstreams.up;
ok('D3.per_request_evidence', A.obs === 12 && B.obs === 12 && Math.abs(A.a - B.a) < 1e-9, `A.a=${A.a} B.a=${B.a}`);
ok('D3.no_token_explosion', A.a < 25 && B.a < 25, `a=${A.a}`);
const post = R.hitPosterior(Array.from({ length: 12 }, () => ({ hit: 80, prompt: 100 })));
ok('D3.isomorphic_rpcache', Math.abs(A.a - post.alpha) < 1e-9 && Math.abs(A.b - post.beta) < 1e-9, `post.a=${post.alpha}`);

const prices = [
  { slug: 'flex', pMiss: 0.20, pHit: 0.04, ok: true },
  { slug: 'cheap', pMiss: 0.16, pHit: 0.16, ok: true },
];
const steps = [];
for (let i = 0; i < 30; i++) steps.push({ prices, promptTokens: 20000, hitTokens: i < 3 ? 2000 : 15000, ok: true });
const replay = Router.replay(steps, { prefixTokens: 20000 });
ok('D3.hysteresis_intact', replay.switches <= 2 && replay.current === 'flex', `sw=${replay.switches} cur=${replay.current}`);

const failed = results.filter(r => !r.pass);
console.log('\n' + (failed.length ? `FAIL ${failed.length}/${results.length}` : `PASS ${results.length}/${results.length}`));
process.exit(failed.length ? 1 : 0);
