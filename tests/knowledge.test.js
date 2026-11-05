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

test('detectImportFormat：json / ndjson / markdown', () => {
  assert.equal(K.detectImportFormat('{"worldId":"w","categories":[]}'), 'json');
  assert.equal(K.detectImportFormat('{"categoryId":"housing","title":"别墅","content":"x"}'), 'ndjson');
  assert.equal(K.detectImportFormat('{"categoryId":"housing","title":"a","content":"1"}\n{"categoryId":"housing","title":"b","content":"2"}\n'), 'ndjson');
  assert.equal(K.detectImportFormat('## housing 住宅布局\n### 主角别墅\n\n一楼\n'), 'markdown');
  assert.equal(K.detectImportFormat(''), 'empty');
});

test('parseImport + mergeDoc：原生 JSON 合并同 id 覆盖', () => {
  let doc = K.emptyDoc('w-imp');
  doc = K.addEntry(doc, 'housing', { id: 'e-keep', title: '旧别墅', content: '旧', keywords: ['旧'] }, 10);
  doc = K.addEntry(doc, 'housing', { id: 'e-other', title: '仓库', content: '杂', keywords: [] }, 11);

  const raw = K.exportJSON({
    worldId: 'w-imp',
    updatedAt: 1,
    categories: [{
      id: 'housing', name: '住宅布局', order: 0,
      entries: [
        { id: 'e-keep', title: '新别墅', content: '新内容', keywords: ['别墅'], pinned: true },
        { id: 'e-new', title: '花园', content: '南侧', keywords: ['花园'] },
      ],
    }],
  });
  const parsed = K.parseImport(raw);
  assert.equal(parsed.format, 'json');
  const r = K.mergeDoc(doc, parsed, { mode: 'merge', worldId: 'w-imp', now: 100 });
  assert.equal(r.updated, 1);
  assert.equal(r.added, 1);
  const housing = K.findCategory(r.doc, 'housing');
  const keep = housing.entries.find(e => e.id === 'e-keep');
  assert.equal(keep.title, '新别墅');
  assert.equal(keep.content, '新内容');
  assert.equal(keep.pinned, true);
  assert.ok(housing.entries.find(e => e.id === 'e-new'));
  assert.ok(housing.entries.find(e => e.id === 'e-other'));
});

test('parseImport + mergeDoc：NDJSON 合并与替换', () => {
  let doc = K.emptyDoc('w-nd');
  doc = K.addEntry(doc, 'housing', { id: 'e1', title: '旧', content: 'c0', keywords: [] }, 1);

  const nd = [
    '{"categoryId":"housing","id":"e1","title":"别墅","content":"一楼","keywords":["别墅","车库"]}',
    '{"categoryId":"locations","title":"雨港","content":"靠海","keywords":"港口,码头","pinned":true}',
    '{"category":"inventory","title":"黑伞","content":"折叠伞"}',
  ].join('\n');
  assert.equal(K.detectImportFormat(nd), 'ndjson');
  const parsed = K.parseImport(nd);
  assert.equal(parsed.format, 'ndjson');
  assert.equal(parsed.entries.length, 3);

  const merged = K.mergeDoc(doc, parsed, { mode: 'merge', worldId: 'w-nd', now: 50 });
  assert.equal(merged.updated, 1);
  assert.equal(merged.added, 2);
  assert.equal(K.findEntry(merged.doc, 'housing', 'e1').entry.title, '别墅');
  assert.deepEqual(K.findEntry(merged.doc, 'housing', 'e1').entry.keywords, ['别墅', '车库']);
  assert.equal(K.findCategory(merged.doc, 'locations').entries.length, 1);
  assert.equal(K.findCategory(merged.doc, 'locations').entries[0].pinned, true);
  assert.equal(K.findCategory(merged.doc, 'inventory').entries[0].title, '黑伞');

  const replaced = K.mergeDoc(merged.doc, parsed, { mode: 'replace', worldId: 'w-nd', now: 60 });
  // replace 清空后重新导入 3 条
  const total = replaced.doc.categories.reduce((n, c) => n + c.entries.length, 0);
  assert.equal(total, 3);
  assert.equal(replaced.added, 3);
});

