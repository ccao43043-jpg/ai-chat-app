// 本地资料库：默认分类、CRUD、置顶、关键词检索、按 worldId 隔离
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../app/src/main/assets/www/knowledge.js');

function memStore(seed) {
  const m = Object.assign(Object.create(null), seed || {});
  return {
    get(n, d) { return Object.prototype.hasOwnProperty.call(m, n) ? m[n] : d; },
    set(n, v) { m[n] = typeof v === 'string' ? JSON.parse(v) : v; return true; },
    del(n) { delete m[n]; },
    raw: m,
  };
}

test('默认分类五项', () => {
  const doc = K.emptyDoc('w-a');
  assert.equal(doc.worldId, 'w-a');
  assert.equal(doc.categories.length, 5);
  assert.deepEqual(doc.categories.map(c => c.id), ['housing', 'inventory', 'actions', 'locations', 'other']);
  assert.equal(doc.categories[0].name, '住宅布局');
  assert.equal(doc.categories[1].name, '物品/衣服/车辆');
  assert.equal(doc.categories[2].name, '做过的事');
  assert.equal(doc.categories[3].name, '地点');
  assert.equal(doc.categories[4].name, '其他');
});

test('storeKey 按 worldId', () => {
  assert.equal(K.storeKey('w-1'), 'knowledge_world_w-1.json');
  assert.equal(K.storeKey('abc'), 'knowledge_world_abc.json');
});

test('ensure 写入默认文档；load 读回', () => {
  const st = memStore();
  const doc = K.ensure(st, 'w-x', 1000);
  assert.equal(doc.updatedAt, 1000);
  assert.equal(doc.categories.length, 5);
  assert.ok(st.raw[K.storeKey('w-x')]);
  const again = K.load(st, 'w-x');
  assert.equal(again.worldId, 'w-x');
  assert.equal(again.categories.length, 5);
});

test('分类增删改排序', () => {
  let doc = K.emptyDoc('w-c');
  doc = K.addCategory(doc, { name: '人物关系' }, 10);
  const custom = doc.categories.find(c => c.name === '人物关系');
  assert.ok(custom);
  doc = K.updateCategory(doc, custom.id, { name: '关系网' }, 11);
  assert.equal(K.findCategory(doc, custom.id).name, '关系网');

  const ids = doc.categories.map(c => c.id);
  const last = ids[ids.length - 1];
  const first = ids[0];
  doc = K.reorderCategories(doc, [last, first], 12);
  assert.equal(doc.categories[0].id, last);
  assert.equal(doc.categories[1].id, first);
  assert.equal(doc.categories[0].order, 0);

  doc = K.removeCategory(doc, custom.id, 13);
  assert.equal(doc.categories.find(c => c.id === custom.id), undefined);
});

test('条目 CRUD 与置顶排序', () => {
  let doc = K.emptyDoc('w-e');
  doc = K.addEntry(doc, 'housing', {
    title: '主角别墅',
    content: '一楼客厅',
    keywords: ['别墅', '房间'],
  }, 100);
  const e1 = doc.categories.find(c => c.id === 'housing').entries[0];
  assert.equal(e1.title, '主角别墅');
  assert.deepEqual(e1.keywords, ['别墅', '房间']);
  assert.equal(e1.pinned, false);
  assert.equal(e1.createdAt, 100);

  doc = K.addEntry(doc, 'housing', { title: '旧仓库', content: '杂物', keywords: '仓库' }, 200);
  doc = K.setPinned(doc, 'housing', e1.id, true, 300);
  const listed = K.listEntries(doc, 'housing');
  assert.equal(listed[0].id, e1.id);
  assert.equal(listed[0].pinned, true);

  doc = K.updateEntry(doc, 'housing', e1.id, { title: '别墅（改）', keywords: '别墅，阳台' }, 400);
  const hit = K.findEntry(doc, 'housing', e1.id).entry;
  assert.equal(hit.title, '别墅（改）');
  assert.deepEqual(hit.keywords, ['别墅', '阳台']);
  assert.equal(hit.updatedAt, 400);

  doc = K.removeEntry(doc, 'housing', e1.id, 500);
  assert.equal(K.findEntry(doc, 'housing', e1.id), null);
  assert.equal(K.listEntries(doc, 'housing').length, 1);
});

