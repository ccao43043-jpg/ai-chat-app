// v0.6.2：生成进度阶段 + v0.6.1 独立生图模型选择
const test = require('node:test');
const assert = require('assert');
const ImageGen = require('../app/src/main/assets/www/imagegen.js');
const Providers = require('../app/src/main/assets/www/providers.js');

test('canGenerate：需要 openai + apiKey + imageModel（或 override）', () => {
  assert.strictEqual(ImageGen.canGenerate(null).ok, false);
  assert.strictEqual(ImageGen.canGenerate({ type: 'anthropic', apiKey: 'k', imageModel: 'x' }).ok, false);
  assert.strictEqual(ImageGen.canGenerate({ type: 'openai', apiKey: '', imageModel: 'gpt-image-1', name: 'O' }).ok, false);
  assert.strictEqual(ImageGen.canGenerate({ type: 'openai', apiKey: 'sk', imageModel: '', name: 'O' }).ok, false);
  assert.ok(ImageGen.canGenerate({ type: 'openai', apiKey: 'sk', imageModel: 'gpt-image-1', name: 'O' }).ok);
  // 服务商未配 imageModel，但页面覆盖模型时可通过
  const r = ImageGen.canGenerate({ type: 'openai', apiKey: 'sk', imageModel: '', name: 'O' }, 'dall-e-3');
  assert.ok(r.ok);
  assert.strictEqual(r.model, 'dall-e-3');
});

test('effectiveModel：覆盖优先于 provider.imageModel', () => {
  const p = { imageModel: 'gpt-image-1' };
  assert.strictEqual(ImageGen.effectiveModel(p, ''), 'gpt-image-1');
  assert.strictEqual(ImageGen.effectiveModel(p, '  custom-img  '), 'custom-img');
  assert.strictEqual(ImageGen.effectiveModel({ imageModel: '' }, null), '');
});

test('listImageProviders：仅 openai 类型', () => {
  const list = ImageGen.listImageProviders([
    { id: 'a', type: 'openai' },
    { id: 'b', type: 'anthropic' },
    { id: 'c', type: 'openai' },
    null,
  ]);
  assert.deepStrictEqual(list.map(p => p.id), ['a', 'c']);
});

test('buildPromptFromMessages：跳过 imageGen/error/pending，拼接中文模板', () => {
  const msgs = [
    { role: 'user', content: '画一只猫', imageGen: true },
    { role: 'assistant', content: '好的', pending: true },
    { role: 'user', content: '今天天气很好，想去海边' },
    { role: 'assistant', content: '海边日落会很漂亮', error: 'x' },
    { role: 'assistant', content: '建议傍晚去，光线柔和' },
    { role: 'user', content: '那就帮我想个画面' },
  ];
  const p = ImageGen.buildPromptFromMessages(msgs);
  assert.ok(p.startsWith('根据以下对话内容，生成一张配图：'));
  assert.ok(p.includes('用户：今天天气很好'));
  assert.ok(p.includes('助手：建议傍晚去'));
  assert.ok(p.includes('用户：那就帮我想个画面'));
  assert.ok(!p.includes('画一只猫'));
  assert.ok(!p.includes('海边日落会很漂亮'));
  assert.strictEqual(ImageGen.buildPromptFromMessages([]), '');
});

test('normalizeSize 与 buildRequest 支持 model override', () => {
  assert.strictEqual(ImageGen.normalizeSize(''), ImageGen.DEFAULT_SIZE);
  assert.strictEqual(ImageGen.normalizeSize('512x512'), '512x512');
  const p = { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', imageModel: 'gpt-image-1', presetId: 'openai' };
  const req = ImageGen.buildRequest(p, 'a red balloon', '1024x1024');
  assert.strictEqual(req.method, 'POST');
  assert.ok(req.url.endsWith('/images/generations'));
  const body = JSON.parse(req.body);
  assert.strictEqual(body.model, 'gpt-image-1');
  assert.strictEqual(body.prompt, 'a red balloon');
  assert.strictEqual(body.size, '1024x1024');

  const req2 = ImageGen.buildRequest(p, 'cat', '512x512', 'dall-e-3');
  assert.strictEqual(JSON.parse(req2.body).model, 'dall-e-3');
  assert.strictEqual(JSON.parse(req2.body).size, '512x512');

  // 无 imageModel 时必须传 override
  const bare = { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk', imageModel: '', presetId: 'openai' };
  assert.throws(() => ImageGen.buildRequest(bare, 'x', '1024x1024'));
  const req3 = ImageGen.buildRequest(bare, 'x', '1024x1024', 'my-img');
  assert.strictEqual(JSON.parse(req3.body).model, 'my-img');
});

test('parseResponse 解析 url / b64', () => {
  const urls = ImageGen.parseResponse(JSON.stringify({ data: [{ url: 'https://x/a.png' }, { b64_json: 'AAA' }] }));
  assert.deepStrictEqual(urls, ['https://x/a.png', 'data:image/png;base64,AAA']);
});

test('progressStage：按耗时与 HTTP 信号切换中文阶段（无假百分比）', () => {
  assert.strictEqual(ImageGen.progressStage(0).text, '请求已发送…');
  assert.strictEqual(ImageGen.progressStage(500).key, 'sent');
  assert.strictEqual(ImageGen.progressStage(2000).text, '生成中…');
  assert.strictEqual(ImageGen.progressStage(10000).text, '等待结果…');
  assert.strictEqual(ImageGen.progressStage(30000).text, '仍在生成，请稍候…');
  assert.strictEqual(ImageGen.progressStage(500, { httpStarted: true }).text, '等待结果…');
  assert.strictEqual(ImageGen.progressStage(500, { receiving: true }).text, '正在接收…');
  // receiving 优先于 httpStarted
  assert.strictEqual(ImageGen.progressStage(500, { httpStarted: true, receiving: true }).key, 'receiving');
});

test('formatElapsed：整秒中文', () => {
  assert.strictEqual(ImageGen.formatElapsed(0), '0 秒');
  assert.strictEqual(ImageGen.formatElapsed(999), '0 秒');
  assert.strictEqual(ImageGen.formatElapsed(1000), '1 秒');
  assert.strictEqual(ImageGen.formatElapsed(12500), '12 秒');
});

test('buildRequest 带参考图时转发 images → Providers.body.image', () => {
  const p = { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', imageModel: 'gpt-image-1', presetId: 'openai' };
  const dataUrl = 'data:image/jpeg;base64,AAA';
  const req = ImageGen.buildRequest(p, 'edit this', '1024x1024', null, { images: [dataUrl, 'data:image/png;base64,BBB'] });
  const body = JSON.parse(req.body);
  assert.strictEqual(body.image, dataUrl);
  assert.strictEqual(body.prompt, 'edit this');
  // 无参考图时不带 image
  const bare = JSON.parse(ImageGen.buildRequest(p, 'a', '1024x1024').body);
  assert.ok(!('image' in bare));
});
