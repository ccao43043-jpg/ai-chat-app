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
  const r = P.buildChatRequest(preset('deepseek'), 'deepseek-flash', msgs, '你是助手', { stream: true });
  assert.strictEqual(r.url, 'https://api.deepseek.com/chat/completions');
  assert.strictEqual(r.headers.Authorization, 'Bearer sk-test');
  const b = JSON.parse(r.body);
  assert.strictEqual(b.model, 'deepseek-flash');
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
  const r = P.buildChatRequest(preset('anthropic'), 'claude-opus-5-5', msgs, 'SYS', { stream: true });
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
  const r = P.buildChatRequest(preset('gemini'), 'gemini-3.8-flash', msgs, 'SYS', { stream: true });
  assert.strictEqual(r.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
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
  const r = P.buildImageRequest(preset('openai'), 'gpt-image-2.5-flare', '一只猫', { size: '1024x1024' });
  assert.strictEqual(r.url, 'https://api.openai.com/v1/images/generations');
  assert.deepStrictEqual(JSON.parse(r.body), { model: 'gpt-image-2.5-flare', prompt: '一只猫', n: 1, size: '1024x1024' });
  const sf = JSON.parse(P.buildImageRequest(preset('siliconflow'), 'Kwai-Kolors/Kolors', 'cat', { size: '1024x1024' }).body);
  assert.strictEqual(sf.image_size, '1024x1024');
  assert.ok(!('image' in sf));
  const withImg = JSON.parse(P.buildImageRequest(preset('siliconflow'), 'Kwai-Kolors/Kolors', 'cat', {
    size: '1024x1024', images: ['data:image/jpeg;base64,QQ==', 'data:image/png;base64,WW=='],
  }).body);
  assert.strictEqual(withImg.image, 'data:image/jpeg;base64,QQ==');
  assert.strictEqual(withImg.image_size, '1024x1024');
  const noImg = JSON.parse(P.buildImageRequest(preset('openai'), 'gpt-image-2.5-flare', 'x', { size: '512x512', images: [] }).body);
  assert.ok(!('image' in noImg));
  assert.deepStrictEqual(P.parseImageResponse('{"data":[{"b64_json":"QQ=="},{"url":"https://a/b.png"}]}'),
    ['data:image/png;base64,QQ==', 'https://a/b.png']);
  assert.deepStrictEqual(P.parseImageResponse('{"images":[{"url":"https://s/c.png"}]}'), ['https://s/c.png']);
});

test('预设：DeepSeek 使用新地址与新模型名', () => {
  const d = preset('deepseek');
  assert.strictEqual(d.baseUrl, 'https://api.deepseek.com');
  assert.deepStrictEqual(d.models, ['deepseek-flash', 'deepseek-v4-pro']);
  P.PRESETS.forEach(p => assert.ok(!p.models.includes('deepseek-chat') && !p.models.includes('deepseek-reasoner')));
});

