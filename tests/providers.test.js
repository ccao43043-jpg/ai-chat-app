// 运行：node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const P = require('../app/src/main/assets/www/providers.js');

const img = 'data:image/png;base64,AAAA';
const msgs = [
  { role: 'user', content: '你好' },
  { role: 'assistant', content: '你好！' },
  { role: 'user', content: '这是什么？', images: [img] },
];
const preset = id => Object.assign({ apiKey: 'sk-test' }, P.PRESETS.find(p => p.presetId === id));

test('OpenAI 兼容请求格式', () => {
  const r = P.buildChatRequest(preset('deepseek'), 'deepseek-chat', msgs, '你是助手', { stream: true });
  assert.strictEqual(r.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.strictEqual(r.headers.Authorization, 'Bearer sk-test');
  const b = JSON.parse(r.body);
  assert.strictEqual(b.model, 'deepseek-chat');
  assert.strictEqual(b.stream, true);
  assert.deepStrictEqual(b.messages[0], { role: 'system', content: '你是助手' });
  assert.strictEqual(b.messages.length, 4);
  assert.deepStrictEqual(b.messages[3].content[1], { type: 'image_url', image_url: { url: img } });
});

test('Base URL 末尾斜杠被去掉', () => {
  const r = P.buildChatRequest({ type: 'openai', baseUrl: 'https://x.com/v1///', apiKey: 'k' }, 'm', msgs, '');
  assert.strictEqual(r.url, 'https://x.com/v1/chat/completions');
  assert.strictEqual(JSON.parse(r.body).messages[0].role, 'user');
});

test('Anthropic 请求格式', () => {
  const r = P.buildChatRequest(preset('anthropic'), 'claude-sonnet-4-5', msgs, 'SYS', { stream: true });
  assert.strictEqual(r.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(r.headers['x-api-key'], 'sk-test');
  assert.strictEqual(r.headers['anthropic-version'], '2023-06-01');
  const b = JSON.parse(r.body);
  assert.strictEqual(b.system, 'SYS');
  assert.strictEqual(b.max_tokens, 4096);
  assert.deepStrictEqual(b.messages[2].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.deepStrictEqual(b.messages[2].content[1], { type: 'text', text: '这是什么？' });
});

test('Gemini 请求格式', () => {
  const r = P.buildChatRequest(preset('gemini'), 'gemini-2.5-flash', msgs, 'SYS', { stream: true });
  assert.strictEqual(r.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  assert.strictEqual(r.headers['x-goog-api-key'], 'sk-test');
  const b = JSON.parse(r.body);
  assert.strictEqual(b.contents[1].role, 'model');
  assert.deepStrictEqual(b.contents[2].parts[0], { inline_data: { mime_type: 'image/png', data: 'AAAA' } });
  assert.deepStrictEqual(b.systemInstruction, { parts: [{ text: 'SYS' }] });
  const r2 = P.buildChatRequest(preset('gemini'), 'gemini-2.5-flash', msgs, '', { stream: false });
  assert.ok(r2.url.endsWith(':generateContent'));
});

test('OpenAI SSE 解析（跨块切分、reasoning、[DONE]）', () => {
  const p = P.createStreamParser('openai');
  const s = 'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"你"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"好"}}]}\r\n\r\n: keepalive\n\ndata: [DONE]\n\n';
  let out = [];
  for (let i = 0; i < s.length; i += 7) out = out.concat(p.push(s.slice(i, i + 7)));
  out = out.concat(p.end());
  assert.deepStrictEqual(out, [{ kind: 'reasoning', text: '想' }, { kind: 'text', text: '你' }, { kind: 'text', text: '好' }]);
  assert.strictEqual(p.done, true);
});

test('Anthropic SSE 解析', () => {
  const p = P.createStreamParser('anthropic');
  const s = 'event: message_start\ndata: {"type":"message_start","message":{}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  assert.deepStrictEqual(p.push(s), [{ kind: 'text', text: 'Hi' }]);
});

test('Gemini SSE 解析', () => {
  const p = P.createStreamParser('gemini');
  const s = 'data: {"candidates":[{"content":{"parts":[{"text":"你好"}],"role":"model"}}]}\r\n\r\n';
  assert.deepStrictEqual(p.push(s), [{ kind: 'text', text: '你好' }]);
});

test('非流式响应与错误解析', () => {
  assert.deepStrictEqual(P.parseFullResponse('openai', '{"choices":[{"message":{"content":"ok"}}]}'), [{ kind: 'text', text: 'ok' }]);
  assert.deepStrictEqual(P.parseFullResponse('anthropic', '{"content":[{"type":"text","text":"ok"}]}'), [{ kind: 'text', text: 'ok' }]);
  const e = P.parseError(401, '{"error":{"message":"Incorrect API key"}}');
  assert.ok(e.includes('401') && e.includes('Incorrect API key') && e.includes('API Key'));
  assert.ok(P.parseError(500, 'oops').includes('oops'));
});

test('图像生成请求与解析', () => {
  const r = P.buildImageRequest(preset('openai'), 'gpt-image-1', '一只猫', { size: '1024x1024' });
  assert.strictEqual(r.url, 'https://api.openai.com/v1/images/generations');
  assert.deepStrictEqual(JSON.parse(r.body), { model: 'gpt-image-1', prompt: '一只猫', n: 1, size: '1024x1024' });
  const sf = JSON.parse(P.buildImageRequest(preset('siliconflow'), 'Kwai-Kolors/Kolors', 'cat', { size: '1024x1024' }).body);
  assert.strictEqual(sf.image_size, '1024x1024');
  assert.deepStrictEqual(P.parseImageResponse('{"data":[{"b64_json":"QQ=="},{"url":"https://a/b.png"}]}'),
    ['data:image/png;base64,QQ==', 'https://a/b.png']);
  assert.deepStrictEqual(P.parseImageResponse('{"images":[{"url":"https://s/c.png"}]}'), ['https://s/c.png']);
});
