#!/usr/bin/env node
/*
 * 工作流 B · M1 golden 导出器（OpenAI 兼容请求体 + SSE 解析 + usage）。
 * 直接 require 旧版 JS 参考实现，写出 {"in":[…],"out":…} 每行一条的 jsonl（格式同 spec §6，D 可原样搬进 golden/）。
 * 用法：node app/src/test/resources/net-golden/export-m1.js [--check]
 *   --check：只比对，不写文件；有差异时退出码 1。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const WWW = path.resolve(__dirname, '../../../main/assets/www');
// 与浏览器加载顺序一致：cache-common / router 先挂到 globalThis，providers 再读取 root.CacheCommon / root.Router
require(path.join(WWW, 'plugins/cache/cache-common.js'));
require(path.join(WWW, 'router.js'));
const P = require(path.join(WWW, 'providers.js'));
const OUT = __dirname;
const check = process.argv.includes('--check');

const preset = id => { const p = P.PRESETS.find(x => x.presetId === id); return Object.assign({ id: 'p_' + id }, JSON.parse(JSON.stringify(p))); };
const prov = (id, extra) => Object.assign(preset(id), extra || {});

// ---------------- buildChatRequest（openai 兼容） ----------------
const IMG = 'data:image/png;base64,iVBORw0KGgo=';
const convo = [
  { role: 'user', content: '你好，介绍一下你自己。' },
  { role: 'assistant', content: '我是一个 AI 助手。' },
  { role: 'user', content: '再说一遍\n带换行 "引号" \\ 反斜杠 \t tab \u001b esc \u2028 LS 😀 emoji' },
];
const withSystemNoise = [{ role: 'system', content: '会被过滤' }, { role: 'user', content: '' }, { role: 'assistant', content: '' }].concat(convo);
const imgMsgs = [
  { role: 'user', content: '看图', images: [IMG, 'https://example.com/a.jpg'] },
  { role: 'assistant', content: '是一只猫。', images: [IMG] },
  { role: 'user', content: '', images: [IMG] },
];
const cacheMsgs = [
  { role: 'user', content: '第一轮', _cache: true },
  { role: 'assistant', content: '回答一', _cache: true },
  { role: 'user', content: '带图', images: [IMG], _cache: true },
  { role: 'user', content: '最新一轮' },
];
const SYS = '你是一个有帮助的助手。';
const chatCases = [
  ['openai-plain-nostream', prov('openai'), 'gpt-6-astra', convo, '', { stream: false }],
  ['openai-stream-usage', prov('openai'), 'gpt-6-astra', convo, SYS, { stream: true, temperature: 0.7, maxTokens: 8192 }],
  ['openai-temp-int', prov('openai'), 'gpt-6-astra', convo, SYS, { temperature: 1, maxTokens: 0 }],
  ['openai-temp-nan', prov('openai'), 'gpt-6-astra', convo, SYS, { temperature: NaN }],
  ['openai-sys-trim', prov('openai'), 'gpt-6-astra', convo, '\ufeff\u3000  ' + SYS + ' \n\u00a0', {}],
  ['openai-sys-blank', prov('openai'), 'gpt-6-astra', convo, ' \n\t ', {}],
  ['openai-filter-empty', prov('openai'), 'gpt-6-astra', withSystemNoise, SYS, {}],
  ['openai-images', prov('openai'), 'gpt-6-astra', imgMsgs, SYS, {}],
  ['openai-jsonmode', prov('openai'), 'gpt-6-astra', convo, '', { stream: false, temperature: 0.3, maxTokens: 4096, thinking: false, jsonMode: true }],
  ['deepseek-stream', prov('deepseek'), 'deepseek-v4-pro', convo, SYS, { temperature: 0.5, maxTokens: 8192, convId: 'c1' }],
  ['deepseek-trailing-slash', prov('deepseek', { baseUrl: ' https://api.deepseek.com/// ' }), 'deepseek-flash', convo, SYS, {}],
  ['qwen-thinking-on', prov('qwen', { thinking: 'on' }), 'qwen3.8-max', convo, SYS, { maxTokens: 2048 }],
  ['qwen-thinking-off-opt-true', prov('qwen', { thinking: 'off' }), 'qwen3.8-max', convo, SYS, { thinking: true }],
  ['qwen-thinking-provider-off', prov('qwen-intl', { thinking: 'off' }), 'qwen-plus', convo, SYS, {}],
  ['qwen-cache-control', prov('qwen'), 'qwen3.7-plus', cacheMsgs, SYS, { cacheControl: true }],
  ['qwen-cache-split', prov('qwen'), 'qwen3.7-plus', cacheMsgs, SYS + '【摘要】一些摘要【记忆】一些记忆', { cacheControl: true, cacheSystemSplit: 12 }],
  ['qwen-cache-split-oob', prov('qwen'), 'qwen3.7-plus', cacheMsgs, SYS, { cacheControl: true, cacheSystemSplit: 999 }],
  ['custom-dashscope-host', prov('custom', { baseUrl: 'https://my-ws.maas.aliyuncs.com/compatible-mode/v1', thinking: 'on' }), 'qwen-plus', convo, SYS, {}],
  ['moonshot-no-usage', prov('moonshot'), 'kimi-k3', convo, SYS, { temperature: 0.3 }],
  ['moonshot-usage-forced', prov('moonshot', { streamUsage: true }), 'kimi-k3', convo, SYS, {}],
  ['openai-usage-disabled', prov('openai', { streamUsage: false }), 'gpt-6-astra', convo, SYS, {}],
  ['zhipu-thinking-ignored', prov('zhipu', { thinking: 'on' }), 'glm-5.3', convo, SYS, { jsonMode: true }],
  ['siliconflow', prov('siliconflow'), 'deepseek-ai/DeepSeek-V3.2', imgMsgs, SYS, {}],
  ['xiaomi', prov('xiaomi'), 'mimo-v2.6-pro', convo, SYS, { maxTokens: 1024 }],
  ['custom-deepseek-host', prov('custom', { baseUrl: 'https://api.deepseek.com/v1' }), 'deepseek-flash', convo, SYS, { jsonMode: true }],
  ['openrouter-session', prov('openrouter'), 'deepseek/deepseek-v4', convo, SYS, { convId: 'conv_abc123', maxTokens: 8192 }],
  ['openrouter-session-unicode', prov('openrouter'), 'deepseek/deepseek-v4', convo, SYS, { convId: '会话-😀-1' }],
  ['openrouter-no-conv', prov('openrouter'), 'openai/gpt-6-astra', convo, SYS, { convId: '' }],
  ['openrouter-sort-price', prov('openrouter', { orSort: 'price' }), 'openai/gpt-6-astra', convo, SYS, { convId: 'c2' }],
  ['openrouter-sort-throughput-upper', prov('openrouter', { orSort: 'THROUGHPUT' }), 'openai/gpt-6-astra', convo, SYS, { convId: 'c2' }],
  ['openrouter-sort-bogus', prov('openrouter', { orSort: 'cheapest' }), 'openai/gpt-6-astra', convo, SYS, { convId: 'c2' }],
  ['openrouter-pinned-order', prov('openrouter', { orSort: 'price' }), 'deepseek/deepseek-v4', convo, SYS, { convId: 'c3', providerOrder: ['deepinfra/fp8', 'novita'], routeSlug: 'x' }],
  ['openrouter-pinned-slug', prov('openrouter'), 'deepseek/deepseek-v4', convo, SYS, { convId: 'c3', routeSlug: 'siliconflow/fp8' }],
  ['openrouter-affinity-off', prov('openrouter', { cacheAffinity: false, orSort: 'throughput' }), 'deepseek/deepseek-v4', convo, SYS, { convId: 'c3', providerOrder: ['novita'] }],
  ['openrouter-by-host', prov('custom', { baseUrl: 'https://OpenRouter.ai/api/v1/' }), 'x/y', convo, SYS, { convId: 42 }],
  ['openrouter-jsonmode-nostream', prov('openrouter'), 'openai/gpt-6-astra', convo, '', { stream: false, jsonMode: true, convId: 'c4' }],
  ['openrouter-images-cache', prov('openrouter'), 'anthropic/claude-opus-5.5', cacheMsgs, SYS, { cacheControl: true, convId: 'c5' }],
];
// 输入的 JS 原样序列化（NaN → null，交给 Kotlin 侧按「未设」处理，与 JS isNaN 分支同义）
const chatLines = chatCases.map(([name, p, model, msgs, sys, opts]) => {
  const r = P.buildChatRequest(p, model, msgs, sys, opts);
  const headers = Object.assign({}, r.headers); delete headers.Authorization; // 认证头由 AuthInjector 注入，不进 golden
  return { name, in: [p, model, msgs, sys, opts], out: { url: r.url, method: r.method, headers, body: r.body } };
});

// ---------------- orSessionIdFor ----------------
const sidLines = ['c1', 'conv_abc123', '会话-😀-1', '42', 'a', 'x'.repeat(300)].map(id => ({ in: [id], out: P.orSessionIdFor(id) }));
sidLines.push({ in: ['c1', 'gc'], out: P.orSessionIdFor('c1', 'gc') });

// ---------------- normalizeUsage / mergeUsage ----------------
const usages = [
  { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  { prompt_tokens: 1200, completion_tokens: 50, prompt_cache_hit_tokens: 1024, prompt_cache_miss_tokens: 176 },
  { completion_tokens: 50, prompt_cache_hit_tokens: 64 },
  { prompt_tokens: 2006, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1920 } },
  { prompt_tokens: 500, completion_tokens: 10, cache_read_input_tokens: 256 },
  { prompt_tokens: 500, cached_tokens: 128 },
  { prompt_tokens: 3000, completion_tokens: 200, cost: 0.00123, cost_details: { upstream_inference_cost: 0.0011, cache_discount: 0.0004 }, prompt_tokens_details: { cached_tokens: 2048, cache_write_tokens: 512 } },
  { prompt_tokens: 3000, cost: 0.002, cost_cache: -0.0003 },
  { prompt_tokens: 3000, cost: 0.002, cost_cache: 0.0003, cache_discount: 0.0001 },
  { prompt_tokens: 3000, prompt_tokens_details: { cache_creation_input_tokens: 2900 } },
  { prompt_tokens: 3000, prompt_tokens_details: { cached_tokens: 100, cache_creation_input_tokens: 2900, cache_write_tokens: 7 } },
  { prompt_tokens: 10, prompt_tokens_details: { cache_write_tokens: 0 } },
  { prompt_tokens: '12', completion_tokens: null },
  {},
  null,
  'x',
];
const anth = [
  { input_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 5 },
  { input_tokens: 10, cache_creation_input_tokens: 1500 },
  { output_tokens: 99 },
  { input_tokens: 7 },
];
const gem = [
  { promptTokenCount: 4000, candidatesTokenCount: 100, thoughtsTokenCount: 50, cachedContentTokenCount: 3000 },
  { promptTokenCount: 40, candidatesTokenCount: 10 },
  { cachedContentTokenCount: 30 },
];
const usageLines = []
  .concat(usages.map(u => ({ in: ['openai', u], out: P.normalizeUsage('openai', u) })))
  .concat(anth.map(u => ({ in: ['anthropic', u], out: P.normalizeUsage('anthropic', u) })))
  .concat(gem.map(u => ({ in: ['gemini', u], out: P.normalizeUsage('gemini', u) })));
const merges = [
  [null, null], [{ prompt: 1 }, null], [null, { completion: 2 }],
  [{ prompt: 100, hit: 10, miss: 90, cacheSupported: true, source: 'openai' }, { prompt: 120, completion: 5 }],
  [{ prompt: 100, hit: 150, cacheSupported: true }, { completion: 1 }],
  [{ prompt: 100 }, { hit: 40 }],
  [{ cost: 0.1, prompt: 1 }, { cost: 0.2, cacheSaved: 0.01 }],
];
const mergeLines = merges.map(([a, b]) => ({ in: [a, b], out: P.mergeUsage(a, b) }));

// ---------------- SSE（createStreamParser）录制形态的分片 ----------------
const sse = objs => objs.map(o => 'data: ' + (typeof o === 'string' ? o : JSON.stringify(o)) + '\n\n').join('');
const chunk = (delta, extra) => Object.assign({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }, extra || {});
const fin = (reason, extra) => Object.assign({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: reason }] }, extra || {});
const streams = {
  // OpenAI：usage 单独一块（choices 为空）
  'openai-basic': sse([chunk({ role: 'assistant', content: '' }), chunk({ content: '你好' }), chunk({ content: '，世界 😀' }), fin('stop'),
    { id: 'x', choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } }, '[DONE]']),
  // DeepSeek：reasoning_content + usage 附在最后一个内容块上 + keep-alive 注释
  'deepseek-reasoning': ': keep-alive\n\n' + sse([chunk({ role: 'assistant', reasoning_content: '先想' }), chunk({ reasoning_content: '一想' }),
    chunk({ content: '答案' }),
    fin('stop', { usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_cache_hit_tokens: 1024, prompt_cache_miss_tokens: 176 } }), '[DONE]']),
  // OpenRouter：处理中注释、reasoning 字段、cost
  'openrouter-reasoning-cost': ': OPENROUTER PROCESSING\n\n: OPENROUTER PROCESSING\n\n' + sse([chunk({ role: 'assistant', content: '', reasoning: '思考' }),
    chunk({ content: 'Hi' }), fin('length'),
    { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 3000, completion_tokens: 8, cost: 0.00123, prompt_tokens_details: { cached_tokens: 2048 }, cost_details: { upstream_inference_cost: 0.0011 } } }, '[DONE]']),
  // CRLF 行尾、event:/id:/retry: 行、多行 data、非 JSON 行
  'crlf-multiline-junk': 'event: message\r\nid: 1\r\nretry: 1000\r\ndata: {"choices":[{"delta":\r\ndata: {"content":"多行"}}]}\r\n\r\n' +
    'data: not-json\r\n\r\n' + 'data:{"choices":[{"delta":{"content":"无空格"}}]}\r\n\r\n' + 'data: [DONE]\r\n\r\n',
  // 流中错误对象
  'error-midstream': sse([chunk({ content: '部分' }), { error: { message: 'upstream overloaded', code: 502 } }]),
  'error-no-message': sse([{ error: { code: 'x' } }]),
  // 千问：usage 块 choices 为空；末尾无空行（end() 冲刷）
  'qwen-usage-tail-noblank': sse([chunk({ content: 'a' }), fin('stop')]) +
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":0,"cache_creation_input_tokens":8}}}',
  // [DONE] 后继续出现的数据（JS 解析器仍会处理）
  'after-done': sse([chunk({ content: 'x' }), '[DONE]', chunk({ content: 'y' })]),
  // 非流式整包（choices[].message）—— 走 parseFullResponse
  'full-json': JSON.stringify({ choices: [{ message: { role: 'assistant', content: '整包', reasoning_content: '理由' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
};
const sseLines = Object.keys(streams).filter(k => k !== 'full-json').map(name => {
  const parser = P.createStreamParser('openai');
  const text = streams[name];
  const out = parser.push(text).concat(parser.end());
  return { name, in: ['openai', text], out: { deltas: out, done: parser.done } };
});
// anthropic / gemini 的 SSE 也走同一个解析器（M1 把 extractDeltas 三种格式一起移植；请求构造在 M2）
const ev = (name, o) => 'event: ' + name + '\ndata: ' + JSON.stringify(o) + '\n\n';
const otherStreams = [
  ['anthropic-basic', 'anthropic',
    ev('message_start', { type: 'message_start', message: { id: 'm', usage: { input_tokens: 12, cache_read_input_tokens: 2048, cache_creation_input_tokens: 0, output_tokens: 1 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '嗯' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } }) +
    ev('ping', { type: 'ping' }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }) +
    ev('message_stop', { type: 'message_stop' })],
  ['anthropic-error', 'anthropic', ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) + ev('error', { type: 'error' })],
  ['gemini-basic', 'gemini',
    'data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '想', thought: true }, { text: '答' }] } }], usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 2, thoughtsTokenCount: 1, cachedContentTokenCount: 3000 } }) + '\r\n\r\n' +
    'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }, { inlineData: {} }] }, finishReason: 'STOP' }] }) + '\r\n\r\n' +
    'data: ' + JSON.stringify({ error: { message: 'quota' } }) + '\r\n\r\n'],
];
const otherSseLines = otherStreams.map(([name, type, text]) => {
  const parser = P.createStreamParser(type);
  const out = parser.push(text).concat(parser.end());
  return { name, in: [type, text], out: { deltas: out, done: parser.done } };
});
const fullLines = [streams['full-json'], '[' + streams['full-json'] + ',{"choices":[{"delta":{"content":"二"}}]}]', 'not json at all'].map(t => ({ in: ['openai', t], out: P.parseFullResponse('openai', t) }));

// ---------------- parseError / resolveMaxTokens / parseAffordTokens / downgradeMaxTokens ----------------
const errLines = [
  [401, '{"error":{"message":"Invalid API key","type":"auth"}}'],
  [402, '{"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 12345."}}'],
  [404, '[{"error":{"message":"model not found"}}]'],
  [429, '{"error":"rate limited"}'],
  [400, '{"message":"bad param"}'],
  [400, '{"msg":"参数错误"}'],
  [500, '<html>Internal Server Error</html>'],
  [503, ''],
  [418, 'x'.repeat(800)],
].map(([s, t]) => ({ in: [s, t], out: P.parseError(s, t) }));
const metaProv = { modelMeta: { big: { maxOutput: 1000000 }, small: { maxOutput: 4096 }, none: {} } };
const maxLines = [
  [metaProv, 'big', ''], [metaProv, 'big', 20000], [metaProv, 'small', 8192], [metaProv, 'small', '2000'], [metaProv, 'none', null],
  [metaProv, 'unknown', 0], [metaProv, 'small', -5], [{}, 'x', '12.5'], [null, 'x', 'abc'],
].map(a => ({ in: a, out: P.resolveMaxTokens.apply(null, a) }));
const affordLines = ['can only afford 12345.', 'Can Only Afford   77 tokens', 'can only afford 0', 'nothing', '', null].map(t => ({ in: [t], out: P.parseAffordTokens(t) }));
const downLines = [[12345], [100], [0], [null], [1000, { min: 512 }], [400.9]].map(a => ({ in: a, out: P.downgradeMaxTokens.apply(null, a) }));

const files = {
  'buildChatRequest.openai.jsonl': chatLines,
  'orSessionIdFor.jsonl': sidLines,
  'normalizeUsage.jsonl': usageLines,
  'mergeUsage.jsonl': mergeLines,
  'createStreamParser.openai.jsonl': sseLines,
  'createStreamParser.other.jsonl': otherSseLines,
  'parseFullResponse.openai.jsonl': fullLines,
  'parseError.jsonl': errLines,
  'resolveMaxTokens.jsonl': maxLines,
  'parseAffordTokens.jsonl': affordLines,
  'downgradeMaxTokens.jsonl': downLines,
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
