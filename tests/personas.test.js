// 助手与提示词库：存储、规范化、创建对话
const test = require('node:test');
const assert = require('assert');
const P = require('../app/src/main/assets/www/personas.js');

test('内置 8 个中文助手与 6 条提示词', () => {
  const list = P.defaultPersonas();
  assert.strictEqual(list.length, 8);
  ['翻译官', '写作助手', '代码助手', '英语陪练', '文案策划', '学习导师', '总结提炼', '心理倾听'].forEach(n => assert.ok(list.some(p => p.name === n), n));
  list.forEach(p => { assert.ok(p.builtin && p.emoji && p.systemPrompt.length > 40 && p.id); });
  assert.strictEqual(new Set(list.map(p => p.id)).size, 8);
  assert.strictEqual(P.defaultPrompts().length, 6);
});

test('新建 / 编辑 / 复制 / 删除，并可 JSON 往返存储', () => {
  let list = P.defaultPersonas();
  list = P.upsert(list, { name: '  周报助手 ', emoji: '🧾', systemPrompt: '把工作内容整理成周报', temperature: '5' });
  const mine = list[list.length - 1];
  assert.strictEqual(mine.name, '周报助手');
  assert.strictEqual(mine.temperature, 2);
  assert.ok(mine.id.startsWith('p-'));
  list = P.upsert(list, Object.assign({}, mine, { desc: '每周五用', temperature: '' }));
  assert.strictEqual(list.length, 9);
  assert.strictEqual(list[8].desc, '每周五用');
  assert.strictEqual(list[8].temperature, '');
  list = P.duplicate(list, 'p-coder');
  const idx = list.findIndex(p => p.id === 'p-coder');
  assert.strictEqual(list[idx + 1].name, '代码助手（副本）');
  assert.strictEqual(list[idx + 1].builtin, false);
  assert.notStrictEqual(list[idx + 1].id, 'p-coder');
  list = P.remove(list, 'p-translator');
  const stored = JSON.parse(JSON.stringify(list));
  const merged = P.mergeBuiltins(stored, ['p-translator']);
  assert.ok(!merged.some(p => p.id === 'p-translator'), '用户删除的内置助手不应恢复');
  assert.strictEqual(merged.length, list.length);
  const restored = P.mergeBuiltins(stored, []);
  assert.ok(restored.some(p => p.id === 'p-translator'));
});

test('由助手创建对话：默认服务商/模型/温度与回退', () => {
  const providers = [{ id: 'deepseek', models: ['deepseek-flash', 'deepseek-v4-pro'] }, { id: 'qwen', models: ['qwen-max'] }];
  const fb = { providerId: 'qwen', model: 'qwen-max' };
  const tr = P.defaultPersonas().find(p => p.id === 'p-translator');
  const c1 = P.conversationFromPersona(tr, providers, fb);
  assert.deepStrictEqual([c1.providerId, c1.model, c1.temperature, c1.personaName, c1.personaEmoji], ['qwen', 'qwen-max', 0.3, '翻译官', '🌐']);
  assert.ok(c1.systemPrompt.includes('专业翻译'));
  const c2 = P.conversationFromPersona({ name: 'X', systemPrompt: 's', providerId: 'deepseek', model: '', temperature: '' }, providers, fb);
  assert.deepStrictEqual([c2.providerId, c2.model, c2.temperature], ['deepseek', 'deepseek-flash', undefined]);
  const c3 = P.conversationFromPersona({ name: 'X', systemPrompt: 's', providerId: 'gone', model: 'm' }, providers, fb);
  assert.deepStrictEqual([c3.providerId, c3.model], ['qwen', 'qwen-max'], '服务商未配置时回退到当前');
});

test('提示词插入光标位置', () => {
  assert.deepStrictEqual(P.insertSnippet('', 0, 0, '总结：'), { value: '总结：', cursor: 3 });
  const r = P.insertSnippet('前文后文', 2, 2, 'X');
  assert.deepStrictEqual(r, { value: '前文\nX后文', cursor: 4 });
  assert.strictEqual(P.insertSnippet('abc', 0, 3, 'Z').value, 'Z');
  assert.strictEqual(P.normalizePrompt({ content: '一段很长很长很长很长很长很长的提示词内容' }).title.length, 16);
});
