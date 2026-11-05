// MiniMax 提示缓存（plugins/cache/mmcache.js）+ 子目录加载路径
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const WWW = path.join(__dirname, '../app/src/main/assets/www');
const M = require(WWW + '/plugins/cache/mmcache.js');
const G = require(WWW + '/plugins/cache/gcache.js');
const C = require(WWW + '/plugins/cache/cache-common.js');
const OR = { type: 'openai', presetId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' };

test('闸门：仅 OpenRouter + minimax/*', () => {
  assert.ok(M.isOpenRouterMiniMax(OR, 'minimax/minimax-m3.1-flash'));
  assert.ok(M.isOpenRouterMiniMax({ type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }, '~minimax/minimax-m3'));
  assert.ok(!M.isOpenRouterMiniMax(OR, 'google/gemini-2.5-flash'));
  assert.ok(!M.isOpenRouterMiniMax(OR, 'deepseek/deepseek-chat'));
  assert.ok(!M.isOpenRouterMiniMax({ type: 'openai', baseUrl: 'https://api.minimax.io/v1' }, 'minimax/minimax-m3'));
  assert.ok(!M.isOpenRouterMiniMax({ type: 'anthropic', presetId: 'openrouter' }, 'minimax/minimax-m3'));
  assert.ok(!M.isOpenRouterMiniMax(Object.assign({}, OR, { cacheAdapter: 'none' }), 'minimax/minimax-m3'));
  // 与 gcache 互斥
  assert.ok(!G.isOpenRouterGemini(OR, 'minimax/minimax-m3.1-flash'));
  assert.ok(G.isOpenRouterGemini(OR, 'google/gemini-2.5-flash'));
});

test('applyToRequest：稳定 session_id，不发 cache_control，不改 model/provider', () => {
  const sid = M.sessionIdFor('c1');
  assert.strictEqual(sid, M.sessionIdFor('c1'));
  assert.notStrictEqual(sid, M.sessionIdFor('c2'));
  assert.ok(sid.length <= 256);
  const body = { model: 'minimax/minimax-m3.1-flash', provider: { sort: 'price' }, messages: [{ role: 'system', content: 'A' }, { role: 'system', content: 'B' }, { role: 'user', content: 'hi' }] };
  const r = M.applyToRequest({ url: 'u', body: JSON.stringify(body) }, {}, { sessionId: sid });
  const out = JSON.parse(r.req.body);
  assert.strictEqual(out.session_id, sid);
  assert.strictEqual(out.model, body.model);
  assert.deepStrictEqual(out.provider, { sort: 'price' });
  assert.strictEqual(out.messages.length, 2);
  assert.strictEqual(out.messages[0].content, 'A\n\nB');
  assert.ok(!r.req.body.includes('cache_control'));
  assert.strictEqual(M.supportsCacheControl('minimax/minimax-m3.1-flash'), false);
  // 已有 session_id 不覆盖；关闭开关不发送
  assert.strictEqual(JSON.parse(M.applyToRequest({ body: JSON.stringify(Object.assign({}, body, { session_id: 'x' })) }, {}, { sessionId: sid }).req.body).session_id, 'x');
  assert.strictEqual(JSON.parse(M.applyToRequest({ body: JSON.stringify(body) }, { sessionId: false }, { sessionId: sid }).req.body).session_id, undefined);
  // 前缀：tools → system
  const r2 = M.applyToRequest({ body: JSON.stringify(Object.assign({ tools: [{ type: 'function', function: { name: 't' } }] }, body)) }, {}, {});
  assert.ok(r2.prefix.startsWith('[{"type":"function"') && r2.prefix.includes('A\n\nB'));
});

test('价目 / 诊断', () => {
  assert.strictEqual(M.priceFor('minimax/minimax-m3.1-flash').read, 0.1);
  assert.strictEqual(M.priceFor('minimax/minimax-m3').read, 0.2);
  assert.strictEqual(M.priceFor('minimax/minimax-m9').known, false);
  assert.strictEqual(M.MIN_TOKENS, 512);
  const d = M.diagnose({ roll: [{ prompt: 1000, hit: 0, known: true }], requests: 3, prefixChanges: 2, lastPromptEst: 300, session_id: '', routeOrder: true });
  assert.strictEqual(d.level, 'low');
  assert.ok(d.issues.some(x => x.includes('512')) && d.issues.some(x => x.includes('provider.order')) && d.issues.some(x => x.includes('session_id')));
  assert.strictEqual(M.diagnose({ roll: [{ prompt: 1000, hit: 900, known: true }], requests: 1, prefixChanges: 0, session_id: 's' }).level, 'good');
  assert.deepStrictEqual(C.usageInfo({ prompt: 100, hit: 80, cacheSupported: true }), { prompt: 100, hit: 80, write: 0, pct: 80 });
  assert.strictEqual(C.hash('abc'), G.hash('abc'));
});

test('浏览器注册：插件只改 MiniMax 请求，Gemini/其他不受影响', () => {
  const Plugins = require(WWW + '/plugins.js');
  const reg = Plugins.createRegistry();
  const prev = { Plugins: globalThis.Plugins, CacheCommon: globalThis.CacheCommon };
  const vm = require('vm');
  const sandbox = { Plugins: { registry: reg }, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(WWW + '/plugins/cache/cache-common.js', 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(WWW + '/plugins/cache/mmcache.js', 'utf8'), sandbox);
  const pl = reg.get('mmcache'); assert.ok(pl && /MiniMax/.test(pl.name));
  const settings = {}, host = { settings: () => settings };
  const conv = { id: 'cv', plugins: {} };
  const c1 = pl.hooks.onBeforeRequest({ provider: OR, model: 'google/gemini-2.5-flash', opts: {}, conv }, host);
  assert.ok(!c1.opts.orMiniMax);
  const c2 = pl.hooks.onBeforeRequest({ provider: OR, model: 'minimax/minimax-m3.1-flash', opts: {}, conv }, host);
  assert.ok(c2.opts.orMiniMax);
  const body = JSON.stringify({ model: 'minimax/minimax-m3.1-flash', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] });
  assert.strictEqual(pl.transformRequest({ body }, c1).body, body);
  const out = JSON.parse(pl.transformRequest({ body }, c2).body);
  assert.strictEqual(out.session_id, M.sessionIdFor('cv'));
  Object.assign(globalThis, prev);
});

test('子目录加载路径：index.html 引用 plugins/cache/*，根目录不再有 gcache.js', () => {
  const html = fs.readFileSync(WWW + '/index.html', 'utf8');
  const a = html.indexOf('plugins/cache/cache-common.js'), b = html.indexOf('plugins/cache/gcache.js'), c = html.indexOf('plugins/cache/mmcache.js');
  assert.ok(a > 0 && b > a && c > b);
  assert.ok(html.indexOf('src="plugins.js"') < a && html.indexOf('src="rpcache.js"') < b && c < html.indexOf('src="app.js"'));
  assert.ok(!/src="gcache\.js"/.test(html));
  assert.ok(!fs.existsSync(WWW + '/gcache.js'));
  const app = fs.readFileSync(WWW + '/app.js', 'utf8');
  assert.ok(app.includes("Plugins.registry.get('mmcache')") && app.includes("b.plugin === 'mmcache' && b.kind === 'hit'"));
});
