#!/usr/bin/env node
/*
 * 工作流 B · M3 golden 导出器：模型列表 / 元数据 / 价格 / endpoints 最低价同步 / Router / planOpenRouterRoute / observeRoute /
 * buildChatRequest 的 routePrices 分支 / localeCompare。
 * 随机用例全部来自固定种子的 mulberry32，且所有时间都显式给出（at / now），结果与墙钟无关、可重复。
 * 用法：node app/src/test/resources/net-golden/export-m3.js [--check]   （--check 只比对，有差异退出码 1）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const WWW = path.resolve(__dirname, '../../../main/assets/www');
require(path.join(WWW, 'plugins/cache/cache-common.js'));
const R = require(path.join(WWW, 'router.js'));
const C = require(path.join(WWW, 'cost-core.js'));
const P = require(path.join(WWW, 'providers.js'));
const OUT = __dirname;
const check = process.argv.includes('--check');
const clone = o => o === undefined ? null : JSON.parse(JSON.stringify(o));

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const T0 = 1767225600000; // 2026-01-01T00:00:00Z

const preset = id => { const p = P.PRESETS.find(x => x.presetId === id); return Object.assign({ id: 'p_' + id }, JSON.parse(JSON.stringify(p))); };
const prov = (id, extra) => Object.assign(preset(id), extra || {});
const stripAuth = h => { const o = Object.assign({}, h); ['Authorization', 'x-api-key', 'x-goog-api-key'].forEach(k => delete o[k]); return o; };

// ---------------- localeCompare（parseModelsResponse 排序 / Router 同分 tie-break） ----------------
const LC_IDS = ['', '!a', '(a', '~a', '10', '9', 'a_b', 'a-b', 'a.b', 'a/b', 'ab', 'aB', 'Ab', 'AB', 'claude-opus-5-5', 'claude-opus-5.5', 'claude-opus-5',
  'gpt 4', 'gpt_4', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'GPT-4o', 'gpt4', 'qwen-plus', 'Qwen/Qwen3-32B', 'qwen3-vl', 'qwen3.8-max', 'x:y', 'x+y', 'x~y', 'z',
  'deepinfra', 'DeepInfra', 'deep-infra', 'Deep Infra', 'together', 'Together', 'fireworks', 'Fireworks', 'novita', 'parasail/fp8', 'parasail/bf16',
  'google-vertex', 'google-vertex/global', 'google-ai-studio', 'anthropic', 'amazon-bedrock', 'azure', 'openai', 'mistralai/mistral-7b-instruct:free',
  'meta-llama/llama-3.1-8b-instruct', 'meta-llama/llama-3.1-70b-instruct', 'openrouter/auto', 'a1', 'a01', 'a001', 'a#b', 'a$b', 'a@b', 'a&b', 'a*b', 'a,b',
  'a;b', 'a?b', "a'b", 'a"b', 'a[b', 'a]b', 'a{b', 'a}b', 'a\\b', 'a%b', 'a`b', 'a^b', 'a<b', 'a=b', 'a>b', 'a|b', 'élan', 'elan', 'Elan', 'eland', 'résumé', 'resume'];
const lcSorted = LC_IDS.slice().sort((a, b) => a.localeCompare(b));
const lcLines = [{ name: 'sort', in: [LC_IDS], out: lcSorted }];
{
  const rnd = mulberry32(7);
  for (let i = 0; i < 300; i++) {
    const a = LC_IDS[(rnd() * LC_IDS.length) | 0], b = LC_IDS[(rnd() * LC_IDS.length) | 0];
    lcLines.push({ in: [a, b], out: Math.sign(a.localeCompare(b)) });
  }
}

// ---------------- classifyModel ----------------
const clsCases = [
  ['gpt-4o', null], ['text-embedding-3-small', null], ['bge-m3', null], ['m3e-base', null], ['whisper-1', null], ['paraformer-v2', null],
  ['tts-1', null], ['cosyvoice-v1', null], ['sora-2', null], ['kling-v1', null], ['wanx2.1-t2v-turbo', null], ['wan2.2-i2v-plus', null],
  ['veo-3', null], ['dall-e-3', null], ['flux.1-schnell', null], ['wanx-v1', null], ['seedream-4', null], ['gpt-image-1', null], ['asr-model', null],
  ['gpt-4o-transcribe', null], ['some-stt', null], ['Qwen/Qwen2-VL', null], ['', null], [null, null],
  ['google/gemini-2.5-flash-image', { modality: 'text+image->text+image' }], ['x', { modality: 'text->embedding' }], ['x', { modality: 'embeddings' }],
  ['x', { modality: 'text->video' }], ['x', { modality: 'text->audio' }], ['x', { modality: 'text->speech' }], ['x', { modality: 'audio->transcription' }],
  ['openai/whisper-large', { modality: 'audio->text' }], ['openai/gpt-4o-audio', { modality: 'audio->text' }], ['whisper', { modality: 'audio+image->text' }],
  ['x', { modality: 'text->text' }], ['tts-x', { modality: 'text' }], ['x', { modality: 'TEXT->IMAGE' }], ['x', { modality: '' }], ['STT-x', { modality: 'Audio-> text ' }],
];
const clsLines = clsCases.map(([id, meta]) => ({ in: [id, meta], out: P.classifyModel(id, meta) }));

// ---------------- buildModelsRequest / buildEndpointsRequest ----------------
const reqProvs = [prov('openai'), prov('deepseek'), prov('openrouter'), prov('anthropic'), prov('gemini'), prov('qwen'),
  prov('custom', { baseUrl: ' https://OpenRouter.ai/api/v1/// ' }), prov('custom', { baseUrl: 'https://example.com/v1/' })];
const modelsReqLines = reqProvs.map(p => { const r = P.buildModelsRequest(p); return { in: [p], out: { url: r.url, method: r.method, headers: stripAuth(r.headers) } }; });
const epIds = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5', 'meta-llama/llama-3.1-8b-instruct:free', 'a b/c?d#e', '中文/模型', '', null, 'x//y', '~!*()\''];
const epReqLines = epIds.map(id => { const r = P.buildEndpointsRequest(prov('openrouter'), id); return { in: [prov('openrouter'), id], out: { url: r.url, method: r.method, headers: stripAuth(r.headers) } }; });

// ---------------- parseModelsResponse / parseModelsMeta ----------------
const orModels = JSON.stringify({ data: [
  { id: 'openai/gpt-4o', context_length: 128000, top_provider: { context_length: 128000, max_completion_tokens: 16384 }, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'] }, pricing: { prompt: '0.0000025', completion: '0.00001', input_cache_read: '0.00000125', image: '0.003613', request: '0' } },
  { id: 'google/gemini-2.5-flash-image', context_length: 32768, architecture: { input_modalities: ['image', 'text'], output_modalities: ['image', 'text'] }, pricing: { prompt: '0.0000003', completion: '0.0000025', image: '0.001238', image_output: '0.00003' } },
  { id: 'openrouter/auto', context_length: 2000000, architecture: { modality: 'text->text' }, pricing: { prompt: '-1', completion: '-1' } },
  { id: 'deepseek/deepseek-chat-v3.1:free', context_length: '163840', top_provider: { max_completion_tokens: null }, pricing: { prompt: '0', completion: '0' } },
  { id: 'qwen/qwen3-embedding', architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] }, pricing: { prompt: '0.00000002' } },
  { id: 'x-ai/grok-4', top_provider: { context_length: 256000, max_completion_tokens: 0 }, pricing: { prompt: 3e-6, completion: '1.5e-5', input_cache_read: '7.5e-7' } },
  { id: 'Qwen/Qwen3-32B', name: 'ignored' }, { id: 'openai/gpt-4o' }, { name: 'only-name', type: 'embedding' }, { id: '' }, 'bare-string', { id: 'Anthropic/Claude', modality: 'text->text', max_output_tokens: 8192, context_window: 200000 },
  { id: 'tts-1', type: 'tts' }, { id: 'tiny-price', pricing: { prompt: '0.0000000000001', completion: '1e-12' } }, { id: 'round-price', pricing: { prompt: '0.00000014999999', completion: '0.0000001234567' } },
] });
const anthModels = JSON.stringify({ data: [{ type: 'model', id: 'claude-sonnet-4-5', display_name: 'Claude', max_input_tokens: 200000, max_tokens: 64000 }, { type: 'model', id: 'claude-opus-4-1' }], has_more: false });
const gemModels = JSON.stringify({ models: [
  { name: 'models/gemini-2.5-pro', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/text-embedding-004', inputTokenLimit: 2048, supportedGenerationMethods: ['embedContent'] },
  { name: 'models/gemini-old' }, { name: 'gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: '' },
] });
const arrModels = JSON.stringify(['b', 'a', 'B', 'a', '', 'gpt-4.1', 'gpt-4o', { id: 'c' }]);
const sortModels = JSON.stringify({ models: LC_IDS.map(id => ({ id })) });
const modelTexts = [['openai', orModels], ['anthropic', anthModels], ['gemini', gemModels], ['openai', gemModels], ['openai', arrModels], ['openai', sortModels],
  ['openai', '{}'], ['openai', '{"data":[]}'], ['openai', '[]'], ['openai', '{"data":null,"models":[{"id":"m1"}]}'], ['openai', 'not json'], ['gemini', '{"models":[{"name":"models/x","supportedGenerationMethods":[]}]}']];
const modelsLines = modelTexts.map(([t, x]) => { let out; try { out = P.parseModelsResponse(t, x); } catch (e) { out = { error: true }; } return { in: [t, x], out }; });
const metaLines = modelTexts.map(([t, x]) => ({ in: [t, x], out: P.parseModelsMeta(t, x) }));

// ---------------- pricingFromRaw / floorPricingFromEndpoints（折后价，不乘 discount） ----------------
const prs = [null, 'x', {}, { prompt: '0.0000025', completion: '0.00001' }, { prompt: 2.5e-6, completion: '1e-5', input_cache_read: '2.5e-7', image: '0.04', image_output: '0.00004', discount: 0.5 },
  { prompt: '-1', completion: '0' }, { prompt: 'abc', completion: '' }, { prompt: '0.0000001234564999', completion: '0.00000099999995' }, { image: '0.0000005' }, { prompt: '1' },
  { prompt: '3e-7', completion: '0.0000012', input_cache_read: '0' }];
const pricingLines = [];
prs.forEach(pr => pricingLines.push({ in: [pr, 1], out: P.parsePricing(pr) }));
prs.forEach(pr => pricingLines.push({ name: 'effectiveTokenPricing', in: [pr, 1], out: P.effectiveTokenPricing(pr) }));
const EPS = [
  { name: 'DeepInfra | qwen3', provider_name: 'DeepInfra', tag: 'deepinfra/fp8', context_length: 40960, pricing: { prompt: '0.0000001', completion: '0.0000003', input_cache_read: '0.00000002', discount: 0.25 }, latency: 0.42, status: 0 },
  { name: 'Together | qwen3', provider_name: 'Together', tag: 'together', pricing: { prompt: '0.0000002', completion: '0.0000002', discount: 0 }, latency_p50: 812 },
  { name: 'Novita', provider_name: 'Novita', pricing: { prompt: '0.00000015', completion: '0.00000025' }, stats: { latency_p50: 1.5 } },
  { provider_name: 'Parasail', tag: 'parasail', pricing: { prompt: '0.00000009', completion: '0.00000031', input_cache_read: '0.00000009' }, stats: { latency: 19.99 } },
  { provider: { slug: 'cheap-no-prompt' }, pricing: { completion: '0.0000001' } },
  { provider: { name: 'Free' }, pricing: { prompt: '0', completion: '0' } },
  { tag: '', provider_name: '', name: '', provider: { slug: '', name: 'ByProviderName' }, pricing: { prompt: '0.0000004', completion: '0' }, latency: '20' },
  null, { pricing: { prompt: '0.0000001' } }, { tag: 'nan-lat', pricing: { prompt: '0.0000001', completion: '0.0000003' }, latency: 'abc', latency_p50: 5 },
  { tag: 'flex', pricing: { prompt: '0.00000005', completion: '0.00000035', discount: 0.5 }, latency: null, latency_p50: null, stats: { latency: null, latency_p50: 0.25 } },
];
const floorSets = [EPS, EPS.slice(0, 2), EPS.slice(1, 3), [EPS[1], EPS[3]], [EPS[3], EPS[1]], [EPS[4], EPS[5]], [], null, 'x', [EPS[10], EPS[0]],
  [{ pricing: { prompt: '0.000001', completion: '0.000001' } }, { pricing: { prompt: '0.0000005', completion: '0.0000015' } }, { pricing: { prompt: '0.0000005', completion: '0.0000015', input_cache_read: '1e-7' } }]];
const floorLines = floorSets.map(s => ({ in: [s], out: P.floorPricingFromEndpoints(s) }));
const epTexts = [JSON.stringify({ data: { id: 'm', endpoints: EPS.slice(0, 3) } }), JSON.stringify({ endpoints: [EPS[0]] }), JSON.stringify([EPS[1]]), JSON.stringify({ data: [EPS[2]] }), '{"data":{}}', 'null', 'oops', '"str"', '{"endpoints":{}}'];
const epParseLines = epTexts.map(t => ({ in: [t], out: P.parseEndpointsResponse(t) }));
const latLines = EPS.concat([{ latency: 0 }, { latency: -3 }, { latency: 19.9999 }, { latency: 20 }, { latency: 1234.5 }, { latency: 0.0005 }, { latency: '0.3' }, { stats: {} }, {}]).map(e => ({ in: [e], out: P.endpointLatencyMs(e) }));
const rpLines = floorSets.map(s => ({ in: [s], out: P.endpointRoutePrices(s) }));

// ---------------- mergeFloorPrice / syncUsagePricesFromEndpoints / syncPricesFromProviderMeta ----------------
const NOW = T0 + 123456;
const priceBags = [null, {}, { default: { hit: 0.1, miss: 1, out: 2 } }, { default: { miss: 'x' } }, { 'qwen/qwen3': { hit: 0.02, miss: 0.1, out: 0.3, source: 'manual', note: 'keep' } },
  { 'qwen/qwen3': { miss: '0.5', out: '' } }, { default: { miss: '2', out: 3 } }];
const floors = [null, { prompt: 0.1, completion: 0.3, cacheRead: 0.02 }, { prompt: 0.1 }, { completion: 0.4 }, { cacheRead: 0.01 }, { prompt: -1, completion: 0 }, { image: 0.04 }];
const mergeLines = [];
priceBags.forEach(b => floors.forEach(f => mergeLines.push({ in: [b, 'qwen/qwen3', f, NOW], out: C.mergeFloorPrice(clone(b), 'qwen/qwen3', f, NOW) })));
mergeLines.push({ in: [{ a: 1 }, '', { prompt: 1 }, NOW], out: C.mergeFloorPrice({ a: 1 }, '', { prompt: 1 }, NOW) });

// app.js syncUsagePricesFromEndpoints 的纯函数镜像（usageState.prices 作参数；返回 next 或 null = 未变化）
function syncUsage(prices, modelId, endpoints, now) {
  if (!modelId || !endpoints || !P.syncFloorPrices) return null;
  const prev = prices && prices[modelId];
  const next = P.syncFloorPrices(prices, modelId, endpoints, now);
  const rec = next && next[modelId];
  if (!rec) return null;
  if (prev && prev.miss === rec.miss && prev.hit === rec.hit && prev.out === rec.out) return null;
  return next;
}
const syncLines = [];
[null, {}, { 'm': { miss: 0.1, hit: 0.02, out: 0.3 } }, { 'm': { miss: 0.1, hit: 0.02, out: 0.3, source: 'x', syncedAt: 1 } }, { 'm': { miss: '0.1', hit: 0.02, out: 0.3 } }, { 'm': { miss: 0.1, out: 0.3 } }]
  .forEach(b => [EPS.slice(0, 2), [EPS[4]], [], null, [{ pricing: { prompt: '0.0000001', completion: '0.0000003', input_cache_read: '0.00000002' } }]]
    .forEach(eps => syncLines.push({ in: [b, 'm', eps, NOW], out: syncUsage(clone(b), 'm', eps, NOW) })));
// syncPricesFromProviderMeta 镜像（app.js 309–318，无 TDZ：纯函数，返回 {prices, changed}）
function syncFromMeta(providers, prices, now) {
  let cur = prices || {}; let changed = false;
  (providers || []).forEach(p => {
    const meta = p && p.modelMeta; if (!meta) return;
    Object.keys(meta).forEach(mid => {
      const eps = (meta[mid] && (meta[mid]._endpoints || meta[mid].endpoints)) || [];
      if (eps.length) { const n = syncUsage(cur, mid, eps, now); if (n) { cur = n; changed = true; } }
    });
  });
  return { prices: cur, changed };
}
const metaProvs = [
  prov('openrouter', { modelMeta: { 'qwen/qwen3': { price: { prompt: 1 }, _endpoints: EPS.slice(0, 3) }, 'openai/gpt-4o': { endpoints: [EPS[1]] }, 'none': { _endpoints: [] }, 'str': { _endpoints: 'abc' }, 'x': null } }),
  prov('deepseek', { modelMeta: {} }), prov('custom', { modelMeta: { 'qwen/qwen3': { _endpoints: [EPS[3]] } } }),
];
const syncMetaLines = [[metaProvs, null], [metaProvs, { 'qwen/qwen3': { miss: 0.09, hit: 0.09, out: 0.31 } }], [[metaProvs[1]], { a: 1 }], [[], null]]
  .map(([ps, pr]) => ({ in: [ps, pr, NOW], out: syncFromMeta(clone(ps), clone(pr), NOW) }));

// ---------------- Router 基础函数 ----------------
const routerFnLines = [];
const rf = (fn, args, out) => routerFnLines.push({ name: fn, in: args, out: out === undefined ? null : out });
[[6, 4], [6, 4, 0], [1, 1], [100, 3], [0, 0], [-1, 5], [1e-12, 1e-12], [50.5, 0.25, 2], [6, 4, null], [3.7, 9.1, 1.28]].forEach(a => rf('hitQuantile', a, R.hitQuantile.apply(null, a)));
[[1, 0.1, 0.5], [1, null, 0.5], [1, 'x', 0.3], ['2', '0.5', 0.9], [1, 0.1, 1], [1, 0.1, -1], [1, 0.1, 'x'], ['x', 0.1, 0.5], [0.3, 0.03, 0.6363]].forEach(a => rf('effectivePrice', a, R.effectivePrice.apply(null, a)));
[[1, 0, null], [1, 2000, null], [1, 4000, null], [1, 100, null], [1, 100000, null], [1, 3000, { latencyWeight: 0 }], [1, 3000, { latencyRefMs: 0 }], [1, 3000, { latencyWeight: 0.5, latencyRefMs: 1000 }], [Infinity, 3000, null], [0.25, '1500', null]]
  .forEach(a => rf('effectiveScore', a, R.effectiveScore.apply(null, a)));
[[[{ slug: 'a', pMiss: 1, pHit: 0.1 }, { slug: 'b', pMiss: 2 }, { slug: 'c', pMiss: '3', pHit: null, scale: 2 }, null], { m: { scale: 1.5 } }, 'm'],
  [[{ slug: 'a', pMiss: 1, pHit: 0.1 }], { m: { scale: 1 } }, 'm'], [[{ slug: 'a', pMiss: 1 }], null, 'm'], [[{ slug: 'a', pMiss: 'x', pHit: 0.1 }], { m: { scale: 0.8 } }, 'm'],
  [[{ slug: 'a', pMiss: 1, scale: -1 }], { m: { scale: -2 } }, 'm'], [[{ slug: 'a', pMiss: 1 }], { m: { scale: 2 } }, ''], ['notarray', null, 'm']]
  .forEach(a => rf('applyCalibScale', a, R.applyCalibScale.apply(null, a)));
[[{ latencyMs: 300 }, { latEwma: 500 }], [{}, { latEwma: 500 }], [{ latencyMs: 0 }, {}], [null, null], [{ latencyMs: '700' }, null]].forEach(a => rf('latencyOf', a, R.latencyOf.apply(null, a)));
[[0, null], [8000, { infoWeight: true }], [0, { infoWeight: true }], [100, { infoWeight: true }], [1e6, { infoWeight: true }], [500, { infoWeight: true, refTokens: 1000 }], [500, { infoWeight: false }]]
  .forEach(a => rf('evidenceWeight', a, R.evidenceWeight.apply(null, a)));
[[1, 0.5, 20000, 1, 0.1], [1, 0.5, 20000, NaN, 0.1], [1, 0.5, 20000, NaN, NaN], [0.5, 1, 20000, NaN, 0.1], [1, 0.5, -5, 1, 0.1], [1, 0.5, 3e9, 1, 0.1], [1, 0.5, 20000.9, 0.1, 1], [NaN, 0.5, 100, NaN, NaN]]
  .forEach(a => rf('switchCost', a.map(x => (typeof x === 'number' && isNaN(x)) ? null : x), R.switchCost(a[0], a[1], a[2], a[3], a[4])));
rf('buildProviderField', ['deepinfra', { enabled: true }], R.buildProviderField('deepinfra', { enabled: true }));
rf('buildProviderField', ['deepinfra', { enabled: false }], R.buildProviderField('deepinfra', { enabled: false }));
rf('buildProviderField', [null, null], R.buildProviderField(null, null));
// observe 序列（含 hitTokens 越界、promptTokens=0、hit 布尔、ok=false 熔断计数、latency EWMA）
{
  const seqs = [
    [{ hitTokens: 800, promptTokens: 1000, latencyMs: 1200 }, { hitTokens: 2000, promptTokens: 1000 }, { hitTokens: -5, promptTokens: 1000, latencyMs: 300 }, { hit: true }, { hit: false, ok: false }, { ok: false }, {}, { hitTokens: 10, promptTokens: 0, hit: true, latencyMs: '900' }],
    [{ hit: true, latencyMs: 0 }, { ok: false, latencyMs: 5000 }, { hitTokens: 1, promptTokens: 3 }],
  ];
  seqs.forEach((seq, si) => {
    const state = {};
    seq.forEach((o, i) => R.observe(state, 'm', 's' + (i % 2), o, T0 + i * 1000));
    rf('observeSeq', [seq, T0, 1000], state);
  });
  const st2 = {}; R.observe(st2, 'm', 'a', { hitTokens: 300, promptTokens: 9000 }, T0, { infoWeight: true }); R.observe(st2, 'm', 'a', { hitTokens: 300, promptTokens: 9000, latencyMs: 100 }, T0 + 1, { infoWeight: true, refTokens: 4000, latEwmaAlpha: 0.5 });
  R.observe(st2, 'm', 'a', { latencyMs: 300 }, T0 + 2, { latEwmaAlpha: 0.5 });
  rf('observeWithOpts', [], st2);
  const st3 = {}; R.markFail(st3, 'm', 'x', T0); R.markFail(st3, 'm', 'x', T0 + 5); R.recordSwitch(st3, 'm', 'x', 'y', T0 + 9); R.recordSwitch(st3, 'm', 'y', 'y', T0 + 99);
  rf('markFailRecordSwitch', [], st3);
}

// ---------------- chooseUpstream：随机 + 手写边界 ----------------
const SLUGS = ['deepinfra', 'DeepInfra', 'deep-infra', 'together', 'Together', 'novita', 'parasail/fp8', 'a_b', 'a-b', 'fireworks'];
const PRICE_SET = [0.1, 0.15, 0.2, 0.2, 0.3, 1, 3, '0.5', 0.07];
function randStats(rnd) {
  return { a: +(rnd() * 40).toFixed(3), b: +(rnd() * 40).toFixed(3), obs: (rnd() * 12) | 0, lastAt: rnd() < 0.2 ? 0 : T0 - ((rnd() * 2 * 3600e3) | 0),
    fails: rnd() < 0.15 ? ((rnd() * 5) | 0) : 0, latEwma: rnd() < 0.5 ? 0 : +(rnd() * 5000).toFixed(1), latN: (rnd() * 4) | 0 };
}
function randPrices(rnd, slugs) {
  return slugs.map(slug => {
    const pm = PRICE_SET[(rnd() * PRICE_SET.length) | 0];
    const o = { slug, pMiss: pm };
    const r = rnd();
    if (r < 0.6) o.pHit = typeof pm === 'number' ? +(pm * [0.1, 0.25, 0.5, 1][(rnd() * 4) | 0]).toFixed(4) : '0.05';
    else if (r < 0.7) o.pHit = null;
    o.ok = rnd() < 0.08 ? false : true;
    if (rnd() < 0.5) o.latencyMs = [0, 300, 900, 2000, 4500, 20000][(rnd() * 6) | 0];
    if (rnd() < 0.1) o.calibScale = 1.2;
    return o;
  });
}
const chooseLines = [];
{
  const rnd = mulberry32(20261113);
  for (let i = 0; i < 600; i++) {
    const n = 1 + ((rnd() * 4) | 0);
    const slugs = []; while (slugs.length < n) { const s = SLUGS[(rnd() * SLUGS.length) | 0]; if (!slugs.includes(s)) slugs.push(s); }
    const prices = randPrices(rnd, slugs);
    const ups = {}; slugs.forEach(s => { if (rnd() < 0.85) ups[s] = randStats(rnd); });
    const stats = { current: null, lastSwitchAt: 0, upstreams: ups };
    const cr = rnd();
    const current = cr < 0.2 ? null : cr < 0.3 ? 'gone' : slugs[(rnd() * slugs.length) | 0];
    const prefix = [0, 500, 20000, 120000, 3e9][(rnd() * 5) | 0];
    const opts = { now: T0 };
    if (rnd() < 0.3) opts.minObs = (rnd() * 6) | 0;
    if (rnd() < 0.2) opts.dwell = [1, 3, 8, 30][(rnd() * 4) | 0];
    if (rnd() < 0.2) opts.switchMargin = [0.9, 0.97, 1][(rnd() * 3) | 0];
    if (rnd() < 0.15) opts.idleMs = [0, 3600e3, 7200e3][(rnd() * 3) | 0];
    if (rnd() < 0.1) opts.latencyWeight = 0;
    if (rnd() < 0.05) opts.enabled = false;
    if (rnd() < 0.1) opts.stickyIdleMs = 0;
    chooseLines.push({ in: [prices, stats, current, prefix, opts], out: R.chooseUpstream(prices, stats, current, prefix, opts) });
  }
  const hot = () => ({ a: 30, b: 5, obs: 10, lastAt: T0 - 1000, fails: 0, latEwma: 0, latN: 0 });
  const tie = [{ slug: 'b', pMiss: 1, pHit: 0.1 }, { slug: 'a', pMiss: 1, pHit: 0.1 }, { slug: 'A', pMiss: 1, pHit: 0.1 }, { slug: 'a-b', pMiss: 1, pHit: 0.1 }, { slug: 'a_b', pMiss: 1, pHit: 0.1 }];
  const tieUps = {}; tie.forEach(x => { tieUps[x.slug] = hot(); });
  const hand = [
    [tie, { upstreams: tieUps }, null, 20000, { now: T0 }],
    [tie, { upstreams: tieUps }, 'b', 20000, { now: T0 }],
    [[{ slug: 'x', pMiss: 1 }], null, null, 0, { now: T0 }],
    [[{ slug: 'x', pMiss: 1 }], null, 'cur', 0, { now: T0 }],
    [[], null, 'cur', 0, { now: T0 }], [[], null, null, 0, { now: T0 }], [null, null, null, 0, { enabled: false }], [[{ slug: 'z', pMiss: 1 }], null, null, 0, { enabled: false }],
    [[{ slug: 'cheap', pMiss: 0.1, pHit: 0.01 }, { slug: 'cur', pMiss: 0.3, pHit: 0.03 }], { upstreams: { cheap: hot(), cur: Object.assign(hot(), { lastAt: T0 - 7200e3 }) } }, 'cur', 20000, { now: T0 }],
    [[{ slug: 'cheap', pMiss: 0.1, pHit: 0.01 }, { slug: 'cur', pMiss: 0.3, pHit: 0.03 }], { upstreams: { cheap: hot(), cur: Object.assign(hot(), { lastAt: T0 - 7200e3, fails: 1 }) } }, 'cur', 20000, { now: T0 }],
    [[{ slug: 'cheap', pMiss: 0.2, pHit: 0.02 }, { slug: 'cur', pMiss: 0.3, pHit: 0.03 }], { upstreams: { cheap: hot(), cur: Object.assign(hot(), { lastAt: T0 - 7200e3 }) } }, 'cur', 20000, { now: T0 }],
    [[{ slug: 'fast', pMiss: 1, pHit: 0.1, latencyMs: 300 }, { slug: 'cur', pMiss: 1, pHit: 0.1, latencyMs: 6000 }], { upstreams: { fast: hot(), cur: hot() } }, 'cur', 20000, { now: T0 }],
    [[{ slug: 'c2', pMiss: 0.9, pHit: 0.9 }, { slug: 'cur', pMiss: 1, pHit: 0.1 }], { upstreams: { c2: hot(), cur: hot() } }, 'cur', 100, { now: T0 }],
    [[{ slug: 'c2', pMiss: 0.5, pHit: 0.05 }, { slug: 'cur', pMiss: 1, pHit: 0.1 }], { upstreams: { c2: hot(), cur: Object.assign(hot(), { obs: 1 }) } }, 'cur', 20000, { now: T0 }],
    [[{ slug: 'c2', pMiss: 0.5, pHit: 0.05 }, { slug: 'cur', pMiss: 1, pHit: 0.1 }], { upstreams: { c2: hot(), cur: Object.assign(hot(), { fails: 3 }) } }, 'cur', 20000, { now: T0 }],
    [[{ slug: 'c2', pMiss: 'x' }, { slug: 'c3', pMiss: 'y' }], { upstreams: { c2: hot(), c3: hot() } }, null, 20000, { now: T0 }],
  ];
  hand.forEach(a => chooseLines.push({ name: 'hand', in: a, out: R.chooseUpstream.apply(null, clone(a)) }));
}

// ---------------- panelView ----------------
const panelLines = [];
{
  const ms = { current: 'a', lastSwitchAt: T0, upstreams: { a: { a: 20, b: 5, obs: 7, lastAt: T0, fails: 0, latEwma: 0, latN: 0 }, b: { a: 6, b: 4, obs: 1, lastAt: 0, fails: 0, latEwma: 800, latN: 2 } } };
  const pm = { a: { slug: 'a', pMiss: 1, pHit: 0.1, latencyMs: 2500, calibScale: 1.3 }, b: { slug: 'b', pMiss: 'x', latencyMs: 0 } };
  [[ms, pm], [ms, null], [Object.assign({}, ms, { current: 'b' }), pm], [Object.assign({}, ms, { current: 'b' }), null], [Object.assign({}, ms, { current: 'zz' }), pm],
    [Object.assign({}, ms, { current: null }), pm], [null, null], [{}, {}], [Object.assign({}, ms, { lastSwitchAt: 0 }), { a: { slug: 'a', pMiss: 1 } }]]
    .forEach(a => panelLines.push({ in: a, out: R.panelView.apply(null, clone(a)) }));
}

// ---------------- replay（mulberry32 种子生成的长序列） ----------------
const replayLines = [];
[1, 2, 3, 42, 20261113].forEach(seed => {
  const rnd = mulberry32(seed);
  const slugs = ['deepinfra', 'together', 'novita', 'parasail'];
  const base = { deepinfra: [0.1, 0.02], together: [0.2, 0.2], novita: [0.15, 0.03], parasail: [0.09, 0.09] };
  const steps = []; let at = T0;
  for (let i = 0; i < 120; i++) {
    at += rnd() < 0.05 ? 2 * 3600e3 : ((rnd() * 60e3) | 0) + 1;
    const prices = slugs.filter(() => rnd() < 0.9).map(s => {
      const drift = 1 + (rnd() - 0.5) * 0.2;
      const o = { slug: s, pMiss: +(base[s][0] * drift).toFixed(5), pHit: +(base[s][1] * drift).toFixed(5) };
      if (rnd() < 0.3) o.latencyMs = [300, 900, 2500, 6000][(rnd() * 4) | 0];
      if (rnd() < 0.03) o.ok = false;
      return o;
    });
    const step = { prices, at };
    const r = rnd();
    if (r < 0.6) { step.promptTokens = 1000 + ((rnd() * 40000) | 0); step.hitTokens = (step.promptTokens * rnd()) | 0; }
    else if (r < 0.8) step.hit = rnd() < 0.5;
    if (rnd() < 0.08) step.ok = false;
    if (rnd() < 0.1) step.prefixTokens = (rnd() * 100000) | 0;
    steps.push(step);
  }
  const opts = { now: at + 1000, model: 'qwen/qwen3', prefixTokens: seed === 42 ? 0 : 30000 };
  if (seed === 3) Object.assign(opts, { minObs: 2, dwell: 3, latencyWeight: 0.3 });
  replayLines.push({ name: 'seed' + seed, in: [steps, opts], out: R.replay(steps, opts) });
});

// ---------------- planOpenRouterRoute / observeRoute ----------------
const planLines = [];
{
  const orP = prov('openrouter');
  const hotSt = () => ({ 'qwen/qwen3': { current: 'together', lastSwitchAt: T0 - 5000, upstreams: {
    'deepinfra/fp8': { a: 30, b: 4, obs: 9, lastAt: T0 - 1000, fails: 0, latEwma: 400, latN: 3 },
    together: { a: 10, b: 20, obs: 9, lastAt: T0 - 2000, fails: 0, latEwma: 0, latN: 0 },
    Novita: { a: 6, b: 4, obs: 6, lastAt: T0 - 3000, fails: 3, latEwma: 0, latN: 0 } } } });
  const cases = [
    [orP, 'qwen/qwen3', EPS, hotSt(), { prefixTokens: 20000, routerOpts: { now: T0 } }],
    [orP, 'qwen/qwen3', EPS, hotSt(), { prefixTokens: 20000, calib: { 'qwen/qwen3': { scale: 1.25 } }, routerOpts: { now: T0 } }],
    [orP, 'qwen/qwen3', EPS, {}, { prefixTokens: 100, routerOpts: { now: T0 } }],
    [orP, 'qwen/qwen3', EPS, null, { routerOpts: { now: T0 } }],
    [orP, 'qwen/qwen3', [], hotSt(), { routerOpts: { now: T0 } }],
    [orP, 'qwen/qwen3', [EPS[4], EPS[5]], hotSt(), { routerOpts: { now: T0 } }],
    [orP, 'qwen/qwen3', EPS, hotSt(), { cacheAffinity: false, orSort: 'price' }],
    [prov('openrouter', { cacheAffinity: false, orSort: 'throughput' }), 'qwen/qwen3', EPS, hotSt(), {}],
    [prov('openrouter', { cacheAffinity: false }), 'qwen/qwen3', EPS, hotSt(), {}],
    [orP, 'qwen/qwen3', [EPS[2]], { 'qwen/qwen3': { current: null, lastSwitchAt: 0, upstreams: { Novita: { a: 1, b: 1, obs: 0, lastAt: 0, fails: 5, latEwma: 0, latN: 0 } } } }, { routerOpts: { now: T0 } }],
    [orP, '', EPS, {}, { routerOpts: { now: T0, minObs: 0 } }],
    [orP, 'qwen/qwen3', EPS, hotSt(), { prefixTokens: 20000, routerOpts: { now: T0 + 4 * 3600e3 } }],
  ];
  cases.forEach(a => planLines.push({ in: clone(a), out: clone(P.planOpenRouterRoute.apply(null, clone(a))) }));
}
const obsRouteLines = [];
{
  const base = () => ({ m: { current: 'x', lastSwitchAt: T0, upstreams: { x: { a: 6, b: 4, obs: 0, lastAt: 0, fails: 2, latEwma: 0, latN: 0 } } } });
  [[base(), 'm', 'x', { prompt: 1000, hit: 600, completion: 10 }, T0 + 1, { latencyMs: 1500 }],
    [base(), 'm', 'x', { prompt: 0, hit: 5 }, T0 + 2, null], [base(), 'm', 'x', { prompt: 0, hit: 0 }, T0 + 3, null], [base(), 'm', 'x', {}, T0 + 4, { latencyMs: 0 }],
    [base(), 'm', 'y', { prompt: 1000, latencyMs: 700 }, T0 + 5, null], [base(), 'm', 'x', { prompt: 1000, hit: 2000, latencyMs: 700 }, T0 + 6, { latencyMs: 'abc' }],
    [base(), 'm', null, { prompt: 1 }, T0, null], [base(), '', 'x', { prompt: 1 }, T0, null], [null, 'n', 'x', null, T0 + 7, null], [base(), 'm', 'x', { prompt: '1000', hit: '10' }, T0 + 8, null]]
    .forEach(a => obsRouteLines.push({ in: clone(a), out: clone(P.observeRoute.apply(null, clone(a))) }));
}

// ---------------- buildChatRequest：routePrices 分支（Grok Bot 审查 b） ----------------
const routeChatLines = [];
{
  const msgs = [{ role: 'user', content: 'hi' }];
  const rp = P.endpointRoutePrices(EPS);
  const hotMs = () => ({ current: 'together', lastSwitchAt: T0, upstreams: { 'deepinfra/fp8': { a: 30, b: 4, obs: 9, lastAt: T0 - 1000, fails: 0, latEwma: 0, latN: 0 },
    together: { a: 10, b: 20, obs: 9, lastAt: T0 - 1000, fails: 0, latEwma: 0, latN: 0 } } });
  const cases = [
    ['route-prices-cold', prov('openrouter'), { convId: 'c1', routePrices: rp, routerOpts: { now: T0 } }],
    ['route-prices-modelstate', prov('openrouter'), { convId: 'c1', routePrices: rp, routerModelState: hotMs(), prefixTokens: 20000, routerOpts: { now: T0 } }],
    ['route-prices-routeCurrent', prov('openrouter'), { convId: 'c1', routePrices: rp, routerModelState: hotMs(), routeCurrent: 'deepinfra/fp8', prefixTokens: 20000, routerOpts: { now: T0 } }],
    ['route-prices-state+model', prov('openrouter'), { routePrices: rp, routerState: { 'qwen/qwen3': hotMs() }, routerModel: 'qwen/qwen3', prefixTokens: 20000, routerOpts: { now: T0 } }],
    ['route-prices-state-newmodel', prov('openrouter'), { routePrices: rp, routerState: {}, routerModel: 'new/model', routerOpts: { now: T0 } }],
    ['route-prices-none-chosen', prov('openrouter', { orSort: 'price' }), { convId: 'c1', routePrices: [{ slug: 'x', pMiss: 1, ok: false }], routerOpts: { now: T0 } }],
    ['route-prices-affinity-off', prov('openrouter'), { routePrices: rp, cacheAffinity: false, orSort: 'throughput', routerOpts: { now: T0 } }],
    ['route-prices-provider-affinity-off', prov('openrouter', { cacheAffinity: false }), { routePrices: rp, routerOpts: { now: T0 } }],
    ['route-prices-routeSlug-wins', prov('openrouter'), { routePrices: rp, routeSlug: 'pinned', routerOpts: { now: T0 } }],
    ['route-prices-providerOrder-wins', prov('openrouter'), { routePrices: rp, providerOrder: ['first', 'second'], routeSlug: 'pinned', routerOpts: { now: T0 } }],
    ['route-prices-disabled', prov('openrouter'), { routePrices: rp, routerOpts: { enabled: false } }],
    ['route-prices-orGemini', prov('openrouter'), { convId: 'c1', orGemini: true, routePrices: rp, routerOpts: { now: T0 } }],
    ['route-prices-not-openrouter', prov('deepseek'), { routePrices: rp, routerOpts: { now: T0 } }],
  ];
  cases.forEach(([name, p, o]) => {
    const opts = clone(o);
    let chosen = null; opts.onRouteChosen = s => { chosen = s; };
    const r = P.buildChatRequest(p, 'qwen/qwen3', msgs, 'sys', opts);
    routeChatLines.push({ name, in: [p, 'qwen/qwen3', msgs, 'sys', clone(o)], out: { url: r.url, method: r.method, headers: stripAuth(r.headers), body: r.body, chosen, routerState: opts.routerState === undefined ? null : clone(opts.routerState) } });
  });
}

// ---------------- providerMigration（Providers.migrateSettings）/ UsageStats.normalize / PRESETS ----------------
const U = require(path.join(WWW, 'usage-stats.js'));
const presetLines = [{ in: [], out: { PRESETS: P.PRESETS, OLD_DEFAULTS: P.OLD_DEFAULTS, RETIRED: P.RETIRED, SETTINGS_VERSION: P.SETTINGS_VERSION } }];
const oldProv = (presetId, extra) => Object.assign({ id: 'p_' + presetId, presetId, name: (P.OLD_DEFAULTS[presetId] && P.OLD_DEFAULTS[presetId].name) || presetId, type: 'openai',
  baseUrl: (P.OLD_DEFAULTS[presetId] && P.OLD_DEFAULTS[presetId].baseUrl) || 'https://x', models: (P.OLD_DEFAULTS[presetId] || { models: [] }).models.slice(), imageModel: (P.OLD_DEFAULTS[presetId] && P.OLD_DEFAULTS[presetId].imageModel) || '', apiKey: 'sk-keep' }, extra || {});
const migCases = [
  null, {}, { settingsVersion: 2, providers: [oldProv('deepseek')] }, { settingsVersion: '2', providers: [] }, { settingsVersion: 3 },
  { providers: Object.keys(P.OLD_DEFAULTS).map(id => oldProv(id)), lastProviderId: 'p_deepseek', lastModel: 'deepseek-reasoner', theme: 'dark' },
  { settingsVersion: 1, providers: [oldProv('deepseek', { models: ['deepseek-reasoner', 'deepseek-chat', 'my-model', '', 'my-model'], baseUrl: 'https://api.deepseek.com/v1///' }),
    oldProv('moonshot', { models: ['kimi-latest', 'moonshot-v1-8k'], name: 'Moonshot (Kimi)' }), oldProv('moonshot', { id: 'm2', models: ['moonshot-v1-8k', 'kimi-latest', 'moonshot-v1-32k', 'moonshot-v1-128k'] }),
    oldProv('openai', { models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini', ''], imageModel: 'gpt-image-1' }),
    oldProv('openai', { id: 'o2', models: ['gpt-4o'], imageModel: 'dall-e-3' }), oldProv('custom', { models: ['x'] }), { id: 'bare', presetId: 'zhipu' },
    { id: 'p_q', presetId: 'qwen', models: [] }], lastProviderId: 'm2', lastModel: 'kimi-latest' },
  { settingsVersion: 0, providers: [oldProv('deepseek')], lastModel: 'deepseek-chat' },
  { providers: [{ presetId: 'deepseek', models: ['deepseek-chat'] }], lastModel: 'deepseek-chat' },
  { settingsVersion: null, lastProviderId: 'nope', lastModel: 'deepseek-chat', providers: [oldProv('deepseek')] },
];
const migLines = migCases.map(c => { const r = P.migrateSettings(clone(c)); return { in: [c], out: { settings: r.settings, changed: r.changed } }; });
const normCases = [null, {}, { log: 'x', priceMode: 'weird', calib: null, version: 9, extra: 1 }, { prices: { 'qwen-plus': { hit: 0.1, miss: 0.8, out: 2 }, default: { hit: 0, miss: 1, out: 2 } }, priceMode: 'peak', backfilled: true, log: [{ key: 'a' }], calib: { m: { scale: 1.1 } } },
  { prices: null, priceMode: 'offpeak', calib: [] }, { prices: 'ab', calib: 'x' }, { backfilled: null, priceMode: null, calib: 0 }, 'str', 5, false];
const normLines = normCases.map(c => ({ in: [c], out: U.normalize(clone(c)) }));

const files = {
  'localeCompare.jsonl': lcLines,
  'classifyModel.jsonl': clsLines,
  'buildModelsRequest.jsonl': modelsReqLines,
  'buildEndpointsRequest.jsonl': epReqLines,
  'parseModelsResponse.jsonl': modelsLines,
  'parseModelsMeta.jsonl': metaLines,
  'pricingFromRaw.jsonl': pricingLines,
  'floorPricingFromEndpoints.jsonl': floorLines,
  'parseEndpointsResponse.jsonl': epParseLines,
  'endpointLatencyMs.jsonl': latLines,
  'endpointRoutePrices.jsonl': rpLines,
  'mergeFloorPrice.jsonl': mergeLines,
  'syncUsagePricesFromEndpoints.jsonl': syncLines,
  'syncPricesFromProviderMeta.jsonl': syncMetaLines,
  'router.fns.jsonl': routerFnLines,
  'router.chooseUpstream.jsonl': chooseLines,
  'router.panelView.jsonl': panelLines,
  'router.replay.jsonl': replayLines,
  'planOpenRouterRoute.jsonl': planLines,
  'observeRoute.jsonl': obsRouteLines,
  'buildChatRequest.route.jsonl': routeChatLines,
  'presets.jsonl': presetLines,
  'migrateSettings.jsonl': migLines,
  'usageStats.normalize.jsonl': normLines,
};
let diff = 0;
for (const [f, lines] of Object.entries(files)) {
  const text = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  const fp = path.join(OUT, f);
  if (check) {
    const old = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
    if (old !== text) { console.error('DIFF ' + f); diff++; }
  } else { fs.writeFileSync(fp, text); console.log(f + ': ' + lines.length); }
}
if (check) { if (diff) process.exit(1); console.log('golden up to date'); }