test('设置迁移：替换已下线模型，保留 API Key 与自定义模型', () => {
  const old = {
    providers: [
      { id: 'deepseek', presetId: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds', models: ['deepseek-chat', 'deepseek-reasoner'] },
      { id: 'openai', presetId: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-oa', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'], imageModel: 'gpt-image-1' },
      { id: 'moonshot', presetId: 'moonshot', name: 'Moonshot (Kimi)', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1', apiKey: '', models: ['moonshot-v1-8k', 'my-model'] },
      { id: 'x1', presetId: 'custom', name: '我的', type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k', models: ['deepseek-chat'] },
    ],
    lastProviderId: 'deepseek', lastModel: 'deepseek-reasoner',
  };
  const { settings, changed } = P.migrateSettings(JSON.parse(JSON.stringify(old)));
  assert.strictEqual(changed, true);
  const ds = settings.providers[0];
  assert.deepStrictEqual(ds.models, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.strictEqual(ds.apiKey, 'sk-ds');
  assert.strictEqual(ds.baseUrl, 'https://api.deepseek.com');
  assert.deepStrictEqual(settings.providers[1].models, preset('openai').models);
  assert.strictEqual(settings.providers[1].imageModel, 'gpt-image-2.5-flare');
  assert.strictEqual(settings.providers[1].apiKey, 'sk-oa');
  assert.deepStrictEqual(settings.providers[2].models, ['kimi-k3', 'my-model']);
  assert.deepStrictEqual(settings.providers[3].models, ['deepseek-chat'], '自定义服务商不改动');
  assert.strictEqual(settings.lastModel, 'deepseek-flash');
  // 二次迁移无变化
  assert.strictEqual(P.migrateSettings(settings).changed, false);
  // 对话迁移
  const c1 = { providerId: 'deepseek', model: 'deepseek-chat' }, c2 = { providerId: 'x1', model: 'deepseek-chat' };
  assert.strictEqual(P.migrateConversation(c1, settings.providers), true);
  assert.strictEqual(c1.model, 'deepseek-flash');
  assert.strictEqual(P.migrateConversation(c2, settings.providers), false);
  assert.strictEqual(c2.model, 'deepseek-chat');
});

test('获取模型列表：请求与解析', () => {
  const o = P.buildModelsRequest({ type: 'openai', baseUrl: 'https://api.deepseek.com/', apiKey: 'k' });
  assert.deepStrictEqual(o, { url: 'https://api.deepseek.com/models', method: 'GET', headers: { Authorization: 'Bearer k' } });
  const a = P.buildModelsRequest({ type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k' });
  assert.strictEqual(a.url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.strictEqual(a.headers['x-api-key'], 'k');
  const g = P.buildModelsRequest({ type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'k' });
  assert.strictEqual(g.url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
  assert.strictEqual(g.headers['x-goog-api-key'], 'k');
  assert.deepStrictEqual(P.parseModelsResponse('openai', '{"object":"list","data":[{"id":"deepseek-v4-pro"},{"id":"deepseek-flash"},{"id":"deepseek-flash"}]}'),
    ['deepseek-flash', 'deepseek-v4-pro']);
  assert.deepStrictEqual(P.parseModelsResponse('anthropic', '{"data":[{"type":"model","id":"claude-opus-5-5"}],"has_more":false}'), ['claude-opus-5-5']);
  assert.deepStrictEqual(P.parseModelsResponse('gemini', JSON.stringify({ models: [
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }] })), ['gemini-3.8-flash']);
});

test('OpenRouter 获取模型列表包含全部输出模态', () => {
  const r = P.buildModelsRequest({ type: 'openai', baseUrl: 'https://openrouter.ai/api/v1/', apiKey: 'k' });
  assert.strictEqual(r.url, 'https://openrouter.ai/api/v1/models?output_modalities=all');
  const r2 = P.buildModelsRequest({ type: 'openai', presetId: 'openrouter', baseUrl: 'https://proxy.example/v1', apiKey: 'k' });
  assert.strictEqual(r2.url, 'https://proxy.example/v1/models?output_modalities=all');
});


test('FLUX 3：像素 size 转为 resolution + aspect_ratio，不发 size', () => {
  const or = { type: 'openai', presetId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or' };
  const r = P.buildImageRequest(or, 'black-forest-labs/flux-3-image', 'a cat', { size: '768x768' });
  assert.ok(r.url.endsWith('/images'), 'OpenRouter 走 /images');
  assert.ok(!r.url.includes('/images/generations'));
  const b = JSON.parse(r.body);
  assert.strictEqual(b.resolution, '768');
  assert.strictEqual(b.aspect_ratio, '1:1');
  assert.ok(!('size' in b));
  assert.ok(!('image' in b));

  const portrait = JSON.parse(P.buildImageRequest(or, 'black-forest-labs/flux.3', 'x', { size: '1024x1792' }).body);
  assert.strictEqual(portrait.resolution, '1.5K');
  assert.strictEqual(portrait.aspect_ratio, '9:16');

  const landscape = JSON.parse(P.buildImageRequest(or, 'flux3', 'x', { size: '1792x1024' }).body);
  assert.strictEqual(landscape.resolution, '1.5K');
  assert.strictEqual(landscape.aspect_ratio, '16:9');

  const sq1k = JSON.parse(P.buildImageRequest(or, 'Black-Forest-Labs/FLUX-3', 'x', { size: '1024x1024' }).body);
  assert.strictEqual(sq1k.resolution, '1K');
  assert.strictEqual(sq1k.aspect_ratio, '1:1');
});

test('FLUX + 参考图：input_references（非 image）', () => {
  const or = { type: 'openai', presetId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' };
  const a = 'data:image/jpeg;base64,AAA';
  const b64 = 'data:image/png;base64,BBB';
  const body = JSON.parse(P.buildImageRequest(or, 'black-forest-labs/flux-3-image', 'edit', {
    size: '768x768', images: [a, b64],
  }).body);
  assert.ok(!('image' in body));
  assert.ok(Array.isArray(body.input_references));
  assert.strictEqual(body.input_references.length, 2);
  assert.deepStrictEqual(body.input_references[0], { type: 'image_url', image_url: { url: a } });
  assert.strictEqual(body.resolution, '768');
  assert.strictEqual(body.aspect_ratio, '1:1');
});

test('OpenRouter 非 FLUX 仍可用 size，URL 为 /images', () => {
  const or = { type: 'openai', presetId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1/', apiKey: 'k' };
  const r = P.buildImageRequest(or, 'openai/gpt-image-1', 'cat', { size: '1024x1024' });
  assert.strictEqual(r.url, 'https://openrouter.ai/api/v1/images');
  const b = JSON.parse(r.body);
  assert.strictEqual(b.size, '1024x1024');
  assert.ok(!('resolution' in b));
});

test('SiliconFlow Kolors 仍用 image_size + image', () => {
  const sf = JSON.parse(P.buildImageRequest(preset('siliconflow'), 'Kwai-Kolors/Kolors', 'cat', {
    size: '1024x1024', images: ['data:image/jpeg;base64,QQ=='],
  }).body);
  assert.strictEqual(sf.image_size, '1024x1024');
  assert.strictEqual(sf.image, 'data:image/jpeg;base64,QQ==');
  assert.ok(!('resolution' in sf));
  assert.ok(!('input_references' in sf));
  const url = P.buildImageRequest(preset('siliconflow'), 'Kwai-Kolors/Kolors', 'cat', { size: '1024x1024' }).url;
  assert.ok(url.endsWith('/images/generations'));
});

test('parseImageResponse 尊重 media_type', () => {
  assert.deepStrictEqual(
    P.parseImageResponse('{"data":[{"b64_json":"QQ==","media_type":"image/jpeg"},{"url":"https://a/b.png"}]}'),
    ['data:image/jpeg;base64,QQ==', 'https://a/b.png']
  );
  assert.deepStrictEqual(
    P.parseImageResponse('{"data":[{"b64_json":"WW=="}]}'),
    ['data:image/png;base64,WW==']
  );
});

test('isFluxTierModel / pixelSizeToTier 辅助', () => {
  assert.ok(P.isFluxTierModel('black-forest-labs/flux-3-image'));
  assert.ok(P.isFluxTierModel('flux.3'));
  assert.ok(P.isFluxTierModel('FLUX3'));
  assert.ok(!P.isFluxTierModel('Kwai-Kolors/Kolors'));
  assert.ok(P.isFluxTierModel('bytedance/seedream-4', { presetId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }));
  assert.ok(!P.isFluxTierModel('bytedance/seedream-4', { presetId: 'openai', baseUrl: 'https://api.openai.com/v1' }));
  assert.deepStrictEqual(P.pixelSizeToTier('768x768'), { resolution: '768', aspect_ratio: '1:1' });
  assert.deepStrictEqual(P.pixelSizeToTier('512x512'), { resolution: '768', aspect_ratio: '1:1' });
  assert.strictEqual(P.closestAspectRatio(1024, 1792), '9:16');
  assert.strictEqual(P.closestAspectRatio(1792, 1024), '16:9');
});

test('OpenRouter 优先最低价供应商（provider.sort=price）', () => {
  const b1 = JSON.parse(P.buildChatRequest(preset('openrouter'), 'openai/gpt-4o-mini', msgs, '').body);
  assert.deepStrictEqual(b1.provider, { sort: 'price' });
  const b2 = JSON.parse(P.buildChatRequest({ type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' }, 'm', msgs, '').body);
  assert.deepStrictEqual(b2.provider, { sort: 'price' });
  const b3 = JSON.parse(P.buildChatRequest(preset('deepseek'), 'deepseek-flash', msgs, '').body);
  assert.strictEqual(b3.provider, undefined);
  const b4 = JSON.parse(P.buildChatRequest({ type: 'openai', baseUrl: 'https://x.com/v1', apiKey: 'k' }, 'm', msgs, '').body);
  assert.strictEqual(b4.provider, undefined);
});
