// 回复版本 / 对话分支：新增、切换（含后续分支）、删除、只保留、迁移、持久化
const test = require('node:test');
const assert = require('node:assert');
const V = require('../app/src/main/assets/www/versions.js');

const mk = () => [
  { id: 'u1', role: 'user', content: '问题一' },
  { id: 'a1', role: 'assistant', content: '回答一', model: 'm1', usage: { prompt: 10, completion: 5 }, sources: [{ url: 'https://x' }] },
  { id: 'u2', role: 'user', content: '问题二' },
  { id: 'a2', role: 'assistant', content: '回答二', model: 'm1' },
];
const texts = msgs => msgs.map(m => m.content);

test('迁移：旧消息视为单版本', () => {
  const msgs = mk();
  assert.strictEqual(V.count(msgs[1]), 1); assert.strictEqual(V.index(msgs[1]), 0);
  const c = V.normalizeConv({ messages: msgs });
  assert.ok(!('versions' in c.messages[1]));
  const bad = { id: 'x', role: 'assistant', content: 'c', versions: [null], vi: 3 };
  V.normalizeMsg(bad); assert.ok(!('versions' in bad) && !('vi' in bad), '只有 1 个版本时去掉字段');
  const out = { id: 'y', role: 'assistant', content: 'c', versions: [{ content: 'old' }, { content: 'stale' }], vi: 9 };
  V.normalizeMsg(out); assert.strictEqual(out.vi, 1); assert.strictEqual(out.versions[1], null); assert.deepStrictEqual(out.versions[0].tail, []);
});

test('重新生成最后一条回复：保留旧版本，切换无副作用，每个版本保留自己的字段', () => {
  let msgs = mk();
  msgs = V.addVersion(msgs, 3, { content: '回答二（第二版）', model: 'm2', usage: { prompt: 20, completion: 7 } });
  assert.strictEqual(msgs.length, 4); assert.strictEqual(V.count(msgs[3]), 2); assert.strictEqual(V.index(msgs[3]), 1);
  assert.strictEqual(msgs[3].id, 'a2', '同一个消息位置');
  msgs = V.select(msgs, 3, 0);
  assert.deepStrictEqual(texts(msgs), ['问题一', '回答一', '问题二', '回答二']);
  assert.strictEqual(msgs[3].model, 'm1'); assert.ok(!('usage' in msgs[3]), '旧版本没有用量');
  msgs = V.select(msgs, 3, 1);
  assert.strictEqual(msgs[3].content, '回答二（第二版）'); assert.strictEqual(msgs[3].model, 'm2'); assert.deepStrictEqual(msgs[3].usage, { prompt: 20, completion: 7 });
  assert.strictEqual(msgs[3].versions[1], null, '当前版本的数据在消息本身');
  assert.strictEqual(V.select(msgs, 3, 1), msgs, '选当前版本不变');
  assert.strictEqual(V.select(msgs, 3, 5), msgs, '越界不变');
});

test('较早回复：新版本开新分支，切换时后续对话随之切换（树状分支）', () => {
  let msgs = mk();
  msgs = V.addVersion(msgs, 1, { content: '回答一（B）' });
  assert.deepStrictEqual(texts(msgs), ['问题一', '回答一（B）'], '后面的对话留在旧分支');
  msgs.push({ id: 'u3', role: 'user', content: 'B 分支的问题' }, { id: 'a3', role: 'assistant', content: 'B 分支的回答' });
  msgs = V.select(msgs, 1, 0);
  assert.deepStrictEqual(texts(msgs), ['问题一', '回答一', '问题二', '回答二']);
  assert.deepStrictEqual(msgs[1].sources, [{ url: 'https://x' }], '引用随版本恢复');
  msgs = V.select(msgs, 1, 1);
  assert.deepStrictEqual(texts(msgs), ['问题一', '回答一（B）', 'B 分支的问题', 'B 分支的回答']);
  // 分支里再分支（嵌套）
  msgs = V.addVersion(msgs, 3, { content: 'B 分支的回答（2）' });
  msgs = V.select(msgs, 1, 0); msgs = V.select(msgs, 1, 1);
  assert.deepStrictEqual(texts(msgs), ['问题一', '回答一（B）', 'B 分支的问题', 'B 分支的回答（2）']);
  msgs = V.select(msgs, 3, 0);
  assert.strictEqual(msgs[3].content, 'B 分支的回答');
  assert.strictEqual(V.tailLength(msgs, 1, 0), 2); assert.strictEqual(V.tailLength(msgs, 1, 1), 2);
});

test('编辑并重发用户消息：用户消息也有版本（分支），保留各自的附件和 RP 冻结原文', () => {
  let msgs = mk(); msgs[2].rpSent = '【搜索】问题二'; msgs[2].images = ['data:a'];
  msgs = V.addVersion(msgs, 2, { content: '问题二（改）', images: ['data:a'] });
  assert.deepStrictEqual(texts(msgs), ['问题一', '回答一', '问题二（改）']);
  assert.ok(!('rpSent' in msgs[2]), '新版本没有冻结原文');
  msgs.push({ id: 'a9', role: 'assistant', content: '新回答' });
  msgs = V.select(msgs, 2, 0);
  assert.strictEqual(msgs[2].rpSent, '【搜索】问题二'); assert.deepStrictEqual(texts(msgs).slice(2), ['问题二', '回答二']);
});

test('删除版本 / 只保留当前版本', () => {
  let msgs = mk();
  msgs = V.addVersion(msgs, 3, { content: 'v2' });
  msgs = V.addVersion(msgs, 3, { content: 'v3' });
  assert.strictEqual(V.count(msgs[3]), 3);
  msgs = V.removeVersion(msgs, 3, 0); // 删除非当前
  assert.strictEqual(V.count(msgs[3]), 2); assert.strictEqual(V.index(msgs[3]), 1); assert.strictEqual(msgs[3].content, 'v3');
  msgs = V.removeVersion(msgs, 3, 1); // 删除当前 → 切到相邻并收起
  assert.strictEqual(V.count(msgs[3]), 1); assert.strictEqual(msgs[3].content, 'v2'); assert.ok(!('versions' in msgs[3]));
  // 删除当前版本时连同它的分支
  msgs = mk(); msgs = V.addVersion(msgs, 1, { content: 'B' }); msgs.push({ id: 'z', role: 'user', content: 'B 后续' });
  msgs = V.removeVersion(msgs, 1, 1);
  assert.deepStrictEqual(texts(msgs), ['问题一', '回答一', '问题二', '回答二']);
  // 只保留
  msgs = V.addVersion(msgs, 3, { content: '新' });
  msgs = V.keepOnly(msgs, 3);
  assert.ok(!('versions' in msgs[3])); assert.strictEqual(msgs[3].content, '新');
});

test('持久化：JSON 往返后仍可切换', () => {
  let msgs = mk();
  msgs = V.addVersion(msgs, 1, { content: 'B' }); msgs.push({ id: 'u5', role: 'user', content: 'B 的后续' });
  const back = V.normalizeConv(JSON.parse(JSON.stringify({ messages: msgs }))).messages;
  assert.deepStrictEqual(texts(back), ['问题一', 'B', 'B 的后续']);
  const r = V.select(back, 1, 0);
  assert.deepStrictEqual(texts(r), ['问题一', '回答一', '问题二', '回答二']);
  assert.ok(!JSON.stringify(r[3]).includes('"versions"'));
});