test('parseImport + mergeDoc：紧凑 Markdown', () => {
  const md = [
    '## housing 住宅布局',
    '### 主角别墅',
    'keywords: 别墅, 房间, 车库',
    'pinned: true',
    '',
    '一楼客厅很大。',
    '二楼主卧朝南。',
    '',
    '## mystery-zone 未知区',
    '### 秘密基地',
    'keywords: 基地',
    '',
    '藏在山里。',
    '',
  ].join('\n');
  assert.equal(K.detectImportFormat(md), 'markdown');
  const parsed = K.parseImport(md);
  assert.equal(parsed.format, 'markdown');
  assert.equal(parsed.entries.length, 2);
  const r = K.mergeDoc(K.emptyDoc('w-md'), parsed, { mode: 'merge', worldId: 'w-md', now: 7 });
  const villa = K.findCategory(r.doc, 'housing').entries[0];
  assert.equal(villa.title, '主角别墅');
  assert.equal(villa.pinned, true);
  assert.deepEqual(villa.keywords, ['别墅', '房间', '车库']);
  assert.match(villa.content, /一楼客厅/);
  assert.match(villa.content, /二楼主卧/);
  const mystery = K.findCategory(r.doc, 'mystery-zone');
  assert.ok(mystery);
  assert.equal(mystery.name, '未知区');
  assert.equal(mystery.entries[0].title, '秘密基地');
});

test('exportJSON / exportNdjson / exportMarkdown 往返', () => {
  let doc = K.emptyDoc('w-ex');
  doc = K.addEntry(doc, 'housing', {
    id: 'e-a', title: '别墅', content: '一楼\n二楼', keywords: ['别墅'], tags: ['家'], pinned: true,
  }, 1);
  doc = K.addEntry(doc, 'locations', { id: 'e-b', title: '雨港', content: '靠海', keywords: ['港'] }, 2);

  const json = K.exportJSON(doc);
  const backJ = K.mergeDoc(K.emptyDoc('w-ex'), K.parseImport(json), { mode: 'replace', worldId: 'w-ex', now: 9 });
  assert.equal(K.findEntry(backJ.doc, 'housing', 'e-a').entry.title, '别墅');

  const nd = K.exportNdjson(doc);
  assert.ok(nd.split('\n').filter(Boolean).length >= 2);
  const backN = K.mergeDoc(K.emptyDoc('w-ex'), K.parseImport(nd), { mode: 'replace', worldId: 'w-ex', now: 10 });
  assert.equal(backN.added, 2);

  const md = K.exportMarkdown(doc);
  assert.match(md, /## housing/);
  assert.match(md, /### 别墅/);
  const backM = K.mergeDoc(K.emptyDoc('w-ex'), K.parseImport(md), { mode: 'replace', worldId: 'w-ex', now: 11 });
  assert.equal(backM.added, 2);
  assert.equal(K.findCategory(backM.doc, 'housing').entries[0].pinned, true);
});

test('未知 category 无名称时归 other', () => {
  const nd = '{"categoryId":"no-such-cat","title":"x","content":"y"}';
  const r = K.mergeDoc(K.emptyDoc('w-o'), K.parseImport(nd), { mode: 'merge', worldId: 'w-o', now: 1 });
  // no-such-cat 像 id（含横线），ensureCategory 会自动建；再测纯中文归类
  const nd2 = '{"category":"只是中文类名","title":"z","content":"w"}';
  const r2 = K.mergeDoc(K.emptyDoc('w-o2'), K.parseImport(nd2), { mode: 'merge', worldId: 'w-o2', now: 2 });
  const created = r2.doc.categories.find(c => c.name === '只是中文类名' || c.entries.some(e => e.title === 'z'));
  assert.ok(created);
  assert.equal(created.entries[0].title, 'z');
});
