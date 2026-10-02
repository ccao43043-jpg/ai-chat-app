// 用量解析：stream_options、DeepSeek 缓存字段、流式最后一块 usage
const test = require('node:test');
const assert = require('node:assert');
const P = require('../app/src/main/assets/www/providers.js');
const preset = id => Object.assign({ apiKey: 'sk' }, P.PRESETS.find(p => p.presetId === id));
const msgs = [{ role: 'user', content: 'hi' }];
const sse = objs => objs.map(o => 'data: ' + JSON.stringify(o) + '\n\n').join('') + 'data: [DONE]\n\n';
function runStream(type, text, chunk = 7) {
  const p = P.createStreamParser(type); const out = [];
  for (let i = 0; i < text.length; i += chunk) out.push(...p.push(text.slice(i, i + chunk)));
  out.push(...p.end());
  return out;
}

test('stream_options.include_usage：DeepSeek/OpenAI 默认开启，其他默认关闭，可手动开关', () => {
  const ds = JSON.parse(P.buildChatRequest(preset('deepseek'), 'deepseek-flash', msgs, '', { stream: true }).body);
  assert.deepStrictEqual(ds.stream_options, { include_usage: true });
  const oa = JSON.parse(P.buildChatRequest(preset('openai'), 'gpt-4o', msgs, '', { stream: true }).body);
  assert.deepStrictEqual(oa.stream_options, { include_usage: true });
  const nonStream = JSON.parse(P.buildChatRequest(preset('deepseek'), 'deepseek-flash', msgs, '', { stream: false }).body);
  assert.strictEqual(nonStream.stream_options, undefined);
  const custom = { type: 'openai', baseUrl: 'https://example.com/v1', apiKey: 'k' };
  assert.strictEqual(JSON.parse(P.buildChatRequest(custom, 'm', msgs, '', { stream: true }).body).stream_options, undefined);
  assert.ok(JSON.parse(P.buildChatRequest(Object.assign({ streamUsage: true }, custom), 'm', msgs, '', { stream: true }).body).stream_options);
  assert.strictEqual(JSON.parse(P.buildChatRequest(Object.assign({}, preset('deepseek'), { streamUsage: false }), 'deepseek-flash', msgs, '', { stream: true }).body).stream_options, undefined);
  assert.ok(P.streamUsageEnabled({ type: 'openai', baseUrl: 'https://api.deepseek.com' }), '自定义 DeepSeek 地址也开启');
});

test('DeepSeek 流式：usage 附在最后一个内容块（finish_reason 非空）上', () => {
  const text = sse([
    { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }], usage: null },
    { choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }], usage: null },
    { choices: [{ index: 0, delta: { content: '！' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230, prompt_cache_hit_tokens: 1024, prompt_cache_miss_tokens: 176, prompt_tokens_details: { cached_tokens: 1024 } } },
  ]);
  const ds = runStream('openai', text);
  assert.strictEqual(ds.filter(d => d.kind === 'text').map(d => d.text).join(''), '你好！');
  const us = ds.filter(d => d.kind === 'usage');
  assert.strictEqual(us.length, 1);
  const u = us[0].usage;
  assert.deepStrictEqual([u.prompt, u.completion, u.hit, u.miss, u.cacheSupported], [1200, 30, 1024, 176, true]);
  assert.strictEqual(us[0].usage.source, 'deepseek');
});

test('OpenAI 流式：choices 为空的最终用量块', () => {
  const text = sse([
    { choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 2000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 1536 } } },
  ]);
  const u = runStream('openai', text, 13).find(d => d.kind === 'usage').usage;
  assert.strictEqual(u.prompt, 2000); assert.strictEqual(u.hit, 1536); assert.strictEqual(u.miss, 464); assert.ok(u.cacheSupported);
});

test('没有缓存字段时标记为不支持统计', () => {
  const u = P.normalizeUsage('openai', { prompt_tokens: 100, completion_tokens: 3 });
  assert.strictEqual(u.prompt, 100); assert.ok(!u.cacheSupported);
});

test('Anthropic：message_start + message_delta 合并', () => {
  const text = 'event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 1 } } }) + '\n\n' +
    'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }) + '\n\n' +
    'event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 42 } }) + '\n\n';
  let u = null; runStream('anthropic', text).filter(d => d.kind === 'usage').forEach(d => { u = P.mergeUsage(u, d.usage); });
  assert.strictEqual(u.prompt, 1000); assert.strictEqual(u.hit, 900); assert.strictEqual(u.completion, 42); assert.ok(u.cacheSupported);
});

test('Gemini usageMetadata 与非流式 DeepSeek 响应', () => {
  const g = P.normalizeUsage('gemini', { promptTokenCount: 800, candidatesTokenCount: 20, cachedContentTokenCount: 600 });
  assert.strictEqual(g.hit, 600); assert.strictEqual(g.miss, 200);
  const full = P.parseFullResponse('openai', JSON.stringify({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 } }));
  const u = full.find(d => d.kind === 'usage').usage;
  assert.strictEqual(u.hit, 0); assert.strictEqual(u.miss, 10); assert.ok(u.cacheSupported);
});
