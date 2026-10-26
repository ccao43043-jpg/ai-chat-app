const test = require('node:test');
const assert = require('node:assert');
const P = require('../app/src/main/assets/www/providers.js');

test('normalizeModelFields fills missing category fields without wiping', () => {
  const p = P.normalizeModelFields({ models: ['a'], imageModel: 'img' });
  assert.deepStrictEqual(p.models, ['a']);
  assert.strictEqual(p.imageModel, 'img');
  for (const f of ['videoModel', 'embeddingModel', 'speechModel', 'transcriptionModel']) assert.strictEqual(p[f], '');
  assert.deepStrictEqual(P.normalizeModelFields({}).models, []);
});

test('MODEL_CATEGORIES has six Chinese categories', () => {
  assert.deepStrictEqual(P.MODEL_CATEGORIES.map(c => c.label), ['文本模型', '图片生成', '视频生成', '嵌入向量', '语音合成', '语音转写']);
});

test('classifyModel by name heuristic', () => {
  const c = P.classifyModel;
  assert.strictEqual(c('gpt-4o'), 'text');
  assert.strictEqual(c('text-embedding-3-small'), 'embedding');
  assert.strictEqual(c('BAAI/bge-m3'), 'embedding');
  assert.strictEqual(c('whisper-1'), 'transcription');
  assert.strictEqual(c('tts-1'), 'speech');
  assert.strictEqual(c('Kwai-Kolors/Kolors'), 'image');
  assert.strictEqual(c('cogview-3-flash'), 'image');
  assert.strictEqual(c('black-forest-labs/FLUX.1-schnell'), 'image');
  assert.strictEqual(c('sora-2'), 'video');
  assert.strictEqual(c('kling-v2'), 'video');
});

test('classifyModel / parseModelsMeta use OpenRouter modality', () => {
  const text = JSON.stringify({ data: [
    { id: 'x/chat', context_length: 1000, architecture: { modality: 'text+image->text' } },
    { id: 'x/painter', architecture: { modality: 'text->image' } },
  ] });
  const meta = P.parseModelsMeta('openai', text);
  assert.strictEqual(meta['x/chat'].context, 1000);
  assert.strictEqual(P.classifyModel('x/chat', meta['x/chat']), 'text');
  assert.strictEqual(P.classifyModel('x/painter', meta['x/painter']), 'image');
});

test('OpenAI preset carries category models', () => {
  const o = P.PRESETS.find(p => p.presetId === 'openai');
  assert.ok(o.imageModel && o.speechModel && o.transcriptionModel && o.embeddingModel);
});
