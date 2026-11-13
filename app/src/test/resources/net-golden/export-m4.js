#!/usr/bin/env node
/*
 * 工作流 B · M4 golden 导出器：netretry / search / files 上下文 / cost-core / usage-stats / balance / formatModelPrice / app.js 片段
 * （searchErrorText、toRequestMsg 直接从 app.js 源码抽出函数体执行，不是手抄）。
 * 时区固定 Asia/Shanghai（usage-stats 的 dayKey / rangeOf 用本地日历），所有时间显式给出，随机数来自 mulberry32。
 * 用法：node app/src/test/resources/net-golden/export-m4.js [--check]
 */
'use strict';
process.env.TZ = 'Asia/Shanghai';
const fs = require('fs');
const path = require('path');
const WWW = path.resolve(__dirname, '../../../main/assets/www');
const NR = require(path.join(WWW, 'netretry.js'));
const S = require(path.join(WWW, 'search.js'));
const F = require(path.join(WWW, 'files.js'));
const C = require(path.join(WWW, 'cost-core.js'));
const U = require(path.join(WWW, 'usage-stats.js'));
const B = require(path.join(WWW, 'balance.js'));
const P = require(path.join(WWW, 'providers.js'));
const TU = require(path.join(WWW, 'timeutil.js'));
const OUT = __dirname;
const check = process.argv.includes('--check');
const J = o => o === undefined ? null : JSON.parse(JSON.stringify(o));

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const T0 = 1767225600000; // 2026-01-01T00:00:00Z = 08:00 北京时间（周四）
const APP = fs.readFileSync(path.join(WWW, 'app.js'), 'utf8');
/** 从 app.js 抽出 `function name(...) {...}` 的源码（按花括号配对，跳过字符串 / 正则里的括号足够用于这几个函数） */
function extractFn(name) {
  const i = APP.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('app.js 没有 ' + name);
  let j = APP.indexOf('{', i), depth = 0, k = j, q = null;
  for (; k < APP.length; k++) {
    const ch = APP[k];
    if (q) { if (ch === '\\') { k++; continue; } if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  return APP.slice(i, k + 1);
}
const searchErrorText = new Function(extractFn('searchErrorText') + '; return searchErrorText;')();
const toRequestMsgAt = today => new Function('Files', 'Search', 'TimeUtil',
  extractFn('toRequestMsg') + '; return toRequestMsg;')(F, S, { localDateStr: () => today });

// ---------------- netretry ----------------
const nrLines = [];
{
  const statuses = [0, 200, 400, 401, 402, 403, 404, 408, 409, 413, 422, 425, 429, 500, 501, 502, 503, 504, 520, 522, 524, 529, 599, '503', null];
  const raws = ['', 'upstream timeout', 'context_length_exceeded: maximum context', 'Insufficient Balance', '余额不足', 'too many tokens in request',
    'context window exceeded', 'Request aborted', null];
  const errs = [null, 'SocketTimeoutException: timeout', 'Read timed out', 'ConnectException: Failed to connect', 'Canceled', '已取消', '请求超时'];
  statuses.forEach(s => raws.forEach(r => errs.forEach(e => {
    nrLines.push({ name: 'classify', in: [s, r, e], out: NR.classify(s, r, e == null ? null : { message: e }) });
  })));
  [0, 1, 2, 3, 4, 5, 10, -1, 1.7].forEach(a => ['rate_limit', 'server', 'network', 'timeout'].forEach(k => [0, 0.5, 0.999, 0.123456].forEach(r =>
    nrLines.push({ name: 'backoff', in: [a, k, r], out: NR.backoff(a, k, r) }))));
  const cs = [{ retry: true }, { retry: false }, null];
  cs.forEach(c => [0, 1, 2, 3].forEach(a => [false, true].forEach(g => [false, true].forEach(st =>
    nrLines.push({ name: 'shouldRetry', in: [c, a, g, st], out: NR.shouldRetry(c, a, g, st) })))));
}

// ---------------- search ----------------
const searchReqLines = [];
{
  const qs = ['今天 北京 天气', '  hello world  ', 'a&b=c?d#e/f', 'x'.repeat(500), '😀 emoji 测试', ''];
  const cfgs = [
    { provider: 'tavily', apiKey: '', count: 5 }, { provider: 'tavily', apiKey: ' k ', count: '12', baseUrl: 'https://proxy.example.com/' },
    { provider: 'bocha', count: 0 }, { provider: 'bocha', count: 'abc', baseUrl: '' },
    { provider: 'brave', count: 3 }, { provider: 'brave', count: -4, baseUrl: 'https://b.example.com//' },
    { provider: 'searxng', baseUrl: 'https://sx.example.com/', count: 8 }, { provider: 'searxng', baseUrl: 'https://sx.example.com', apiKey: 'tok', count: 2.9 },
    { provider: 'searxng', baseUrl: '  ', count: 5 }, { provider: 'google', count: 5 },
  ];
  cfgs.forEach(c => qs.forEach(q => {
    let out; try { const r = S.buildSearchRequest(c, q); out = { url: r.url, method: r.method, headers: r.headers, body: r.body == null ? null : r.body }; }
    catch (e) { out = { error: e.message }; }
    searchReqLines.push({ in: [c, q], out });
  }));
}
const searchParseLines = [];
{
  const html = '<b>粗体</b>  多  空格\n换行';
  const long = '长'.repeat(1500);
  const tav = JSON.stringify({ results: [
    { title: 'T1', url: 'https://www.a.com/x', content: html, published_date: '2026-10-01T12:00:00Z' },
    { title: '', url: 'https://b.com', raw_content: 'raw only' },
    { title: 'dup', url: 'https://www.a.com/x', content: 'dup' },
    { title: 'ftp', url: 'ftp://c.com', content: 'no' },
    { title: 'nourl', content: 'no' },
    { title: 'long', url: 'http://d.com/p?q=1', content: long },
    null,
  ] });
  const tavOk = JSON.stringify({ results: JSON.parse(tav).results.filter(Boolean) });
  const bocha = JSON.stringify({ code: 200, data: { webPages: { value: [
    { name: '博查1', url: 'https://bocha.cn/1', snippet: 's', summary: '摘要', siteName: '<i>站点</i>', datePublished: '2026-09-09T01:02:03+08:00' },
    { name: '博查2', url: 'https://bocha.cn/2', snippet: '片段', dateLastCrawled: '2026-08-08' },
  ] } } });
  const bochaErr = JSON.stringify({ code: 403, msg: '余额不足' });
  const bochaErr2 = JSON.stringify({ code: 500 });
  const bochaTop = JSON.stringify({ webPages: { value: [{ name: 'top', url: 'https://t.com' }] } });
  const brave = JSON.stringify({ web: { results: [
    { title: 'B1', url: 'https://brave.com/1', description: 'desc', extra_snippets: ['e1', '', 'e2'], page_age: '2026-07-07T00:00:00' },
    { title: 'B2', url: 'https://brave.com/2', age: 'August 1, 2026' },
  ] } });
  const sx = JSON.stringify({ results: Array.from({ length: 15 }, (_, i) => ({ title: 'S' + i, url: 'https://sx.com/' + (i % 12), content: 'c' + i, publishedDate: i % 2 ? '2026-01-0' + (i % 9 + 1) : null })) });
  const cases = [['tavily', tav, 5], ['tavily', tavOk, 5], ['tavily', tavOk, undefined], ['tavily', tavOk, '2'], ['bocha', bocha, 3], ['bocha', bochaErr, 3], ['bocha', bochaErr2, 3], ['bocha', bochaTop, 3],
    ['brave', brave, 10], ['searxng', sx, 5], ['searxng', sx, 0], ['searxng', sx, undefined], ['searxng', '{}', 5], ['tavily', 'not json', 5],
    ['unknown', tav, 5], ['tavily', '{"results":null}', 5]];
  cases.forEach(([p, t, n]) => {
    let out; try { out = S.parseSearchResponse(p, t, n); } catch (e) { out = { error: e instanceof SyntaxError ? 'SyntaxError' : e instanceof TypeError ? 'TypeError' : e.message }; }
    searchParseLines.push({ in: [p, t, n === undefined ? null : n], out });
  });
}
const searchCtxLines = [];
{
  const rs = [
    { title: 'A', url: 'https://a.com', content: 'x'.repeat(3000), date: '2026-10-01' },
    { title: 'B', url: 'https://b.com', content: 'y'.repeat(2950), date: '' },
    { title: 'C', url: 'https://c.com', content: 'z'.repeat(100) },
    { title: 'D', url: 'https://d.com', content: '' },
    { title: 'E', url: 'https://e.com' },
  ];
  [[rs, '问题', {}], [rs, '问题', { maxChars: 3100 }], [rs, '', { maxChars: 100 }], [rs.slice(2), 'q', { maxChars: 80 }], [rs.slice(2), 'q', { maxChars: 81 }], [[], '空', {}]]
    .forEach(([r, q, o]) => searchCtxLines.push({ in: [r, q, Object.assign({ today: '2026-11-13' }, o)], out: S.buildSearchContext(r, q, Object.assign({ today: '2026-11-13' }, o)) }));
}
const rewriteLines = [];
{
  const hist = [{ role: 'user', content: '第一问' }, { role: 'assistant', content: '答'.repeat(400) }, { role: 'user', content: '二' }, { role: 'assistant', content: null },
    { role: 'system', content: 'sys' }, { role: 'user', content: '最后' }];
  [['今天天气', hist], ['q', []], ['q', null], ['x', hist.slice(0, 2)]].forEach(([q, h]) => rewriteLines.push({ name: 'prompt', in: [q, h], out: S.buildRewritePrompt(q, h) }));
  ['北京 天气', '  \n 查询词：北京天气 \n多余', 'Query: "abc"', '「上海」', '“深圳”', '', null, 'x'.repeat(121), 'x'.repeat(120), '搜索词 : 杭州', '""'].forEach(t =>
    rewriteLines.push({ name: 'clean', in: [t, 'FB'], out: S.cleanRewrite(t, 'FB') }));
  ['https://www.a.com/x', 'http://b.com:8080?q', 'HTTPS://WWW.C.COM', 'ftp://x', '', null, 'https://'].forEach(u => rewriteLines.push({ name: 'host', in: [u], out: S.hostOf(u) }));
}
const searchErrLines = [];
[[401, '{"detail":{"error":"Unauthorized: missing key"}}'], [403, '{"error":"forbidden"}'], [429, '{"message":"rate"}'], [432, '{"msg":"plan"}'],
  [402, '{"error":{"message":"pay"}}'], [500, '<html><body><h1>Internal</h1>  Server   Error</body></html>'], [0, ''], [418, '{"detail":"teapot"}'],
  [400, '{"detail":{"detail":{"message":"nested"}}}'], [400, '{"error":{"code":1}}'], [400, '{"a":1}'], [502, 'x'.repeat(300)], [400, '"str"'], [400, 'null'], [400, '[1,2]'],
  [400, '{"detail":' + JSON.stringify('d'.repeat(250)) + '}']]
  .forEach(([s, t]) => { let out; try { out = searchErrorText(s, t); } catch (e) { out = { error: e.constructor.name }; } searchErrLines.push({ in: [s, t], out }); });

// ---------------- files ----------------
const fileLines = [];
{
  const f = (name, text, extra) => Object.assign({ name, text }, extra || {});
  const cases = [
    [[f('a.txt', 'hello', { total: 5 })], '问题'],
    [[f('a.pdf', 'p'.repeat(10), { pages: 3, total: 10 }), f('b.docx', '', { total: 0 }), f('c.md', 'md', { truncated: true, total: 99999 })], ''],
    [[f('big.txt', 'x'.repeat(50000), { total: 50000 }), f('big2.txt', 'y'.repeat(50000), { total: 70000, truncated: true }), f('big3.txt', 'z', { total: 1 })], 'q', {}],
    [[f('a.txt', 'abc', { total: 3 }), f('b.txt', 'defg', { total: 4 })], 'q', { totalMax: 5 }],
    [[], 'only question'], [[f('n', '')], ''], [[null, f('ok', 't', { pages: 0, total: 0 })], 'q'],
  ];
  cases.forEach(([fs_, q, o]) => fileLines.push({ name: 'buildFileContext', in: [fs_, q, o || null], out: F.buildFileContext(fs_, q, o) }));
  [['abc', 5], ['abcdef', 3], ['', 1], [null, 2], ['四个汉字', 2]].forEach(([t, m]) => fileLines.push({ name: 'capText', in: [t, m], out: F.capText(t, m) }));
  // toRequestMsg（app.js）：文件展开 + 扫描版提示 + 搜索注入
  const trm = toRequestMsgAt('2026-11-13');
  const res = [{ title: 'R', url: 'https://r.com', content: 'rc', date: '2026-11-12' }];
  const msgs = [
    { role: 'user', content: '看看', files: [f('a.txt', 'AAA', { total: 3 }), { name: 'scan.pdf', text: '', scanned: true, pages: 2 }], images: ['data:x'] },
    { role: 'user', content: '', files: [{ name: 's1.pdf', text: '', scanned: true }, { name: 's2.pdf', scanned: true }] },
    { role: 'user', content: '', files: [{ name: 'e.txt', text: '' }] },
    { role: 'user', content: '搜', search: { query: 'q', results: res } },
    { role: 'user', content: '搜', search: { query: 'q', results: [] } },
    { role: 'user', content: '双', files: [f('d.txt', 'D', { total: 1 })], search: { query: 'q', results: res } },
    { role: 'assistant', content: '答', files: [f('x.txt', 'X')], search: { results: res } },
    { role: 'user' },
  ];
  msgs.forEach(m => [true, false].forEach(inj => fileLines.push({ name: 'toRequestMsg', in: [m, inj, '2026-11-13'], out: J(trm(m, inj)) })));
}

// ---------------- cost-core ----------------
const costLines = [];
{
  const models = ['deepseek-chat', 'deepseek-flash', 'DeepSeek-V4-Pro', 'deepseek-reasoner-pro', 'qwen3.8-max', 'qwen3.7-max-preview', 'qwen-plus', 'qwen-turbo', 'Qwen/Qwen3-VL-Plus',
    'qwen3-coder-flash', 'gemini-2.5-flash-lite', 'google/gemini-2.5-flash-lite-preview', 'gpt-4o', 'my-custom', '', null, 'character-x', 'openai/gpt-4o-mini'];
  const priceBags = [null, U.DEFAULT_PRICES,
    Object.assign({}, U.DEFAULT_PRICES, { 'gpt-4o': { hit: 1.25, miss: 2.5, out: 10 }, mine: { miss: 1, out: 2, match: 'custom，my-custom foo' } }),
    { 'openai/gpt-4o-mini': { hit: 0.075, miss: 0.15, out: 0.6, source: 'openrouter-floor' }, bad: { miss: 'x', out: null, match: '' } },
    { default: { hit: 0, miss: 2, out: 4 } }, {}];
  models.forEach(m => priceBags.forEach((pb, bi) => {
    costLines.push({ name: 'priceFor', in: [m, bi], out: J(C.priceFor(m, pb)) });
    costLines.push({ name: 'priceForUsage', in: [m, bi], out: J(C.priceForUsage(m, pb)) });
  }));
  costLines.push({ name: 'bags', in: [], out: J(priceBags) });
  costLines.push({ name: 'BUILTIN', in: [], out: J(C.BUILTIN_PRICES) });
  ['09:00-12:00,14:00-18:00', '9-12', '0930-1130；', '23:00-24:00, 22:00-21:00', '00:00-25:00', '', null, '8:30-9:45 13-14', 'abc'].forEach(w =>
    costLines.push({ name: 'parseWindows', in: [w], out: C.parseWindows(w) }));
  const peaks = [null, { windows: '00:00-24:00', weekdays: false }, { tz: 0 }, { tz: '9', off_factor: 0.25 }, { off_factor: 'x' }, { windows: '', weekdays: true }];
  const rnd = mulberry32(42);
  for (let i = 0; i < 80; i++) {
    const at = T0 + Math.floor(rnd() * 14 * 864e5);
    const pk = peaks[i % peaks.length];
    ['auto', 'peak', 'offpeak'].forEach(mode => costLines.push({ name: 'peak', in: [at, mode, pk], out: { isPeak: C.isPeak(at, pk), factor: C.peakFactor(at, mode, pk) } }));
  }
  [[{ hit: 0.1, miss: 1, out: 2, hit_explicit: 0.05, write: 1.25, match: 'x' }, 0.5], [{ miss: 1 }, 1], [{ miss: 1 }, 0], [{ miss: 1 }, -1], [null, 2],
    [{ hit: null, miss: 0.123456789, out: 3 }, 1.1]].forEach(([p, s]) => costLines.push({ name: 'scalePrice', in: [p, s], out: J(C.scalePrice(p, s)) }));
  const calib = { 'deepseek-chat': { scale: 0.8 }, 'gpt-4o': { scale: 0 }, 'qwen-plus': { scale: 1.3 } };
  ['deepseek-chat', 'gpt-4o', 'qwen-plus', 'x', null].forEach(m => {
    costLines.push({ name: 'priceForCalibrated', in: [m, 2, calib], out: J(C.priceForCalibrated(m, priceBags[2], calib)) });
    costLines.push({ name: 'calibScale', in: [m, calib], out: C.calibScale(calib, m) });
  });
  // costOf / costOfEntry
  for (let i = 0; i < 120; i++) {
    const m = models[(rnd() * models.length) | 0];
    const at = T0 + Math.floor(rnd() * 7 * 864e5);
    const prompt = (rnd() * 20000) | 0, hit = (rnd() * prompt) | 0;
    const e = { model: m, at, prompt, completion: (rnd() * 4000) | 0, hit, miss: prompt - hit, cache: rnd() < 0.6 };
    if (rnd() < 0.2) e.write = (rnd() * 500) | 0;
    if (rnd() < 0.2) e.cacheMode = rnd() < 0.5 ? 'explicit' : 'implicit';
    const bi = (rnd() * priceBags.length) | 0, mode = ['auto', 'peak', 'offpeak', undefined][(rnd() * 4) | 0], pk = peaks[(rnd() * peaks.length) | 0];
    const cal = rnd() < 0.3 ? calib : null;
    costLines.push({ name: 'costOfEntry', in: [e, bi, mode == null ? null : mode, pk, cal], out: C.costOfEntry(e, priceBags[bi], mode, pk, cal) });
    const r = { model: m, supported: rnd() < 0.9, timestamp: at, prompt_tokens: prompt, cache_hit_tokens: hit, cache_miss_tokens: prompt - hit,
      completion_tokens: e.completion, cache_mode: e.cacheMode, cache_write_tokens: e.write };
    costLines.push({ name: 'costOf', in: [J(r), bi, mode == null ? null : mode, pk, cal], out: J(C.costOf(r, priceBags[bi], mode, pk, cal)) });
  }
  costLines.push({ name: 'costOfEntry', in: [null, 1, 'auto', null, null], out: C.costOfEntry(null, priceBags[1], 'auto', null, null) });
  // reconcile 序列
  for (let s = 0; s < 6; s++) {
    const r2 = mulberry32(100 + s);
    let cal = s % 2 ? { 'deepseek-chat': { scale: 1.1, biasEwma: 0.2, streak: 2, distorted: false, n: 4 } } : {};
    const steps = [];
    for (let i = 0; i < 12; i++) {
      const model = ['deepseek-chat', 'gpt-4o', ''][(r2() * 3) | 0];
      const est = r2() < 0.1 ? 0 : r2() * 0.01, act = r2() < 0.1 ? -1 : est * (0.5 + r2() * 1.2);
      const opts = s === 5 ? { alpha: 0.5, threshold: 0.1, streakMark: 2, now: T0 + i } : { now: T0 + i };
      cal = C.reconcile(cal, model, est, act, opts);
      steps.push({ model, est, act, opts, calib: J(cal) });
    }
    costLines.push({ name: 'reconcile', in: [s % 2 ? { 'deepseek-chat': { scale: 1.1, biasEwma: 0.2, streak: 2, distorted: false, n: 4 } } : {}], out: steps });
    costLines.push({ name: 'calibView', in: [J(cal)], out: J(Object.keys(cal).map(m => C.calibView(cal, m)).concat([C.calibView(cal, 'none'), C.calibView(null, 'x')])) });
    costLines.push({ name: 'distortedModels', in: [J(cal)], out: J(C.distortedModels(cal)) });
  }
}

// ---------------- usage-stats ----------------
const usageLines = [];
{
  const us = [
    { prompt: 1000, completion: 200, hit: 600, miss: 400, cacheSupported: true, source: 'deepseek' },
    { prompt: 1000, completion: 200, hit: 600, cacheSupported: true },
    { prompt: 500.7, completion: 3.2, cacheSupported: false, cost: 0.0123 },
    { prompt: 10, completion: 0, hit: 20, cacheSupported: true, cost: 'x' },
    { prompt: 0, completion: 5, cost: Infinity },
    {}, null,
  ];
  us.forEach((u, i) => {
    const o = { usage: u, at: T0 + i * 1000, type: i % 3 ? 'chat' : undefined, model: 'm' + i, providerId: 'deepseek', providerName: 'DS',
      convId: 'c' + i, convTitle: 't' + i, msgId: i % 2 ? 'msg' + i : undefined, id: 'u_fixed' + i, actualCost: i === 4 ? 0.5 : undefined };
    if (i === 5) o.key = 'k-custom';
    usageLines.push({ name: 'makeEntry', in: [J(o)], out: U.makeEntry(o) });
  });
  // 无 id：只比对除 id 外的字段
  usageLines.push({ name: 'makeEntryNoId', in: [{ usage: us[0], at: T0, model: 'x' }], out: (e => { delete e.id; return e; })(U.makeEntry({ usage: us[0], at: T0, model: 'x' })) });
  // 日志与统计
  const rnd = mulberry32(9);
  const models = ['deepseek-chat', 'deepseek-v4-pro', 'qwen-plus', 'gpt-4o', 'gemini-2.5-flash-lite', ''];
  const log = [];
  for (let i = 0; i < 160; i++) {
    const prompt = (rnd() * 9000) | 0, hit = (rnd() * prompt) | 0;
    log.push(U.makeEntry({ id: 'u' + i, usage: { prompt, completion: (rnd() * 3000) | 0, hit, cacheSupported: rnd() < 0.7, cost: rnd() < 0.3 ? rnd() * 0.01 : undefined },
      at: T0 - 20 * 864e5 + Math.floor(rnd() * 40 * 864e5), type: ['chat', 'chat', 'image', 'summary', 'extract'][(rnd() * 5) | 0], model: models[(rnd() * models.length) | 0],
      providerId: ['deepseek', 'qwen', ''][(rnd() * 3) | 0], providerName: rnd() < 0.5 ? 'P' : '', convId: 'c' + ((rnd() * 5) | 0), convTitle: 'T"' + ((rnd() * 5) | 0), msgId: 'm' + i }));
  }
  usageLines.push({ name: 'log', in: [], out: log });
  const now = T0 + 10 * 864e5 + 3600e3 * 15;
  ['today', '7d', '30d', 'all', 'custom', 'weird'].forEach(p => {
    const r = U.rangeOf(p, now, { from: T0 - 3 * 864e5, to: T0 + 2 * 864e5 });
    usageLines.push({ name: 'rangeOf', in: [p, now, { from: T0 - 3 * 864e5, to: T0 + 2 * 864e5 }], out: r });
    usageLines.push({ name: 'filterSum', in: [r], out: U.sumList(U.filterLog(log, r)) });
  });
  usageLines.push({ name: 'filterSum', in: [null], out: U.sumList(U.filterLog(log, null)) });
  [T0, T0 - 1, T0 + 16 * 3600e3 - 1, T0 + 16 * 3600e3, 0, 1e12].forEach(at => usageLines.push({ name: 'dayKey', in: [at, null], out: { day: U.dayKey(at), month: U.monthKey(at), off0: U.dayKey(at, 0), offNeg: U.dayKey(at, -300) } }));
  [['model', e => e.model], ['providerName', e => e.providerName || e.providerId], ['type', e => e.type], ['convTitle', e => e.convTitle]].forEach(([k, fn]) =>
    usageLines.push({ name: 'groupBy', in: [k], out: U.groupBy(log, fn).map(g => Object.assign({}, g, { items: g.items.map(e => e.id) })) }));
  [[30, now], [7, now], [1, T0], [undefined, now], [3, T0 + 864e5 - 1]].forEach(([d, n]) => usageLines.push({ name: 'byDay', in: [d == null ? null : d, n], out: U.byDay(log, d, n) }));
  const pb = [null, U.DEFAULT_PRICES, Object.assign({}, U.DEFAULT_PRICES, { 'gpt-4o': { hit: 1.25, miss: 2.5, out: 10 } })];
  const cal = { 'deepseek-chat': { scale: 0.7 } };
  pb.forEach((p, bi) => ['auto', 'peak', 'offpeak'].forEach(mode => [null, cal].forEach(c =>
    usageLines.push({ name: 'estimateCost', in: [bi, mode, c], out: U.estimateCost(log, p, mode, null, c) }))));
  usageLines.push({ name: 'priceBags', in: [], out: J(pb) });
  usageLines.push({ name: 'buckets', in: [], out: U.buckets(log) });
  usageLines.push({ name: 'toCSV', in: [log.slice(0, 12)], out: U.toCSV(log.slice(0, 12)) });
  // record / clear / reconcileEntry
  let st = U.normalize({ log: log.slice(0, 3), prices: { x: { miss: 1, out: 1 } }, priceMode: 'peak' });
  const rec = [];
  [log[3], log[0], Object.assign({}, log[4], { prompt: undefined }), null, log[5]].forEach(e => { st = U.record(st, e); rec.push(st.log.map(x => x.key)); });
  usageLines.push({ name: 'record', in: [], out: { keys: rec, state: (s => { const o = Object.assign({}, s); delete o.log; return o; })(st) } });
  usageLines.push({ name: 'recordLimit', in: [], out: (() => { let s = U.normalize({ log: Array.from({ length: U.LOG_LIMIT }, (_, i) => ({ key: 'k' + i, prompt: 1 })) }); s = U.record(s, { key: 'new', prompt: 2 }); return { n: s.log.length, first: s.log[0].key, last: s.log[s.log.length - 1].key }; })() });
  usageLines.push({ name: 'clear', in: [], out: (s => { const o = Object.assign({}, s); return o; })(U.clear({ log: log.slice(0, 2), backfilled: false })) });
  {
    let s = U.normalize(null);
    const steps = [];
    log.slice(0, 40).forEach((e, i) => {
      const mode = i % 3 === 0 ? 'peak' : undefined;
      s = U.reconcileEntry(s, e, mode, i % 5 === 0 ? { tz: 0 } : undefined);
      steps.push(J(s.calib));
    });
    usageLines.push({ name: 'reconcileEntry', in: [40], out: steps });
  }
  // collectFromMessages / backfill（makeEntry 无 id → 去掉 id 比对）
  const noId = list => list.map(e => { const o = Object.assign({}, e); delete o.id; return o; });
  const msgs = [
    { id: 'a1', role: 'assistant', createdAt: T0 + 5, model: 'deepseek-chat', usage: { prompt: 100, completion: 20, hit: 50, cacheSupported: true } },
    { id: 'a2', role: 'assistant', usage: { prompt: 10 }, pending: true },
    { id: 'a3', role: 'assistant', usage: { prompt: 10 }, error: 'x' },
    { id: 'a4', role: 'assistant', usage: { completion: 3 } },
    { id: 'a5', role: 'assistant', imageGen: true, model: 'wanx · 生成图片', usage: { prompt: 0, completion: 0 }, createdAt: T0 + 9 },
    { id: 'a6', role: 'assistant', usage: { prompt: 7, completion: 1 }, versions: [{ content: 'old', model: 'v-old', createdAt: T0 + 1, usage: { prompt: 70, completion: 10 },
      tail: [{ id: 'u9', role: 'user' }, { id: 'a9', role: 'assistant', createdAt: T0 + 2, usage: { prompt: 90, completion: 9, cost: 0.01 } }] }, null] },
    { id: 'a1', role: 'assistant', createdAt: T0 + 5, model: 'deepseek-chat', usage: { prompt: 100, completion: 20 } },
  ];
  const meta = { convId: 'c1', convTitle: 'T', providerId: 'deepseek', providerName: 'DS', model: 'conv-model', updatedAt: T0 + 100 };
  usageLines.push({ name: 'collectFromMessages', in: [msgs, meta], out: noId(U.collectFromMessages(msgs, meta)) });
  const convs = [{ id: 'c1', title: 'T', providerId: 'deepseek', providerName: 'DS', model: 'cm', updatedAt: T0 + 100, messages: msgs },
    { id: 'c2', title: 'T2', providerId: 'qwen', model: 'qwen-plus', updatedAt: T0, messages: [{ id: 'b1', role: 'assistant', usage: { prompt: 5, completion: 5 } }] }];
  const bf = U.backfill({ log: [log[0]] }, convs);
  usageLines.push({ name: 'backfill', in: [convs, [log[0]]], out: Object.assign({}, bf, { log: noId(bf.log) }) });
  usageLines.push({ name: 'backfillDone', in: [], out: U.backfill({ backfilled: true, log: [] }, convs).log.length });
}

// ---------------- balance ----------------
const balLines = [];
{
  ['deepseek', 'siliconflow', 'moonshot', 'openrouter', 'openai', 'custom', '', null, 'xiaomi'].forEach(id => balLines.push({ name: 'supportInfo', in: [id], out: B.supportInfo(id) }));
  const provs = [
    { presetId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', hasKey: true }, { presetId: 'deepseek', baseUrl: 'https://proxy.example.com/v1/', hasKey: true },
    { presetId: 'deepseek', baseUrl: '', hasKey: true }, { presetId: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1/', hasKey: true },
    { presetId: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', hasKey: true }, { presetId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', hasKey: true },
    { presetId: 'openai', baseUrl: 'https://api.openai.com/v1', hasKey: true }, { presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', hasKey: false },
    { presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: '  ' }, null,
  ];
  provs.forEach(p => balLines.push({ name: 'buildBalanceRequest', in: [p], out: J(B.buildBalanceRequest(p)) }));
  [[null, ''], ['', 'CNY'], [0, 'CNY'], [0.12345, 'USD'], [1.005, '¥'], [123.456, '$'], [-5.5, 'EUR'], ['12.3', ''], ['abc', 'USD'], [1e21, 'USD'], [99.995, 'CNY'], [0.00005, '']]
    .forEach(([n, c]) => balLines.push({ name: 'money', in: [n, c], out: B.money(n, c) }));
  const R = [
    ['deepseek', 200, JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }, { currency: 'USD', total_balance: '1.5' }] })],
    ['deepseek', 200, JSON.stringify({ balance_infos: [] })], ['deepseek', 200, JSON.stringify({ is_available: false, balance_infos: [{ total_balance: 3 }] })],
    ['siliconflow', 200, JSON.stringify({ code: 20000, data: { balance: '0.88', chargeBalance: '10', totalBalance: '10.88', status: 'normal' } })],
    ['siliconflow', 200, JSON.stringify({ balance: 5 })], ['siliconflow', 200, JSON.stringify({ data: {} })],
    ['moonshot', 200, JSON.stringify({ code: 0, data: { available_balance: 49.58, voucher_balance: 46.58, cash_balance: 3 } })], ['moonshot', 200, JSON.stringify({ data: {} })],
    ['moonshot', 200, JSON.stringify({ data: { available_balance: 0 } })],
    ['openrouter', 200, JSON.stringify({ data: { label: 'k', limit: null, limit_remaining: null, usage: 1.23, usage_daily: 0.1, usage_monthly: 1, is_free_tier: false } })],
    ['openrouter', 200, JSON.stringify({ data: { limit: 10, limit_remaining: 8.7654, usage: 1.2346 } })], ['openrouter', 200, JSON.stringify({ data: {} })],
    ['openrouter', 200, JSON.stringify({ usage: 0 })],
    ['deepseek', 401, '{"error":{"message":"bad"}}'], ['deepseek', 404, ''], ['moonshot', 429, ''], ['moonshot', 0, ''], ['siliconflow', 500, '{"error":{"message":"boom"}}'],
    ['siliconflow', 500, '{"message":"m"}'], ['siliconflow', 500, '{"error":{"code":5}}'], ['siliconflow', 503, 'not json at all ' + 'x'.repeat(100)], ['openrouter', 502, '{}'],
    ['openai', 200, '{}'], ['deepseek', 200, 'not json'], ['deepseek', 200, ''], ['deepseek', 200, 'null'], ['siliconflow', 200, '[]'],
  ];
  R.forEach(([id, s, t]) => balLines.push({ name: 'parseBalanceResponse', in: [id, s, t], out: J(B.parseBalanceResponse(id, s, t)) }));
}

// ---------------- formatModelPrice / formatContext ----------------
const fmtLines = [];
{
  const metas = [null, {}, { price: { prompt: 0.5, completion: 3 } }, { price: { prompt: 0, completion: 3 } }, { price: { prompt: 0.15, completion: 0 } },
    { price: { prompt: 150, completion: 600.5 } }, { price: { prompt: 0.001234, completion: 0.00995 } }, { price: { imageOut: 40 } }, { price: { image: 0.04 } },
    { price: { prompt: 1, image: 0.04 } }, { price: { imageOut: 30, image: 0.02 } }, { priceFloor: { prompt: 0.1, completion: 0.2 }, price: { prompt: 1, completion: 2 } },
    { price: { prompt: 0.3, completion: 1 }, priceIsFloor: true }, { price: {} }, { price: { prompt: 0.0049999, completion: 99.995 } }, { price: { prompt: 100, completion: 0.01 } },
    { price: { prompt: 1e-9, completion: 2.5e-7 } }];
  metas.forEach(m => fmtLines.push({ name: 'formatModelPrice', in: [m], out: P.formatModelPrice(m) }));
  [0, 1, 999, 1000, 1499, 1500, 128000, 999999, 1000000, 1048576, 2000000, 1250000, 1e9, 32768].forEach(n => fmtLines.push({ name: 'formatContext', in: [n], out: P.formatContext(n) }));
}

const files = {
  'netretry.jsonl': nrLines,
  'search.request.jsonl': searchReqLines,
  'search.parse.jsonl': searchParseLines,
  'search.context.jsonl': searchCtxLines,
  'search.rewrite.jsonl': rewriteLines,
  'search.errorText.jsonl': searchErrLines,
  'files.context.jsonl': fileLines,
  'costCore.jsonl': costLines,
  'usageStats.jsonl': usageLines,
  'balance.jsonl': balLines,
  'formatModelPrice.jsonl': fmtLines,
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
