#!/usr/bin/env node
/** P0 + UI 4.1/4.2 功能验证：EWMA 入路由、缓存自适应、价目同步、Composer/侧栏结构 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WWW = path.join(ROOT, 'app/src/main/assets/www');
const R = require(path.join(WWW, 'router.js'));
const C = require(path.join(WWW, 'cost-core.js'));
const P = require(path.join(WWW, 'providers.js'));
const G = require(path.join(WWW, 'plugins/cache/gcache.js'));
const RP = require(path.join(WWW, 'rpcache.js'));
const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(WWW, 'app.js'), 'utf8');

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
}

// 1. EWMA scale 进入 planOpenRouterRoute 有效价
const eps = [
  { tag: 'alpha', pricing: { prompt: '0.000001', completion: '0.000002', input_cache_read: '0.00000025' }, latency: 1 },
  { tag: 'beta', pricing: { prompt: '0.0000008', completion: '0.000002' }, latency: 2 },
];
const st = {};
for (const slug of ['alpha', 'beta']) {
  for (let i = 0; i < 6; i++) R.observe(st, 'm1', slug, { hitTokens: 600, promptTokens: 1000, ok: true, latencyMs: slug === 'alpha' ? 800 : 2500 });
}
const a = P.planOpenRouterRoute({ cacheAffinity: true }, 'm1', eps, JSON.parse(JSON.stringify(st)), { prefixTokens: 20000 });
const b = P.planOpenRouterRoute({ cacheAffinity: true }, 'm1', eps, JSON.parse(JSON.stringify(st)), { prefixTokens: 20000, calib: { m1: { scale: 2 } } });
ok('P0.ewma_scale_in_route', a.view && b.view && Math.abs(b.view.effectivePrice - a.view.effectivePrice * 2) < 1e-6,
  'pe0=' + (a.view && a.view.effectivePrice) + ' pe1=' + (b.view && b.view.effectivePrice));

// 2. 延迟维会改变决策（同价）
const stL = { current: 'slow', upstreams: {
  slow: Object.assign(R.emptyUpstream(), { obs: 8, a: 10, b: 4, latEwma: 4000, latN: 8 }),
  fast: Object.assign(R.emptyUpstream(), { obs: 8, a: 10, b: 4, latEwma: 400, latN: 8 }),
} };
const chosen = R.chooseUpstream([{ slug: 'slow', pMiss: 1, pHit: 1 }, { slug: 'fast', pMiss: 1, pHit: 1 }], stL, 'slow', 20000);
ok('P0.latency_dimension', chosen === 'fast', 'chosen=' + chosen);

// 3. 价目同步
const bag = P.syncFloorPrices({}, 'mod', [
  { tag: 'x', pricing: { prompt: '0.000002', completion: '0.000004' } },
]);
ok('P0.price_sync', bag.mod && bag.mod.miss === 2 && bag.mod.out === 4, JSON.stringify(bag.mod));
ok('P0.calib_helper', C.calibScale({ m: { scale: 1.3 } }, 'm') === 1.3);

// 4. 缓存自适应 + 不破坏其它服务商 + 质量门
const E = G.CachePolicyEngine;
ok('P0.cache_floor', E.adaptiveMinTokens('google/gemini-2.5-flash', { hitSamples: 1, hitRate: 0.1 }) === 1024);
ok('P0.cache_adapt_up', E.adaptiveMinTokens('google/gemini-2.5-flash', { hitSamples: 10, hitRate: 0.2 }) > 1024);
ok('P0.quality_gate', RP.SUMMARY_MIN_QUALITY >= 0.60);
const mm = fs.readFileSync(path.join(WWW, 'plugins/cache/mmcache.js'), 'utf8');
ok('P0.mmcache_untouched', !mm.includes('adaptiveMinTokens'));

// 5. UI 结构
ok('UI.composer_plus', html.includes('id="btn-composer-more"') && html.includes('id="composer-more-menu"'));
ok('UI.tpl_recent', html.includes('id="tpl-recent-row"') && app.includes('renderTplRecentRow'));
ok('UI.usage_pill', html.includes('id="usage-pill"') && app.includes('planOpenRouterRoute') && app.includes('calib: usageState.calib'));
ok('UI.drawer_recent', html.includes('id="drawer-recent"') && app.includes('recentWorlds') && app.includes('recentPersonas'));
ok('UI.drawer_collapse', html.includes('drawer-sec-toggle') && app.includes('toggleDrawerSec'));
ok('P0.observe_latency', app.includes('latencyMs: Date.now() - routeStartedAt'));
ok('P0.sync_on_refresh', app.includes('syncUsagePricesFromEndpoints'));

const failed = results.filter(x => !x.pass);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
