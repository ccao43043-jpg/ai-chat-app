// 工作流 C · M2 golden 导出：cache-common / gcache / mmcache / plugins 管线 + JS 语义基础（数字格式、JSON.stringify）。
// 用法：node tests/golden-export/c-m2-cache.mjs [--check]
// 输出：app/src/test/resources/golden/<module>/<fn>.jsonl，每行 {"in":[…],"out":…}
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WWW = ROOT + '/app/src/main/assets/www';
const OUT = ROOT + '/app/src/test/resources/golden';
const CHECK = process.argv.includes('--check');
const FIXED_DATE = '2026-11-13';

const TU = require(WWW + '/timeutil.js');
TU.localDateStr = () => FIXED_DATE;           // Hybrid 摘要 at 固定（Kotlin 侧 GCache.localDate 注入同值）
const R = require(WWW + '/rpcache.js');
const C = require(WWW + '/plugins/cache/cache-common.js');
const G = require(WWW + '/plugins/cache/gcache.js');
const M = require(WWW + '/plugins/cache/mmcache.js');
const Plugins = require(WWW + '/plugins.js');

// ── 固定种子随机 ──
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let rnd = mulberry32(20261113);
const ri = n => Math.floor(rnd() * n);
const pick = a => a[ri(a.length)];
const NAMES = ['艾琳', '张燕', '曹含森', '林雾', 'Arthur', 'Mira', '老周', '白鸦'];
const ACTS = ['把账本交给', '发现了密道的入口', '知道了真相背后的人', '不知道密道通向旧矿', '秘密藏在钟楼顶层', '告诉了守卫换岗时间', '隐瞒了伤势与来历', '决定结盟对抗北境', '把信件藏进墙缝', '保存好地图与钥匙'];
const FILL = ['雨下了一整夜。', '烛火摇晃。', '远处传来钟声，', '她沉默片刻，', '街道空无一人。', 'The wind howls.', '“走吧。”', '……', '2026-11-05 13:45:12+08:00 记录。', '下午 13:45 集合。', '\t多余  空白\u3000全角\u00a0不换行 ', '🗝️ 钥匙', '\u2028行分隔'];
function sentence() { let s = ''; const n = 1 + ri(4); for (let i = 0; i < n; i++) s += pick(NAMES) + pick(ACTS) + (rnd() < 0.5 ? pick(NAMES) : '') + '。' + pick(FILL); return s; }
function randStr(n) { const pool = ['a', 'Z', '0', ' ', '\n', '\t', '中', '文', '，', '。', '\u3000', '\uff01', '😀', '\ud800', '"', '\\', '\u0001', '\u2028', 'é', '【', '】', '#', '*']; let s = ''; for (let i = 0; i < n; i++) s += pick(pool); return s; }
function shortSentence() { return pick(NAMES) + pick(ACTS) + '。' + (rnd() < 0.3 ? pick(FILL) : ''); }
const mkHist = (n, seed) => { const a = []; for (let i = 1; i <= n; i++) a.push({ role: 'user', content: '第' + (i + seed) + '次：' + shortSentence() }, { role: 'assistant', content: shortSentence() + shortSentence() }); return a; };
const longWorld = '【世界观】\n' + '这是一个漫长而稳定的奇幻大陆设定，'.repeat(120) + '\n【角色卡】\n艾琳：冷静、守信的女骑士。\n【RP规则】\n每次回复不超过 300 字。';
const PROVIDERS = [
  { type: 'openai', presetId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { type: 'openai', baseUrl: 'https://OpenRouter.AI/api/v1' },
  { type: 'openai', baseUrl: 'https://x.com', cacheAdapter: 'openrouter' },
  { type: 'openai', baseUrl: 'https://x.com' },
  { type: 'openai', presetId: 'deepseek', baseUrl: 'https://api.deepseek.com' },
  { type: 'openai', presetId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', cacheAdapter: 'none' },
  { type: 'openai', presetId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', cacheAdapter: ' OpenAI-Compat ' },
  { type: 'anthropic', presetId: 'openrouter' }, { type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' }, {}, null,
];
const MODELS = ['google/gemini-2.5-flash', '~google/gemini-pro', 'google/gemini-2.5-flash-lite', 'gemini-2.5', 'vendor/gemini-3-pro-preview', 'google/gemini-3.8-flash-lite:free',
  'minimax/minimax-m3.1-flash', '~minimax/minimax-m3', 'MiniMax/minimax-m2.5-preview', 'minimax/minimax-m2.7:nitro', 'minimax/abab', 'deepseek/deepseek-chat', 'anthropic/claude-sonnet-4', '', null, '  minimax/minimax-m3 '];

const files = {};
const rec = (mod, fn, input, out) => { (files[mod + '/' + fn] = files[mod + '/' + fn] || []).push(JSON.stringify({ in: input, out: out === undefined ? null : out })); };
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));

// ───────── JS 语义基础 ─────────
{
  const nums = [0, -0, 1, -1, 0.1, 0.2 + 0.1, 1 / 3, 2 / 3, 1e21, 1e-7, 123456789012345680000, 1.5e-6, 5e-324, 1.7976931348623157e308, 0.000001, 1234.5678, 2 ** 53, 2 ** 53 + 2, 2 ** 60, 4.35, 1.005, 100, 1e20, 12.345e-10, NaN, Infinity, -Infinity];
  for (let i = 0; i < 300; i++) nums.push((rnd() - 0.5) * 10 ** (ri(40) - 20));
  for (let i = 0; i < 100; i++) nums.push(Math.round(rnd() * 1e6) / 100);
  nums.forEach(n => rec('js', 'numToString', [Number.isFinite(n) ? n : String(n)], String(n)));
  nums.filter(Number.isFinite).forEach(n => { rec('js', 'round', [n], Math.round(n)); [0, 1, 2].forEach(d => rec('js', 'toFixed', [n, d], n.toFixed(d))); rec('js', 'i32', [n], n | 0); });
  [0.5, -0.5, 1.5, 2.5, -2.5, 0.49999999999999994, 4.5, -4.5].forEach(n => rec('js', 'round', [n], Math.round(n)));
  for (let i = 0; i < 200; i++) { const s = randStr(1 + ri(30)); rec('js', 'stringify', [s], JSON.stringify(s)); rec('js', 'trim', [s], s.trim()); rec('js', 'sha256', [s], R.sha256(s)); }
  ['', 'abc', '中文', '\ud83d\ude00', 'a\ud800b'].forEach(s => rec('js', 'sha256', [s], R.sha256(s)));
}

// ───────── cache-common ─────────
{
  const strs = ['', 'a', 'conv-1', '中文对话', '😀', '\ud800', 'x'.repeat(300)];
  for (let i = 0; i < 60; i++) strs.push(randStr(ri(60)));
  strs.forEach(s => { rec('cache-common', 'hash', [s], C.hash(s)); rec('cache-common', 'estTokens', [s], C.estTokens(s)); });
  strs.forEach(s => ['', 'or', 'mmcache', 'gcache'].forEach(ns => rec('cache-common', 'sessionIdFor', [s, ns], C.sessionIdFor(s, ns))));
  for (let i = 0; i < 80; i++) { const a = randStr(ri(40)), b = rnd() < 0.5 ? a.slice(0, ri(a.length + 1)) + randStr(ri(10)) : randStr(ri(40)); rec('cache-common', 'lcpLen', [a, b], C.lcpLen(a, b)); rec('cache-common', 'lcpRatio', [a, b], C.lcpRatio(a, b)); rec('cache-common', 'firstDiff', [a, b], C.firstDiff(a, b)); }
  const parts = ['s', '', [{ type: 'text', text: 'A' }, { type: 'image_url', image_url: { url: 'x' } }, { type: 'text' }, {}, null], [], { a: 1 }, null, 3];
  parts.forEach(p => rec('cache-common', 'partsText', [p], C.partsText(p)));
  const usages = [null, {}, { prompt: 1000, hit: 800 }, { prompt: 1000 }, { prompt: 1000, cacheSupported: true }, { prompt: 999.7, hit: 333.3, cacheWrite: 12 }, { prompt: 0, hit: 0 }, { prompt: 3, hit: 1, cacheWrite: 1 }];
  for (let i = 0; i < 30; i++) usages.push({ prompt: ri(50000), hit: rnd() < 0.8 ? ri(30000) : undefined, cacheWrite: rnd() < 0.3 ? ri(5000) : undefined, cacheSupported: rnd() < 0.2 });
  usages.forEach(u => rec('cache-common', 'usageInfo', [clone(u)], C.usageInfo(u)));
  for (let i = 0; i < 40; i++) {
    const roll = Array.from({ length: ri(9) }, () => ({ prompt: ri(5000), hit: ri(3000), known: rnd() < 0.8 }));
    rec('cache-common', 'rollingRate', [roll], C.rollingRate(roll));
    const inf = C.usageInfo(usages[ri(usages.length)]); const price = rnd() < 0.5 ? { read: pick([0.1, 0.2, 0.25, 0.11]), write: pick([1, 1.25]) } : undefined;
    rec('cache-common', 'estimateCost', [inf, price === undefined ? null : price], C.estimateCost(inf, price));
  }
  PROVIDERS.forEach(p => rec('cache-common', 'isOpenRouterProvider', [p], C.isOpenRouterProvider(p)));
}

// ───────── gcache 纯函数 ─────────
{
  MODELS.forEach(m => {
    rec('gcache', 'isGeminiModel', [m], G.isGeminiModel(m)); rec('gcache', 'minCacheTokens', [m], G.CachePolicyEngine.minCacheTokens(m)); rec('gcache', 'isFlashLite', [m], G.CachePolicyEngine.isFlashLite(m));
    PROVIDERS.forEach(p => { rec('gcache', 'resolveCacheAdapter', [p, m], G.resolveCacheAdapter(p, m)); rec('gcache', 'isOpenRouterGemini', [p, m], G.isOpenRouterGemini(p, m)); });
    [null, { hitSamples: 3, hitRate: 0.1 }, { hitSamples: 4, hitRate: 0.39 }, { hitSamples: 9, hitRate: 0.5 }, { hitSamples: 5, hitRate: 0.7 }, { hitSamples: 5, hitRate: null }, { hitSamples: 5.9, hitRate: '0.3' }].forEach(st => rec('gcache', 'adaptiveMinTokens', [m, st], G.CachePolicyEngine.adaptiveMinTokens(m, st)));
    [100, 2999, 3000, '2500'].forEach(e => rec('gcache', 'flashLitePrefixNote', [m, e], G.CachePolicyEngine.flashLitePrefixNote(m, e)));
  });
  const sysTexts = ['', '你是助手', longWorld, longWorld + '\n【当前状态】\n第 1 天，雨。', '前言\n## **【RP协议】**\n- a\n【记忆】\n旧事\n【角色】\n艾琳\n【未知标题】\nx\n【状态】\n受伤', '【世界观】\n世界\n【近期剧情】\n…\n【规则】\n规则', '  # 【背景设定】abc\n【示例对话】\nA:1\n【前情提要】\n2'];
  for (let i = 0; i < 20; i++) { let s = ''; const n = 1 + ri(6); for (let j = 0; j < n; j++) s += (rnd() < 0.7 ? '【' + pick(['世界观', '角色卡', '规则', '当前状态', '长期记忆', '近期剧情', '协议', '文风', '杂项', '人物核心']) + '】\n' : '') + sentence() + '\n'; sysTexts.push(s); }
  sysTexts.forEach(t => rec('gcache', 'analyzeLayers', [t], G.PromptBuilder.analyzeLayers(t)));
  // layersFromSegments
  const segCases = [];
  for (let i = 0; i < 20; i++) {
    const segs = [{ kind: 'static', gl: 'B', title: '世界', text: '世界书：' + sentence() }, { kind: 'static', gl: 'C', title: '角色', text: '角色：' + sentence() }, { kind: 'dynamic', gl: 'E', title: '记忆', text: '[MEMORY]\n' + sentence() }, { kind: 'dynamic', gl: 'G', title: '状态', text: '[CURRENT_STATE]\n' + sentence() }];
    const pickSegs = segs.filter(() => rnd() < 0.8);
    let text = (rnd() < 0.5 ? G.PromptBuilder.RP_ANCHOR + '\n\n' : '') + pickSegs.map(s => s.text).join('\n\n') + (rnd() < 0.4 ? '\n\n[AFFECT_RULE] x' : '');
    if (rnd() < 0.15) pickSegs.push({ kind: 'dynamic', text: '不存在的段' });
    segCases.push([text, pickSegs]);
  }
  segCases.push(['abc', []], ['abc', null], ['  \n', [{ kind: 'dynamic', text: '  ' }]]);
  segCases.forEach(([t, s]) => rec('gcache', 'layersFromSegments', [t, s], G.PromptBuilder.layersFromSegments(t, s)));
  // decide / decideHistory
  const cfgs = [{ mode: 'auto' }, { mode: 'off' }, { mode: 'prefix' }, { mode: 'history' }];
  for (let i = 0; i < 60; i++) {
    const cfg = Object.assign({}, G.DEFAULTS, pick(cfgs)); const m = pick(MODELS);
    const st = rnd() < 0.5 ? '设定行，'.repeat(ri(1500)) + sentence() : longWorld.slice(0, ri(longWorld.length));
    const info = { model: m, staticText: st, cacheText: st + 'history '.repeat(ri(3000)), static_hash: pick(['h1', 'h2']), prevStaticHash: pick(['', 'h1', 'h2', undefined]), cacheStats: pick([undefined, { hitSamples: 6, hitRate: 0.3 }, { hitSamples: 6, hitRate: 0.5 }]) };
    rec('gcache', 'decide', [cfg, clone(info)], G.CachePolicyEngine.decide(cfg, info));
    rec('gcache', 'decideHistory', [cfg, clone(info)], G.CachePolicyEngine.decideHistory(cfg, info));
  }
  ['', 'c1', 'c2', '中文 id', 12345].forEach(id => rec('gcache', 'sessionIdFor', [id], G.OpenRouterAdapter.sessionIdFor(id)));
  ['2026-11-05 13:45:12+08:00 下午 13:45', '2026/1/2T03:04Z', '2026年11月5日 08:00:00.123Z', '2026.11.05 13:45', '时间 12:00 不变', 'x 2026-11-05 13:45:12 y 2026-11-06T01:02:03-0700'].forEach(s => rec('gcache', 'normalizeDates', [s], G.normalizeDates(s)));
  for (let i = 0; i < 15; i++) { const h = mkHist(1 + ri(6), i); if (rnd() < 0.3) h.unshift({ role: 'assistant', content: '开场白：' + sentence() }); const turns = G.HybridWindow.splitTurns(h); rec('gcache', 'splitTurns', [h], turns);
    rec('gcache', 'summarizeTurnsFast', [turns, i], G.HybridWindow.summarizeTurnsFast(turns, i)); rec('gcache', 'summarizeTurnsSemantic', [turns, i], G.HybridWindow.summarizeTurnsSemantic(turns, i));
    rec('gcache', 'extractHybridEvidence', [turns], G.HybridWindow.extractHybridEvidence(turns));
    const sum = rnd() < 0.5 ? G.HybridWindow.summarizeTurnsSemantic(turns, 0) : sentence(); rec('gcache', 'scoreHybridSummary', [sum, turns], G.HybridWindow.scoreHybridSummary(sum, turns)); }
  rec('gcache', 'scoreHybridSummary', ['短', []], G.HybridWindow.scoreHybridSummary('短', []));
  rec('gcache', 'scoreHybridSummary', ['这是一段没有任何人名也没有关键证据的空聊文本而已啊啊啊', [[{ role: 'user', content: 'hi there' }]]], G.HybridWindow.scoreHybridSummary('这是一段没有任何人名也没有关键证据的空聊文本而已啊啊啊', [[{ role: 'user', content: 'hi there' }]]));
  // hwApply 链式（状态延续）
  for (const chain of [{ n: 120, step: 10, idle: null }, { n: 64, step: 8, idle: 300 }, { n: 60, step: 20, idle: null, strategy: 'fast_local' }]) {
    let st = G.HybridWindow.empty(); const full = mkHist(chain.n, 0);
    for (let t = chain.step; t <= chain.n; t += chain.step) {
      let hist = full.slice(0, t * 2);
      if (t === chain.step * 4 && chain.n === 120) hist = hist.map((m, i) => i === 3 ? Object.assign({}, m, { content: m.content + '（编辑过）' }) : m); // 编辑早期消息 → 摘要失效
      const input = [clone(hist), clone(st), chain.strategy || null, chain.idle, null];
      const w = G.HybridWindow.apply(hist, st, { summaryStrategy: chain.strategy, idleSec: chain.idle });
      rec('gcache', 'hwApply', input, w); st = w.state;
    }
  }
  // 低质量批次（空聊）→ 临时兜底
  { const hist = []; for (let i = 0; i < 45; i++) hist.push({ role: 'user', content: 'ok' }, { role: 'assistant', content: 'yes' }); const st = G.HybridWindow.empty(); rec('gcache', 'hwApply', [clone(hist), clone(st), null, null, null], G.HybridWindow.apply(hist, st, {})); }
  // 旧 FNV 指纹升级
  { const hist = mkHist(45, 3); const turns = G.HybridWindow.splitTurns(hist); const bt = turns.slice(0, 20).flat().map(m => m.role + ':' + m.content).join('\n');
    const st = { v: 1, cut: 20, summaries: [{ from: 0, to: 20, fp: G.hash(bt), text: '旧摘要', at: '2026-01-01' }], sent: { old: 'str', ok: { h: 'x', n: 1, sent: 'y' } } };
    rec('gcache', 'hwApply', [clone(hist), clone(st), null, null, null], G.HybridWindow.apply(hist, st, {})); }

  // applyToRequest：多样请求
  const mkBody = (model, sys, msgs, extra) => JSON.stringify(Object.assign({ model, messages: (sys == null ? [] : [].concat(sys).map(s => typeof s === 'string' ? { role: 'system', content: s } : s)).concat(msgs), stream: true, max_tokens: 8192 }, extra || {}));
  const extras = [{}, { rp: true }, { sessionId: 'aichat-x' }, { adapter: 'openai-compat', sessionId: 'sid' }, { prevStaticHash: 'sha256:' + 'f'.repeat(64) }];
  for (let i = 0; i < 80; i++) {
    const model = pick(MODELS.filter(Boolean));
    const sysVariants = [null, 'S', '', ['A', 'B'], ['A', '', 'C'], [{ role: 'system', content: [{ type: 'text', text: 'P' }] }, 'Q'], longWorld + '\n【当前状态】\n第 ' + ri(9) + ' 天。', longWorld, G.PromptBuilder.RP_ANCHOR + '\n\n' + longWorld, '【当前状态】\n开头就是动态\n【世界观】\n后面固定' ];
    const sys = pick(sysVariants);
    let msgs = mkHist(ri(4), i).concat([{ role: 'user', content: rnd() < 0.15 ? [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] : sentence() }]);
    if (rnd() < 0.2) msgs.push({ role: 'assistant', content: sentence() });
    if (rnd() < 0.2) msgs = msgs.map((m, j) => j === 0 ? Object.assign({}, m, { content: [{ type: 'text', text: String(m.content), cache_control: { type: 'ephemeral' } }] }) : m);
    const bodyExtra = pick([{}, { provider: { order: ['google-vertex'] } }, { session_id: 'keep-me' }, { temperature: 0.7, provider: { sort: 'price', allow_fallbacks: true } }]);
    const req = { url: 'https://openrouter.ai/api/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: mkBody(model, sys, msgs, bodyExtra) };
    const cfg = pick([{}, { mode: 'prefix', ttl: '1h', responseCache: true }, { mode: 'history' }, { mode: 'off' }, { mode: 'auto', mergeSystem: false }, { rpGuardrails: 'on' }, { rpGuardrails: 'off' }, { rpGuardrails: true, sessionId: false }, { mode: 'auto', autoTarget: 'prefix' }]);
    const ex = Object.assign({}, pick(extras));
    if (rnd() < 0.3) ex.segments = [{ kind: 'dynamic', gl: 'G', title: '状态', text: '【当前状态】\n第 3 天。' }];
    rec('gcache', 'applyToRequest', [clone(req), clone(cfg), clone(ex)], G.applyToRequest(req, cfg, ex));
  }
  { const req = { url: 'u', headers: {}, body: 'not json' }; rec('gcache', 'applyToRequest', [req, {}, {}], G.applyToRequest(req, {}, {})); }
  { const req = { url: 'u', headers: {}, body: JSON.stringify({ model: 'google/gemini-2.5-flash' }) }; rec('gcache', 'applyToRequest', [req, { mode: 'prefix' }, { rp: true }], G.applyToRequest(req, { mode: 'prefix' }, { rp: true })); }
  // applyToRequest + Hybrid 链（含 ids / 已发送表 / 动态层下移 / idleSec）
  for (const chainCfg of [{ cfg: {}, idle: null }, { cfg: { mode: 'history', ttl: '1h' }, idle: 400 }]) {
    let st = G.HybridWindow.empty(); let prev = '';
    const full = mkHist(90, 5).map((m, j) => Object.assign({ id: 'm' + j }, m));
    for (let t = 4; t <= 90; t += 9) {
      const hist = full.slice(0, t * 2 - 1);
      const sys = longWorld + '\n【当前状态】\n2026-11-0' + (1 + (t % 9)) + ' 12:0' + (t % 10) + ':00 第 ' + t + ' 天。';
      const msgs = hist.map(m => ({ role: m.role, content: m.content }));
      const req = { url: 'u', headers: {}, body: mkBody('google/gemini-2.5-flash', sys, msgs) };
      const ex = { sessionId: G.OpenRouterAdapter.sessionIdFor('conv-h'), rp: true, prevStaticHash: prev, hybrid: st, ids: hist.map(m => m.id), idleSec: chainCfg.idle, cacheStats: { hitSamples: 5, hitRate: 0.62 } };
      const input = [clone(req), clone(chainCfg.cfg), clone(ex)];
      const r = G.applyToRequest(req, chainCfg.cfg, ex);
      rec('gcache', 'applyToRequestHybrid', input, { r, state: clone(st) });
      prev = r.layers.static_hash;
    }
  }
  // 其余
  for (let i = 0; i < 30; i++) {
    const u = { prompt: ri(9000), hit: rnd() < 0.8 ? ri(5000) : undefined, cacheWrite: rnd() < 0.3 ? ri(900) : undefined };
    const inf = G.usageInfo(u); rec('gcache', 'usageText', [inf], G.usageText(inf)); rec('gcache', 'estimateCost', [inf, null], G.estimateCost(inf));
    const gaps = Array.from({ length: ri(8) }, () => Math.round(rnd() * 9000) / 10); const ttl = pick([300, 3600, 240]), interval = pick([0, 120, 240, 290]), maxP = pick([0, 3, 5]), read = pick([null, 0.25, 0.1]);
    rec('gcache', 'keepaliveRecommend', [gaps, ttl, interval, maxP, read], G.KeepAlive.recommend(gaps, ttl, interval, maxP, read == null ? undefined : read));
    const g = gaps[0] || 100; const pttl = rnd() < 0.5 ? ttl : null; rec('gcache', 'pingsForGap', [g, interval, maxP, pttl], G.KeepAlive.pingsForGap(g, interval, maxP, pttl == null ? undefined : pttl));
    rec('gcache', 'netForGap', [g, ttl, interval, maxP, read], G.KeepAlive.netForGap(g, ttl, interval, maxP, read == null ? undefined : read));
    const o = { expected: pick([null, rnd(), 0.95, 0.3, 0.75]), actual: pick([null, rnd(), 0.1]), gapSec: pick([null, 30, 250, 999.6]), compressed: rnd() < 0.3, ttlEff: pick([undefined, 240, 300]) };
    rec('gcache', 'attributeCacheHit', [clone(o)], G.attributeCacheHit(o));
    const pv = { t: 1000, body: 'abcdef' }, cv = pick([{ t: 1000 + ri(400000), body: 'abcdeX' }, { t: 2000, lcpRatio: rnd() }, { t: 3000 }, null]);
    const ettl = pick([null, 240, 600]); rec('gcache', 'expectedHit', [pv, cv, ettl], G.expectedHit(pv, cv, ettl == null ? undefined : ettl));
  }
  // expectedHit with ttl
  [[{ t: 0, body: 'aaaa' }, { t: 100000, body: 'aaaa' }, 240], [{ t: 0, body: 'aaaa' }, { t: 300000, body: 'aaaa' }, 600], [null, { t: 1 }, null]].forEach(([p, c, ttl]) => rec('gcache', 'expectedHit', [p, c, ttl], G.expectedHit(p, c, ttl == null ? undefined : ttl)));
  [{ conv: { systemPrompt: longWorld }, rp: false }, { conv: { systemPrompt: '你是助手' }, rp: false }, { conv: { plugins: { rpcache: { state: { worldBook: 1 } } } }, rp: false }, { conv: null, rp: true }, { conv: {}, rp: false }].forEach(x => rec('gcache', 'isRpConv', [x.conv, x.rp], G.isRpConv(x.conv, x.rp)));
  // diagnose
  for (let i = 0; i < 30; i++) {
    const hist = Array.from({ length: ri(5) }, (_, j) => ({ t: j * pick([60000, 400000]), static_hash: pick(['a', 'b']), prefix_hash: pick(['x', 'y']), model: pick(['google/gemini-2.5-flash-lite', 'm2']), provider: pick(['', '{"order":["x"]}']), session_id: pick(['s', '']), tokens: pick([500, 2000, 5000]) }));
    const stat = { roll: Array.from({ length: ri(6) }, () => ({ prompt: ri(5000), hit: ri(1500), known: rnd() < 0.9 })), hist, hitAttr: pick([undefined, { code: 'prefix_broken', text: '客户端前缀被破坏' }, { code: 'x', text: null }]), lastDiff: pick([undefined, { pos: 12 }]) };
    rec('gcache', 'diagnose', [clone(stat)], G.diagnose(stat));
  }
  const l0 = G.MemoryManager.extractL0(G.PromptBuilder.analyzeLayers(longWorld + '\n【协议】\n- "引号" 与 \\ 反斜杠的设定行\n短'));
  rec('gcache', 'extractL0', [G.PromptBuilder.analyzeLayers(longWorld + '\n【协议】\n- "引号" 与 \\ 反斜杠的设定行\n短')], l0);
  ['艾琳是什么性格', 'abc 123 漫长', '', '女骑士守信'].forEach(q => rec('gcache', 'memSearch', [l0, q, pick([1, 2, null])], null));
  files['gcache/memSearch'] = [];
  ['艾琳是什么性格', 'abc 123 漫长', '', '女骑士守信'].forEach((q, j) => { const k = [1, 2, null, 3][j]; rec('gcache', 'memSearch', [l0, q, k], G.MemoryManager.search(l0, q, k == null ? undefined : k)); });
  [longWorld, '【世界观】已压缩', JSON.stringify({ c: longWorld + '\n【协议】\n- "引号" 与 \\ 反斜杠的设定行' })].forEach(t => rec('gcache', 'missingL0', [l0, t], G.MemoryManager.missingL0(l0, t)));
}

// ───────── mmcache 纯函数 ─────────
{
  MODELS.forEach(m => { rec('mmcache', 'priceFor', [m], M.priceFor(m)); rec('mmcache', 'isMiniMaxModel', [m], M.isMiniMaxModel(m)); PROVIDERS.forEach(p => rec('mmcache', 'isOpenRouterMiniMax', [p, m], M.isOpenRouterMiniMax(p, m))); });
  ['', 'c1', 'conv-中文', 7].forEach(id => rec('mmcache', 'sessionIdFor', [id], M.sessionIdFor(id)));
  for (let i = 0; i < 40; i++) {
    const sysN = ri(4); const msgs = [];
    for (let j = 0; j < sysN; j++) msgs.push({ role: 'system', content: rnd() < 0.85 ? sentence() : [{ type: 'text', text: 'P' }] });
    mkHist(ri(3), i).forEach(m => msgs.push(m)); msgs.push({ role: 'user', content: sentence() });
    rec('mmcache', 'mergeLeadingSystem', [clone(msgs)], M.mergeLeadingSystem(msgs));
    const body = Object.assign({ model: pick(MODELS.filter(Boolean)), messages: msgs, stream: true }, pick([{}, { provider: { order: ['minimax'] } }, { provider: { order: [] } }, { session_id: 'keep' }, { tools: [{ type: 'function', function: { name: 'f', parameters: { a: 1.5 } } }] }]));
    rec('mmcache', 'prefixOf', [clone(body)], M.prefixOf(body));
    const strBody = rnd() < 0.8;
    const req = { url: 'u', headers: { a: 'b' }, body: strBody ? JSON.stringify(body) : clone(body) };
    const cfg = pick([{}, { mergeSystem: false }, { sessionId: false }]); const info = pick([{ sessionId: M.sessionIdFor('c' + i) }, {}, null]);
    rec('mmcache', 'applyToRequest', [clone(req), clone(cfg), clone(info)], M.applyToRequest(req, cfg, info || undefined));
  }
  [{ url: 'u', body: 'bad' }, { url: 'u', body: JSON.stringify({ model: 'minimax/x' }) }].forEach(req => rec('mmcache', 'applyToRequest', [req, {}, {}], M.applyToRequest(req, {}, {})));
  for (let i = 0; i < 30; i++) {
    const s = { roll: Array.from({ length: ri(6) }, () => ({ prompt: ri(3000), hit: ri(2000), known: rnd() < 0.85 })), lastPromptEst: pick([undefined, 300, 900]), prefixChanges: ri(5), requests: ri(8), routeOrder: rnd() < 0.3, session_id: pick(['', 'sid']), gaps: Array.from({ length: ri(10) }, () => Math.round(rnd() * 12000) / 10) };
    rec('mmcache', 'diagnose', [clone(s)], M.diagnose(s));
    const inf = C.usageInfo({ prompt: ri(3000), hit: rnd() < 0.7 ? ri(2000) : undefined }); rec('mmcache', 'usageText', [inf], M.usageText(inf));
  }
}

// ───────── 插件管线（浏览器模式加载 gcache/mmcache，跑多轮钩子） ─────────
async function scenario(name, opts) {
  const reg = Plugins.createRegistry();
  const clock = { t: opts.t0 };
  const DateMock = class extends Date { static now() { return clock.t; } };
  const sandbox = { Plugins: { registry: reg }, RPCache: { sha256: R.sha256 }, TimeUtil: { localDateStr: () => FIXED_DATE }, CacheCommon: C, Date: DateMock, console, Math, JSON, Object, Array, String, Number, Set, Map, RegExp, Uint32Array, Uint8Array, DataView, TextEncoder, Error, isFinite, parseInt, parseFloat, Infinity, NaN, Promise, Symbol };
  vm.createContext(sandbox);
  for (const f of ['plugins/cache/gcache.js', 'plugins/cache/mmcache.js']) vm.runInContext(fs.readFileSync(WWW + '/' + f, 'utf8'), sandbox, { filename: f });
  const settings = clone(opts.settings || {});
  const toasts = [];
  const host = { settings: () => settings, toast: t => toasts.push(t), saveConv: () => {}, openPanel: () => {}, esc: s => s };
  const conv = { id: opts.convId, model: opts.model, systemPrompt: opts.sys(0), messages: [], plugins: clone(opts.convPlugins || {}) };
  const turns = [];
  for (let t = 0; t < opts.turns; t++) {
    clock.t = opts.t0 + opts.gap(t);
    conv.systemPrompt = opts.sys(t);
    const u = { id: 'u' + t, role: 'user', content: opts.user(t) };
    conv.messages.push(u);
    const wire = conv.messages.filter(m => !m.error).map(m => ({ role: m.role, content: m.content, _src: m }));
    let ctx = { conv, provider: opts.provider, model: opts.model, systemPrompt: conv.systemPrompt, settings, lastUser: u, meta: {}, messages: wire, opts: { stream: true, convId: conv.id, maxTokens: 8192 } };
    const ctxIn = { messages: wire.map(m => ({ role: m.role, content: m.content, srcId: m._src.id })), systemPrompt: conv.systemPrompt, now: clock.t };
    ctx = await reg.runBeforeRequest(ctx, host);
    const body = { model: opts.model, messages: [{ role: 'system', content: ctx.systemPrompt }].concat(ctx.messages.map(m => ({ role: m.role, content: m.content }))), stream: true, max_tokens: 8192 };
    if (opts.bodyExtra) Object.assign(body, opts.bodyExtra(t));
    let req = { url: 'https://openrouter.ai/api/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const reqIn = clone(req);
    const gcp = ctx.opts.orGemini && reg.get('gcache'); if (gcp) req = gcp.transformRequest(req, ctx);
    const mmp = ctx.opts.orMiniMax && reg.get('mmcache'); if (mmp) req = mmp.transformRequest(req, ctx);
    const bot = { id: 'b' + t, role: 'assistant', content: '回复' + t + '：' + shortSentence() };
    conv.messages.push(bot);
    const usage = opts.usage(t);
    const before = toasts.length;
    reg.runAfterResponse(ctx, { ok: true, usage, bot }, host);
    turns.push({ in: { ctx: ctxIn, req: reqIn, usage: usage || null, botId: bot.id, botContent: bot.content, userId: u.id }, out: { req, toasts: toasts.slice(before), plugins: clone(conv.plugins), bot: clone(bot), active: ctx.plugins, meta: clone(ctx.meta) } });
  }
  files['pipeline/' + name] = [JSON.stringify({ in: { convId: opts.convId, model: opts.model, provider: opts.provider, settings: opts.settings || {}, convPlugins: opts.convPlugins || {} }, out: null })].concat(turns.map(x => JSON.stringify(x)));
}
const OR = { id: 'or', type: 'openai', presetId: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' };
await scenario('gcache-rp-hybrid', { convId: 'conv-g1', model: 'google/gemini-2.5-flash', provider: OR, turns: 44, t0: 1.79e12, gap: t => t * 95000 + (t % 7 === 6 ? 400000 : 0),
  sys: t => longWorld + '\n【当前状态】\n第 ' + (1 + (t >> 3)) + ' 天，' + (t % 2 ? '晴' : '雨') + '。', user: t => '第' + t + '轮：' + shortSentence(),
  usage: t => t % 9 === 4 ? { prompt: 4000 + t * 300 } : { prompt: 4000 + t * 300, hit: t < 2 ? 0 : (t % 5 === 0 ? 0 : 3000 + t * 200), cacheWrite: t === 1 ? 3500 : 0 } });
await scenario('gcache-plain-toast', { convId: 'conv-g2', model: 'google/gemini-2.5-pro', provider: OR, turns: 12, t0: 1.79e12, gap: t => t * 30000,
  settings: { plugins: { gcache: { toast: true, mode: 'auto', hybrid: false } } }, sys: () => '你是助手', user: t => 'Q' + t + ' ' + sentence(),
  usage: t => ({ prompt: 1200 + t * 50, hit: t > 2 && t % 4 ? 0 : 1000 }) });
await scenario('gcache-compat-adapter', { convId: 'conv-g3', model: 'gemini-2.5-flash-lite', provider: { id: 'c', type: 'openai', presetId: 'custom', name: 'X', baseUrl: 'https://x.example/v1' }, turns: 6, t0: 1.8e12, gap: t => t * 1000,
  sys: () => longWorld, user: t => sentence(), usage: t => ({ prompt: 3000, hit: 2900, cacheSupported: true }) });
await scenario('mmcache-basic', { convId: 'conv-m1', model: 'minimax/minimax-m3.1-flash', provider: OR, turns: 14, t0: 1.79e12, gap: t => t * (t % 4 === 3 ? 700000 : 60000),
  settings: { plugins: { mmcache: { toast: true } } }, sys: t => '设定 v' + (t > 8 ? 2 : 1) + '\n' + longWorld.slice(0, 600), user: t => sentence(),
  bodyExtra: t => t === 5 ? { provider: { order: ['minimax'] } } : {}, usage: t => t === 3 ? null : t % 6 === 2 ? { prompt: 400 } : { prompt: 900 + t * 40, hit: t < 1 ? 0 : 300 + t * 10 } });
await scenario('mmcache-disabled-conv', { convId: 'conv-m2', model: 'minimax/minimax-m3', provider: OR, turns: 3, t0: 1.79e12, gap: t => t * 1000,
  convPlugins: { mmcache: { enabled: false } }, sys: () => 'S', user: t => 'u' + t, usage: () => ({ prompt: 600, hit: 512 }) });

// ───────── 写出 / 校验 ─────────
let changed = 0, total = 0;
for (const [k, lines] of Object.entries(files)) {
  const data = lines.join('\n') + '\n'; total += lines.length;
  const big = Buffer.byteLength(data) > 256 * 1024;      // 大文件存 .jsonl.gz（Kotlin 侧两种都读）
  const f = OUT + '/' + k + (big ? '.jsonl.gz' : '.jsonl');
  const other = OUT + '/' + k + (big ? '.jsonl' : '.jsonl.gz');
  if (CHECK) {
    const cur = fs.existsSync(f) ? (big ? zlib.gunzipSync(fs.readFileSync(f)).toString('utf8') : fs.readFileSync(f, 'utf8')) : null;
    if (cur !== data) { changed++; console.error('golden 过期：' + path.relative(ROOT, f)); }
  } else {
    fs.mkdirSync(path.dirname(f), { recursive: true }); if (fs.existsSync(other)) fs.unlinkSync(other);
    fs.writeFileSync(f, big ? zlib.gzipSync(data, { level: 9, mtime: 0 }) : data);
  }
}
console.log((CHECK ? '校验 ' : '写出 ') + Object.keys(files).length + ' 个文件，' + total + ' 条向量' + (CHECK ? (changed ? '，' + changed + ' 个过期' : '，全部一致') : ''));
if (CHECK && changed) process.exit(1);
