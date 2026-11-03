// 插件框架：注册、全局/对话开关、钩子顺序与错误隔离
const test = require('node:test');
const assert = require('node:assert');
const Plugins = require('../app/src/main/assets/www/plugins.js');

function mk() {
  const reg = Plugins.createRegistry();
  const order = [];
  reg.register({ id: 'a', name: 'A', defaultEnabled: true, hooks: {
    onBeforeRequest(ctx) { order.push('a'); ctx.systemPrompt = (ctx.systemPrompt || '') + '[A]'; return ctx; },
    onResponseUsage(u) { order.push('usage-a:' + u.prompt); },
    onAfterResponse(r) { order.push('after-a:' + r.ok); },
    messageBadges: () => [{ text: 'A', tone: 'ok' }],
  } });
  reg.register({ id: 'boom', name: 'Boom', defaultEnabled: true, hooks: {
    onBeforeRequest(ctx) { ctx.systemPrompt = 'BROKEN'; ctx.messages.length = 0; throw new Error('炸了'); },
    messageBadges: () => { throw new Error('x'); },
  } });
  reg.register({ id: 'b', name: 'B', defaultEnabled: true, hooks: {
    onBeforeRequest(ctx) { order.push('b'); ctx.messages.push({ role: 'user', content: 'B' }); },
  } });
  reg.register({ id: 'conv', name: 'PerConv', defaultEnabled: true, perConversation: true, hooks: {
    async onBeforeRequest(ctx) { await new Promise(r => setTimeout(r, 5)); order.push('conv'); ctx.meta.conv = 1; },
  } });
  return { reg, order };
}

test('注册：id 必填且唯一', () => {
  const reg = Plugins.createRegistry();
  reg.register({ id: 'x', name: 'X' });
  assert.throws(() => reg.register({ id: 'x', name: 'X2' }));
  assert.throws(() => reg.register({ name: 'no id' }));
  assert.strictEqual(reg.get('x').version, '1.0.0');
});

test('全局开关与对话开关', () => {
  const { reg } = mk();
  const settings = {}; const conv = {};
  assert.ok(reg.isActive('a', settings, conv));
  assert.ok(!reg.isActive('conv', settings, conv), '对话级插件默认不在对话中开启');
  reg.setForConversation(conv, 'conv', true);
  assert.ok(reg.isActive('conv', settings, conv));
  reg.setGlobal(settings, 'conv', false);
  assert.ok(!reg.isActive('conv', settings, conv), '全局关闭优先');
  reg.setForConversation(conv, 'a', false);
  assert.ok(!reg.isActive('a', settings, conv), '全局插件可在对话中单独关闭');
  assert.deepStrictEqual(reg.active(settings, conv).map(p => p.id), ['boom', 'b']);
});

test('onBeforeRequest：按注册顺序执行（支持 async），出错的插件修改被丢弃', async () => {
  const { reg, order } = mk();
  const conv = { plugins: { conv: { enabled: true } } };
  const ctx = { conv, settings: {}, systemPrompt: 'S', messages: [{ role: 'user', content: 'hi' }], opts: {} };
  const out = await reg.runBeforeRequest(ctx, {});
  assert.deepStrictEqual(order, ['a', 'b', 'conv']);
  assert.strictEqual(out.systemPrompt, 'S[A]');
  assert.deepStrictEqual(out.messages.map(m => m.content), ['hi', 'B']);
  assert.strictEqual(out.meta.conv, 1);
  assert.deepStrictEqual(out.plugins, ['a', 'boom', 'b', 'conv']);
  assert.strictEqual(ctx.messages.length, 1, '原始 ctx 的消息数组不被修改');
  assert.strictEqual(reg.errors[0].plugin, 'boom');
});

test('没有生效插件时请求不变', async () => {
  const { reg } = mk();
  const settings = {}; ['a', 'boom', 'b', 'conv'].forEach(id => reg.setGlobal(settings, id, false));
  const ctx = { conv: {}, settings, systemPrompt: 'S', messages: [{ role: 'user', content: 'hi' }], opts: { stream: true } };
  const out = await reg.runBeforeRequest(ctx, {});
  assert.strictEqual(out, ctx);
  assert.strictEqual(out.systemPrompt, 'S');
  assert.deepStrictEqual(out.plugins, []);
});

test('onResponseUsage / onAfterResponse / 徽章错误隔离', () => {
  const { reg, order } = mk();
  const ctx = { conv: {}, settings: {} };
  reg.runAfterResponse(ctx, { ok: true, usage: { prompt: 10 } }, {});
  assert.deepStrictEqual(order, ['usage-a:10', 'after-a:true']);
  const b = reg.messageBadges({ role: 'assistant' }, {}, {}, {});
  assert.deepStrictEqual(b, [{ plugin: 'a', text: 'A', tone: 'ok' }]);
});

test('v0.8.9 errors 上限 50 + 连续重复去重', () => {
  const reg = Plugins.createRegistry();
  let n = 0;
  reg.register({ id: 'bad', name: 'bad', defaultEnabled: true, hooks: { messageBadges: () => { throw new Error('e' + (n++ % 2 ? '' : n)); } } });
  for (let i = 0; i < 300; i++) reg.messageBadges({ role: 'assistant' }, {}, {}, {});
  assert.strictEqual(reg.errors.length, 50);
  const reg2 = Plugins.createRegistry();
  reg2.register({ id: 'bad', name: 'bad', defaultEnabled: true, hooks: { messageBadges: () => { throw new Error('same'); } } });
  for (let i = 0; i < 30; i++) reg2.messageBadges({ role: 'assistant' }, {}, {}, {});
  assert.strictEqual(reg2.errors.length, 1);
  assert.strictEqual(reg2.errors[0].count, 30);
});