test('按关键词检索（标题 / 内容 / keywords，置顶加权）', () => {
  let doc = K.emptyDoc('w-s');
  doc = K.addEntry(doc, 'housing', { title: '主角别墅', content: '二楼主卧', keywords: ['别墅', '房间'] }, 1);
  doc = K.addEntry(doc, 'locations', { title: '雨港', content: '靠海的城市', keywords: ['港口'] }, 2);
  doc = K.addEntry(doc, 'inventory', { title: '黑伞', content: '折叠伞', keywords: ['伞'] }, 3);
  const villa = K.findCategory(doc, 'housing').entries[0];
  doc = K.setPinned(doc, 'housing', villa.id, true, 4);

  const r1 = K.search(doc, '别墅');
  assert.ok(r1.length >= 1);
  assert.equal(r1[0].entry.id, villa.id);
  assert.ok(r1[0].score >= 10);

  const r2 = K.search(doc, '港口');
  assert.equal(r2.length, 1);
  assert.equal(r2[0].entry.title, '雨港');

  const r3 = K.search(doc, '主卧');
  assert.equal(r3.length, 1);

  const r4 = K.search(doc, '不存在的词 xyz');
  assert.equal(r4.length, 0);

  // AND：两个 token 都要命中
  const r5 = K.search(doc, '别墅 主卧');
  assert.equal(r5.length, 1);
});

test('按 worldId 隔离存储', () => {
  const st = memStore();
  let a = K.ensure(st, 'w-a', 1);
  a = K.addEntry(a, 'housing', { title: 'A 宅', content: 'only-a', keywords: ['AAA'] }, 2);
  K.save(st, a);

  let b = K.ensure(st, 'w-b', 3);
  b = K.addEntry(b, 'housing', { title: 'B 宅', content: 'only-b', keywords: ['BBB'] }, 4);
  K.save(st, b);

  const la = K.load(st, 'w-a');
  const lb = K.load(st, 'w-b');
  assert.equal(la.categories.find(c => c.id === 'housing').entries.length, 1);
  assert.equal(lb.categories.find(c => c.id === 'housing').entries.length, 1);
  assert.equal(la.categories.find(c => c.id === 'housing').entries[0].title, 'A 宅');
  assert.equal(lb.categories.find(c => c.id === 'housing').entries[0].title, 'B 宅');
  assert.equal(K.search(la, 'BBB').length, 0);
  assert.equal(K.search(lb, 'AAA').length, 0);
  assert.notEqual(K.storeKey('w-a'), K.storeKey('w-b'));
  assert.ok(st.raw[K.storeKey('w-a')]);
  assert.ok(st.raw[K.storeKey('w-b')]);
});

test('normalize：损坏 / 缺字段可恢复', () => {
  const n = K.normalizeDoc({ worldId: 'w-n', categories: [{ id: 'housing', name: '住宅布局', entries: [{ title: 'x' }] }] }, 'w-n');
  assert.equal(n.categories.find(c => c.id === 'housing').entries[0].title, 'x');
  assert.ok(n.categories.find(c => c.id === 'housing').entries[0].id);
  const empty = K.normalizeDoc(null, 'w-z');
  assert.equal(empty.categories.length, 5);
});

test('keywords 字符串拆分', () => {
  assert.deepEqual(K.normalizeKeywords('别墅，房间、车库'), ['别墅', '房间', '车库']);
  assert.deepEqual(K.normalizeKeywords([' a ', '', 'b']), ['a', 'b']);
});
