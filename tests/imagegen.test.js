// v0.6.0：独立生图 / 据此生图共享逻辑
const test = require('node:test');
const assert = require('assert');
const ImageGen = require('../app/src/main/assets/www/imagegen.js');
const Providers = require('../app/src/main/assets/www/providers.js');

test('canGenerate：需要 openai + apiKey + imageModel', () => {
  assert.strictEqual(ImageGen.canGenerate(null).ok, false);
  assert.strictEqual(ImageGen.canGenerate({ type: 'anthropic', apiKey: 'k', imageModel: 'x' }).ok, false);
  assert.strictEqual(ImageGen.canGenerate({ type: 'openai', apiKey: '', imageModel: 'gpt-image-1', name: 'O' }).ok, false);
  assert.strictEqual(ImageGen.canGenerate({ type: 'openai', apiKey: 'sk', imageModel: '', name: 'O' }).ok, false);
  assert.ok(ImageGen.canGenerate({ type: 'openai', apiKey: 'sk', imageModel: 'gpt-image-1', name: 'O' }).ok);
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

test('normalizeSize 与 buildRequest 走 Providers', () => {
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
});

test('parseResponse 解析 url / b64', () => {
  const urls = ImageGen.parseResponse(JSON.stringify({ data: [{ url: 'https://x/a.png' }, { b64_json: 'AAA' }] }));
  assert.deepStrictEqual(urls, ['https://x/a.png', 'data:image/png;base64,AAA']);
});
