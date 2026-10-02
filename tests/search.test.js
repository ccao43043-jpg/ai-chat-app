// 联网搜索：请求格式、结果解析与上下文注入
const test = require('node:test');
const assert = require('assert');
const S = require('../app/src/main/assets/www/search.js');

test('Tavily 请求格式：POST /search + Bearer + max_results', () => {
  const r = S.buildSearchRequest({ provider: 'tavily', apiKey: ' tvly-abc ', count: 6 }, '  上海天气  ');
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.url, 'https://api.tavily.com/search');
  assert.strictEqual(r.headers.Authorization, 'Bearer tvly-abc');
  assert.strictEqual(r.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(r.body), { query: '上海天气', max_results: 6, search_depth: 'basic', include_answer: false });
});

test('博查请求格式：POST /v1/web-search + summary + count', () => {
  const r = S.buildSearchRequest({ provider: 'bocha', apiKey: 'sk-b', count: 3 }, '阿里巴巴 ESG 报告');
  assert.strictEqual(r.url, 'https://api.bochaai.com/v1/web-search');
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.headers.Authorization, 'Bearer sk-b');
  assert.deepStrictEqual(JSON.parse(r.body), { query: '阿里巴巴 ESG 报告', freshness: 'noLimit', summary: true, count: 3 });
});

test('Brave 与 SearXNG：GET + 查询参数；自定义地址；条数限制 1–10', () => {
  const b = S.buildSearchRequest({ provider: 'brave', apiKey: 'BSAx', count: 50 }, 'a b&c');
  assert.strictEqual(b.method, 'GET');
  assert.strictEqual(b.url, 'https://api.search.brave.com/res/v1/web/search?q=a%20b%26c&count=10');
  assert.strictEqual(b.headers['X-Subscription-Token'], 'BSAx');
  assert.strictEqual(b.body, undefined);
  const x = S.buildSearchRequest({ provider: 'searxng', baseUrl: 'https://searx.example.com/', count: 0 }, '天气');
  assert.strictEqual(x.url, 'https://searx.example.com/search?q=%E5%A4%A9%E6%B0%94&format=json');
  assert.strictEqual(x.headers.Authorization, undefined);
  assert.throws(() => S.buildSearchRequest({ provider: 'searxng', baseUrl: '' }, 'q'), /实例地址/);
  const t = S.buildSearchRequest({ provider: 'tavily', apiKey: 'k', baseUrl: 'https://proxy.example.com/tavily/' }, 'q');
  assert.strictEqual(t.url, 'https://proxy.example.com/tavily/search');
});

test('解析 Tavily / 博查 / Brave / SearXNG 响应', () => {
  const tav = S.parseSearchResponse('tavily', JSON.stringify({ results: [
    { title: 'A <b>title</b>', url: 'https://www.a.com/x', content: 'aaa', published_date: '2026-09-30T10:00:00Z' },
    { title: 'dup', url: 'https://www.a.com/x', content: 'dup' },
    { title: 'bad', url: 'javascript:alert(1)', content: 'x' },
  ] }), 5);
  assert.deepStrictEqual(tav, [{ title: 'A title', url: 'https://www.a.com/x', content: 'aaa', site: 'a.com', date: '2026-09-30' }]);

  const bochaBody = { code: 200, msg: null, data: { _type: 'SearchResponse', webPages: { value: [
    { name: '博查结果', url: 'https://b.cn/1', snippet: '短摘要', summary: '较长的文本摘要', siteName: '博查网', datePublished: '2026-09-01T08:00:00+08:00' },
    { name: '第二条', url: 'https://b.cn/2', snippet: '只有 snippet' },
  ] } } };
  const bo = S.parseSearchResponse('bocha', JSON.stringify(bochaBody), 5);
  assert.strictEqual(bo.length, 2);
  assert.deepStrictEqual(bo[0], { title: '博查结果', url: 'https://b.cn/1', content: '较长的文本摘要', site: '博查网', date: '2026-09-01' });
  assert.strictEqual(bo[1].content, '只有 snippet');
  assert.throws(() => S.parseSearchResponse('bocha', JSON.stringify({ code: 403, msg: '余额不足', data: null })), /余额不足/);

  const br = S.parseSearchResponse('brave', JSON.stringify({ web: { results: [{ title: 'Brave', url: 'https://c.com', description: 'desc', extra_snippets: ['more'] }] } }), 5);
  assert.strictEqual(br[0].content, 'desc more');
  const sx = S.parseSearchResponse('searxng', JSON.stringify({ results: [{ title: 'S1', url: 'https://d.com', content: 'c1' }, { title: 'S2', url: 'https://e.com', content: 'c2' }] }), 1);
  assert.strictEqual(sx.length, 1);
});

test('结果注入：编号、链接、日期、问题与引用要求；超长截断', () => {
  const results = [
    { title: '标题一', url: 'https://a.com', content: '内容一', date: '2026-10-01' },
    { title: '标题二', url: 'https://b.com', content: 'x'.repeat(5000) },
    { title: '标题三', url: 'https://c.com', content: 'y'.repeat(5000) },
  ];
  const ctx = S.buildSearchContext(results, '最新进展？', { today: '2026-10-02', maxChars: 6000 });
  assert.ok(ctx.includes('今天是 2026-10-02'));
  assert.ok(ctx.includes('[1] 标题一\n链接：https://a.com\n日期：2026-10-01\n内容：内容一'));
  assert.ok(ctx.includes('[2] 标题二'));
  assert.ok(ctx.includes('[3] 标题三'));
  assert.ok(ctx.includes('[编号]'));
  assert.ok(ctx.trim().endsWith('用户问题：最新进展？'));
  assert.ok(ctx.length < 6000 + 1200);
});

test('搜索词改写：清理前缀和引号，异常时回退', () => {
  assert.strictEqual(S.cleanRewrite('查询词：“2026 诺贝尔物理学奖”\n解释…', 'x'), '2026 诺贝尔物理学奖');
  assert.strictEqual(S.cleanRewrite('', '原问题'), '原问题');
  assert.strictEqual(S.cleanRewrite('a'.repeat(200), '原问题'), '原问题');
  assert.ok(S.buildRewritePrompt('今天呢？', [{ role: 'user', content: '北京天气' }]).includes('用户：北京天气'));
  assert.strictEqual(S.hostOf('https://www.example.com:8080/a?b'), 'example.com:8080');
});
